// Agent 1 — Boycott Check.
// Given a brand name, searches the live web and reports whether it faces a consumer
// boycott now. The model only labels each search result (is it about a boycott of
// THIS brand? happening now or in the past?). The status and the confidence number
// are computed here, in code, from those labels.

import { config } from '../config.js';
import { query, isFresh } from '../db.js';
import { tavilySearch, llmJson } from '../clients.js';
import { BadRequest, UpstreamError } from '../errors.js';
import { classifyDomain, domainOf } from '../domains.js';
import { ensureAvailable } from '../budget.js';

// Overrides on top of tavilySearch's defaults (advanced news search, last 365 days, 8 results).
// Exported so the eval snapshots search exactly like the API does.
export const SEARCH_OPTIONS = {};

/**
 * "McDonald's", "McDonalds", "MCDONALD’S" -> "mcdonalds"; "Coca-Cola", "coca cola" -> "cocacola".
 * Only letters and digits survive, so spelling variants share one stored answer.
 */
export function brandKey(brand) {
  return brand
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeInput(body = {}) {
  const brand = String(body.brand ?? '').trim();
  if (!brand) throw new BadRequest('Missing "brand". Send JSON: { "brand": "Nike" }');
  const brand_normalized = brandKey(brand);
  if (!brand_normalized) throw new BadRequest('"brand" must contain letters or digits.');

  const year = new Date().getFullYear();
  return {
    brand,
    brand_normalized,
    searchQuery: `${brand} boycott campaign ${year} why boycotting reason`,
  };
}

const UNREADABLE =
  /(Log ?In Sign ?Up|Never miss a post from|Sign up for Instagram|By continuing, you agree to|exhibiting automated behavio|verify you are (a )?human|enable JavaScript and cookies|Access denied)/i;

// ---------------------------------------------------------------- the model

function buildPrompt(ctx, results, today) {
  const sourceList = results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\nDate: ${r.published_date || 'unknown'}\n${r.content}`)
    .join('\n\n');

  const system = [
    'You are a neutral research assistant checking whether a brand is the TARGET of a consumer boycott.',
    'You only label search results. Use ONLY the text of each result, never prior knowledge.',
    'For each result, first decide the role this brand plays in it:',
    '- "boycott_target": people call for, or carry out, a boycott OF THIS BRAND (or of the brand\'s local franchise).',
    '- "boycotter": this brand is the one boycotting something else (e.g. advertisers pulling ads from a platform).',
    '- "claim_debunked": the result says a boycott of this brand is false or a hoax.',
    '- "mentioned_only": the brand appears, but no boycott of it is described.',
    '- "not_mentioned": the result is about something else (including a DIFFERENT brand\'s boycott).',
    'Complaints, criticism, bad reviews, one customer deciding not to buy, or falling sales are NOT a boycott unless the text explicitly describes a boycott (or a call not to buy) aimed at this brand. Use "mentioned_only" for those.',
    'Then, only for "boycott_target", say when:',
    '- "current": the boycott is described as ongoing, or the call was made within roughly the last 6 months before today.',
    '- "past": the result looks back at a boycott that happened earlier (e.g. "in 2023", "years ago"), even if the article itself is recent.',
    '- "unclear": you cannot tell from the text.',
    'Stay neutral and take no side. Respond with ONLY a JSON object.',
  ].join('\n');

  const user = [
    `Brand: ${ctx.brand}`,
    `Today's date: ${today}`,
    '',
    'Search results:',
    sourceList || '(no results returned)',
    '',
    'Return a JSON object with exactly these fields:',
    '{',
    '  "labels": [',
    '    { "result": 1, "brand_role": "boycott_target" | "boycotter" | "claim_debunked" | "mentioned_only" | "not_mentioned", "timing": "current" | "past" | "unclear", "cause": "short cause, or empty" }',
    '    // one entry per search result, in order',
    '  ],',
    '  "reason": "one or two neutral sentences on why people boycott this brand NOW, based only on the results you marked current. If only past boycotts appear, say so briefly. Empty if none.",',
    '  "who_is_calling": "who is calling for the current boycott, or empty"',
    '}',
  ].join('\n');

  return { system, user };
}

// ---------------------------------------------------------------- scoring (all in code)

