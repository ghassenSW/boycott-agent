import { config } from './config.js';
import { UpstreamError } from './errors.js';
import { spend, tavilyCost, RESOURCES } from './budget.js';

// Codes that mean "try me again" rather than "your request is wrong":
// 408 timeout, 425 too early, 429 rate limited, 500/502/503/504 server/gateway.
// Gemini's free tier returns 503 "UNAVAILABLE" when it's congested — the single
// most common failure in this project.
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

async function postJson(
  url,
  body,
  { headers = {}, timeoutMs = 60_000, label = url, maxAttempts = MAX_ATTEMPTS } = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
      lastErr = new UpstreamError(`${label} request failed: ${reason}`);
      // Network drops / timeouts are worth retrying.
      if (attempt < maxAttempts) {
        await sleep(backoff(attempt));
        continue;
      }
      throw lastErr;
    }
    clearTimeout(timer);

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (res.ok) return json;

    lastErr = new UpstreamError(
      `${label} returned ${res.status}${attempt > 1 ? ` after ${attempt} tries` : ''}: ${text.slice(0, 300)}`,
      { body: json }
    );
    lastErr.upstreamStatus = res.status;
    if (!RETRYABLE.has(res.status) || attempt === maxAttempts) throw lastErr;

    // Honour Retry-After if the server sent one (seconds, or an HTTP date).
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const waitMs = retryAfter ?? backoff(attempt);
    console.warn(`[retry] ${label} ${res.status}, waiting ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
    await sleep(waitMs);
  }
  throw lastErr;
}

// Exponential backoff with jitter: ~1s, ~2s, ~4s. Short enough to feel instant
// in Postman, long enough to usually clear a transient free-tier spike.
function backoff(attempt) {
  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 400);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 10_000));
  return null;
}

/** Tavily web search — Agent 1's eyes. Paid from the global budget before it runs. */
export async function tavilySearch(searchQuery, overrides = {}) {
  const body = {
    query: searchQuery,
    search_depth: config.tavily.searchDepth,
    topic: 'news',
    days: 365,
    max_results: 8,
    include_answer: false,
    ...overrides,
  };
  await spend(RESOURCES.TAVILY, tavilyCost(body.search_depth));
  return postJson('https://api.tavily.com/search', body, {
    headers: { Authorization: `Bearer ${config.tavily.apiKey}` },
    label: 'Tavily search',
  });
}

/** Tavily page extraction — Agent 2's eyes. Paid from the global budget before it runs. */
export async function tavilyExtract(url, depth = config.tavily.extractDepth) {
  await spend(RESOURCES.TAVILY, tavilyCost(depth));
  return postJson(
    'https://api.tavily.com/extract',
    { urls: [url], extract_depth: depth },
    { headers: { Authorization: `Bearer ${config.tavily.apiKey}` }, label: 'Tavily extract' }
  );
}

/**
 * OpenAI-compatible chat completion that must return a JSON object.
 * Works with Gemini's compatibility endpoint, OpenAI, OpenRouter, Groq, local Ollama…
 */
// A model that just failed is skipped for a while, so every request doesn't
// re-pay ~3s per congested model before reaching one that works.
const COOLDOWN_MS = 2 * 60_000;
const cooldownUntil = new Map();

function modelsInOrder(models = config.llm.models) {
  const now = Date.now();
  const ready = models.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
  const cooling = models.filter((m) => (cooldownUntil.get(m) ?? 0) > now);
  // If everything is cooling down, still try them all rather than fail outright.
  return [...ready, ...cooling];
}

// At most config.llm.maxConcurrency model calls in flight; the rest wait in line.
let running = 0;
const waiting = [];
async function withLlmSlot(fn) {
  if (running >= config.llm.maxConcurrency) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export async function llmJson(prompt, options) {
  // One unit per question asked, however many fallback models it takes to answer.
  await spend(RESOURCES.LLM, 1);
  return withLlmSlot(() => callLlm(prompt, options));
}

async function callLlm({ system, user }, { models } = {}) {
  // Each free-tier model has its own capacity pool. When the preferred one is
  // congested (503), rate-limited (429) or retired (404), move down the list
  // instead of hammering it — a lighter model that answers beats a perfect one that won't.
  const SWITCH_ON = new Set([404, 408, 429, 500, 502, 503, 504]);
  let res;
  let lastErr;
  const chain = models?.length ? models : config.llm.models;
  for (const model of modelsInOrder(chain)) {
    try {
      res = await postJson(
        `${config.llm.baseUrl}/chat/completions`,
        {
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        {
          headers: { Authorization: `Bearer ${config.llm.apiKey}` },
          timeoutMs: 120_000,
          label: `LLM ${model}`,
          maxAttempts: 2,
        }
      );
      cooldownUntil.delete(model);
      if (model !== config.llm.models[0]) console.warn(`[llm] answered by fallback model ${model}`);
      break;
    } catch (err) {
      lastErr = err;
      // 400/401/403 mean our request or key is wrong — another model won't fix that.
      if (err.upstreamStatus && !SWITCH_ON.has(err.upstreamStatus)) throw err;
      cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      console.warn(`[llm] ${model} unavailable (${err.upstreamStatus ?? 'network'}), skipping it for 2 min`);
    }
  }
  if (!res) {
    throw new UpstreamError(
      `All configured LLM models are unavailable right now (${chain.join(', ')}). Last error: ${lastErr?.message}`
    );
  }

  const content = res?.choices?.[0]?.message?.content ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some models wrap the object in prose or code fences — salvage the first {...}.
    const match = String(content).match(/\{[\s\S]*\}/);
    try {
      parsed = JSON.parse(match ? match[0] : '{}');
    } catch {
      parsed = {};
    }
  }
  // Some models wrap the object in an array: [ { ... } ].
  if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === 'object') parsed = parsed[0];
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