// How much one result counts as evidence. Social posts and blogs show that a call
// exists, but one post is not a campaign.
const TIER_WEIGHT = { official: 1, major_news: 1, ngo: 1, advocacy: 1, unknown: 1, reference: 0.5, blog: 0.5, social: 0.5 };

// "active_boycott" needs this much weighted current evidence AND this many independent
// non-social sites saying so. Social posts alone can make a case "unclear", never "active".
const ACTIVE_AT = 2;
const ACTIVE_MIN_SITES = 2;

function scoreAndAssemble(ctx, results, parsed, now) {
  const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
  // An unusable model answer must surface as an error, never as "no boycott found".
  if (results.length && !labels.length) {
    throw new UpstreamError('The language model returned an unusable answer. Please retry in a moment.');
  }
  const byIndex = new Map();
  for (const l of labels) {
    const i = Number(l?.result);
    if (Number.isInteger(i) && i >= 1 && i <= results.length && !byIndex.has(i)) byIndex.set(i, l);
  }

  const judged = results.map((r, idx) => {
    const l = byIndex.get(idx + 1) ?? {};
    const relevant = l.brand_role === 'boycott_target';
    const timing = ['current', 'past', 'unclear'].includes(l.timing) ? l.timing : 'unclear';
    const domain = domainOf(r.url);
    const { domain_tier } = classifyDomain(domain);
    const ageDays = r.published_date ? (now - new Date(r.published_date).getTime()) / 86_400_000 : null;
    return { ...r, relevant, timing, domain, domain_tier, weight: TIER_WEIGHT[domain_tier] ?? 1, ageDays };
  });

  const relevant = judged.filter((j) => j.relevant);
  const current = relevant.filter((j) => j.timing === 'current');
  const unclearTiming = relevant.filter((j) => j.timing === 'unclear');
  const evidence = current.reduce((n, j) => n + j.weight, 0);

  const strongSites = new Set(current.filter((j) => j.weight >= 1).map((j) => j.domain)).size;

  // --- status: decided by counting, not by the model ---
  let status;
  if (evidence >= ACTIVE_AT && strongSites >= ACTIVE_MIN_SITES) status = 'active_boycott';
  else if (evidence > 0 || unclearTiming.length > 0) status = 'unclear';
  else status = 'no_evidence';

  // --- confidence that an active boycott exists (0-100) ---
  const evidenceScore = (Math.min(evidence, 5) / 5) * 60; // up to 60: how much current evidence
  const ages = current.map((j) => j.ageDays).filter((d) => Number.isFinite(d) && d >= 0);
  const newestDays = ages.length ? Math.min(...ages) : null;
  let recencyScore = 0; // up to 25: how fresh the newest current source is
  if (current.length) {
    if (newestDays === null) recencyScore = 5;
    else if (newestDays <= 30) recencyScore = 25;
    else if (newestDays <= 90) recencyScore = 18;
    else if (newestDays <= 180) recencyScore = 10;
    else recencyScore = 4;
  }
  const domains = new Set(current.map((j) => j.domain)).size;
  const diversityScore = (Math.min(domains, 4) / 4) * 15; // up to 15: independent sites, not one site repeated

  // Bands keep the number consistent with the status, so a site can show both:
  // no_evidence 0-10, unclear up to 45, active_boycott 50-100.
  let confidence = Math.round(evidenceScore + recencyScore + diversityScore);
  if (status === 'active_boycott') confidence = Math.max(confidence, 50);
  if (status === 'unclear') confidence = Math.min(confidence, 45);
  if (status === 'no_evidence') confidence = Math.min(confidence, 10);
  confidence = Math.max(0, Math.min(100, confidence));

  // Only results actually about a boycott of this brand are shown, current ones first.
  const order = { current: 0, unclear: 1, past: 2 };
  const sources = relevant
    .sort((a, b) => order[a.timing] - order[b.timing])
    .slice(0, 8)
    .map((j) => ({ title: j.title, url: j.url, date: j.published_date, timing: j.timing }));

  const recency = newestDays !== null ? `newest current source ~${Math.round(newestDays)} days old` : 'no dated current source';
  const notes =
    `Of ${results.length} search results, ${relevant.length} are about a boycott of ${ctx.brand}: ` +
    `${current.length} current, ${relevant.length - current.length - unclearTiming.length} past, ${unclearTiming.length} unclear. ` +
    `Weighted current evidence ${evidence} from ${strongSites} independent non-social site(s) ` +
    `(social posts and blogs count half; "active_boycott" needs ${ACTIVE_AT} and ${ACTIVE_MIN_SITES} sites). ` +
    'Confidence = how strongly the evidence shows an active boycott exists, not how many people take part.';

  return {
    brand: ctx.brand,
    brand_normalized: ctx.brand_normalized,
    status,
    confidence,
    reason: status === 'no_evidence' && !relevant.length ? '' : String(parsed.reason ?? '').slice(0, 600),
    who_is_calling: current.length ? String(parsed.who_is_calling ?? '').slice(0, 300) : '',
    recency,
    sources,
    notes,
    checked_at: new Date(now).toISOString(),
    served_from: 'live',
  };
}

// ---------------------------------------------------------------- storage

const UPSERT_SQL = `
INSERT INTO brand_boycott_status
  (brand_name, brand_normalized, status, confidence, reason, who_is_calling, recency, sources, notes, last_checked, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
ON CONFLICT (brand_normalized) DO UPDATE SET
  brand_name = EXCLUDED.brand_name,
  status = EXCLUDED.status,
  confidence = EXCLUDED.confidence,
  reason = EXCLUDED.reason,
  who_is_calling = EXCLUDED.who_is_calling,
  recency = EXCLUDED.recency,
  sources = EXCLUDED.sources,
  notes = EXCLUDED.notes,
  last_checked = EXCLUDED.last_checked,
  updated_at = now()
`;

async function save(r) {
  await query(UPSERT_SQL, [
    r.brand, r.brand_normalized, r.status, r.confidence, r.reason,
    r.who_is_calling, r.recency, JSON.stringify(r.sources), r.notes, r.checked_at,
  ]);
}

// ---------------------------------------------------------------- public

/**
 * Full pipeline. Returns the complete record; use `slim()` for the API response.
 * The options exist for the eval (eval/run-brands.js): saved searches, a fixed
 * "today", pinned model, no cache read or write.
 */
export async function boycottCheck(
  body,
  {
    useCache = true,
    save: persist = true,
    search = (q) => tavilySearch(q, SEARCH_OPTIONS),
    models,
    now = new Date(),
  } = {}
) {
  const ctx = normalizeInput(body);

  // 1. Cache
  const { rows } = useCache
    ? await query('SELECT * FROM brand_boycott_status WHERE brand_normalized = $1 LIMIT 1', [ctx.brand_normalized])
    : { rows: [] };
  const cached = rows[0];
  if (cached && isFresh(cached.last_checked, config.freshness.brandDays)) {
    return {
      brand: cached.brand_name,
      brand_normalized: cached.brand_normalized,
      status: cached.status,
      confidence: cached.confidence,
      reason: cached.reason ?? '',
      who_is_calling: cached.who_is_calling ?? '',
      recency: cached.recency ?? '',
      sources: cached.sources ?? [],
      notes: cached.notes ?? '',
      checked_at: cached.last_checked,
      served_from: 'cache',
    };
  }

  // 2. Live search — the only thing the model is allowed to read.
  // Check the model budget first, so a search is never paid for when it can't be judged.
  await ensureAvailable({ llm: 1 });
  const tavily = await search(ctx.searchQuery);
  const results = (tavily.results ?? [])
    .map((r) => ({
      title: r.title,
      url: r.url,
      content: String(r.content ?? '').slice(0, 800),
      published_date: r.published_date ?? null,
    }))
    // A login wall or an anti-bot page has nothing to judge, and must never be shown as a source.
    .filter((r) => !UNREADABLE.test(r.content) && r.content.replace(/\s+/g, ' ').trim().length >= 40);

  // 3. Label each result, then 4. decide and score in code.
  const nowMs = new Date(now).getTime();
  const parsed = results.length
    ? await llmJson(buildPrompt(ctx, results, new Date(nowMs).toISOString().slice(0, 10)), { models })
    : {};
  const result = scoreAndAssemble(ctx, results, parsed, nowMs);

  if (persist) await save(result);
  return result;
}

/** The 7 fields a caller actually needs. */
export function slim(r) {
  return {
    brand: r.brand,
    status: r.status,
    confidence: r.confidence,
    reason: r.reason,
    sources: r.sources ?? [],
    checked_at: r.checked_at,
    served_from: r.served_from,
  };
}
