// Agent 2 — Link Verifier.
// Given a URL, a product and a cause, says whether that page actually supports the
// claim, and how much the source is worth. Every number here is computed in code;
// the model only classifies and may nudge credibility by at most ±15.

import { config } from '../config.js';
import { query, isFresh } from '../db.js';
import { tavilyExtract, llmJson } from '../clients.js';
import { BadRequest, UpstreamError, BudgetExceeded } from '../errors.js';
import { ensureAvailable } from '../budget.js';
import { cleanPageText } from '../page-text.js';
import { selectPassages } from '../passages.js';
import { classifyDomain } from '../domains.js';

// ---------------------------------------------------------------- input

export function normalizeInput(body = {}) {
  const url = String(body.url ?? '').trim();
  const product = String(body.product ?? '').trim();
  const cause = String(body.cause ?? '').trim();

  if (!url) throw new BadRequest('Missing "url".');
  if (!product) throw new BadRequest('Missing "product".');
  if (!cause) throw new BadRequest('Missing "cause".');

  const match = url.match(/^([a-z][a-z0-9+.\-]*):\/\/([^/?#\s]+)([^\s]*)$/i);
  if (!match) {
    throw new BadRequest(`"url" does not look like a valid URL (expected http://… or https://…): ${url}`);
  }
  const protocol = match[1].toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    throw new BadRequest(`Only http/https URLs are supported. Got: ${protocol}`);
  }
  // strip any user:pass@ and :port to get the bare host
  const hostname = match[2].split('@').pop().split(':')[0].toLowerCase();

  const url_normalized = url.toLowerCase().replace(/\/+$/, '');
  const product_normalized = product.toLowerCase().replace(/\s+/g, ' ');
  const cause_normalized = cause.toLowerCase().replace(/\s+/g, ' ');

  return {
    url,
    product,
    cause,
    hostname,
    protocol,
    cache_key: `${url_normalized.slice(0, 500)}|${product_normalized}|${cause_normalized}`,
  };
}

// ---------------------------------------------------------------- page fetch

// Many sites answer a missing page with a styled 404 that still carries a few
// thousand characters of nav and footer, so a length check alone lets them through.
// (Al Jazeera's 404 is 4.3k characters, the first 900 of which are the menu.)
// Guarded by a length ceiling: a real article long enough to matter won't be
// mistaken for a placeholder just because it uses one of these phrases.
const SOFT_404 =
  /(page not found|404 error|error 404|we can'?t find the page|we cannot find the page|the page you (are|were) looking for|this page (doesn'?t|does not) exist|page (is )?unavailable|content (is )?not available)/i;
const SOFT_404_MAX_LENGTH = 6000;

function looksMissing(content, content_length) {
  if (content_length >= SOFT_404_MAX_LENGTH) return false;
  // Drop link targets first, so a URL that happens to contain these words can't trigger it.
  const prose = content.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
  return SOFT_404.test(prose);
}

/** Pull readable text out of Tavily's response, defensively. */
function readPage(response = {}) {
  let content = '';
  let failed = false;
  let note = '';

  if (response.error) {
    failed = true;
    note = typeof response.error === 'string' ? response.error : JSON.stringify(response.error);
  }
  if (Array.isArray(response.results) && response.results.length) {
    const r = response.results[0];
    content = r.raw_content || r.rawContent || r.content || '';
  }
  if (Array.isArray(response.failed_results) && response.failed_results.length) {
    failed = true;
    note = response.failed_results[0].error || 'extraction failed';
  }

  const raw = String(content || '').trim();
  // The soft-404 check runs on the raw page, whose length ceiling it was tuned on.
  const softMissing = looksMissing(raw, raw.length);

  // Everything downstream (the model, quote checks, credibility signals) reads the
  // cleaned text. On real pages the article often starts after 15k+ characters of menus,
  // past what we can send to a free-tier model.
  content = cleanPageText(raw);
  const content_length = content.length;

  // A page that returns almost nothing (paywall, JS-only, empty) is not verifiable.
  // Nor is one whose opening text is a "not found" message, however long it is.

  const available = !failed && content_length >= 200 && !softMissing;
  if (!available && !note) {
    if (softMissing) {
      note = 'the page is an error/"not found" placeholder, not an article';
    } else {
      note =
        content_length > 0
          ? `page returned only ${content_length} characters (paywall, JS-only page, or empty)`
          : 'no readable content returned';
    }
  }

  return { content, content_length, available, note: available ? '' : note };
}

// ---------------------------------------------------------------- credibility (deterministic part)

function credibilityBase(ctx, page) {
  const domain = ctx.hostname.replace(/^www\./, '');
  const { domain_tier, domain_score } = classifyDomain(domain);

  // Cheap metadata heuristics on the top of the extracted text.
  const head = page.content.slice(0, 3000);
  const has_author =
    /\b(by|By|BY)\s+[A-Z][a-z]+\s+[A-Z][a-z']+/.test(head) || /author/i.test(head);
  const has_date =
    /\b(20\d{2}-\d{2}-\d{2})\b/.test(head) ||
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i.test(head) ||
    /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/i.test(head);
  const isHttps = ctx.protocol === 'https';

  let base = domain_score;
  if (has_author) base += 8;
  if (has_date) base += 8;
  if (isHttps) base += 4;
  if (page.content_length >= 1200) base += 10;
  // Caps at 70 so the model's ±15 can never produce a perfect score on its own.
  base = Math.max(0, Math.min(70, base));

  return {
    domain,
    credibility_base: base,
    signals: { domain_tier, domain_score, has_author, has_date, isHttps, content_length: page.content_length },
  };
}

// ---------------------------------------------------------------- the model

function buildPrompt(ctx, page, contextMode) {
  let pageText;
  let excerpted = false;
  if (contextMode === 'full') {
    pageText = page.content.slice(0, 12_000); // the original behaviour, kept for comparison
  } else {
    const picked = selectPassages(page.content, ctx.product, ctx.cause);
    pageText = picked.text;
    excerpted = picked.mode === 'passages';
  }

  const system = [
    'You are a strict source-verification analyst.',
    excerpted
      ? 'You are given relevant excerpts from ONE web page ("[…]" marks skipped text), a product/brand, and a claimed cause for boycotting it.'
      : 'You are given the text of ONE web page, a product/brand, and a claimed cause for boycotting it.',
    'The page may be in any language (English, French, Arabic…); the brand may be written in that language\'s script.',
    'Judge ONLY from the page text provided. Never use prior knowledge about the brand.',
    'Never invent quotes: every evidence quote must appear VERBATIM in the page text, under 25 words each, maximum 3 quotes.',
    'Be strict. A page that merely mentions the brand, or that discusses a DIFFERENT cause, does NOT support the claim.',
    'Stay neutral: report what the page says, do not take a side on the boycott itself.',
    'Respond with ONLY a JSON object and no other text.',
  ].join(' ');

  const user = [
    `Product/Brand: ${ctx.product}`,
    `Claimed cause for boycott: ${ctx.cause}`,
    `Page URL: ${ctx.url}`,
    '',
    'PAGE TEXT:',
    '"""',
    pageText,
    '"""',
    '',
    'Return a JSON object with exactly these fields:',
    '{',
    '  "mentions_product": true or false,',
    '  "mentions_cause": true or false,',
    '  "support": "supports" | "partial" | "unrelated" | "contradicts",',
    '  "content_type": "news_report" | "opinion" | "activist_campaign" | "social_post" | "corporate_statement" | "reference" | "other",',
    '  "evidence": ["short verbatim quote from the page, under 25 words"],',
    '  "summary": "one neutral sentence on what this page says about the product and the cause",',
    '  "credibility_adjustment": integer from -15 to 15,',
    '  "credibility_reason": "short reason for the adjustment"',
    '}',
    '',
    'Definitions:',
    '- "supports": the page clearly links THIS product to THIS cause in a boycott or criticism context.',
    '- "partial": the link is weak, indirect, or only one of the two is discussed strongly.',
    '- "unrelated": the page does not connect this product to this cause. This includes a page that discusses a boycott of this product for a DIFFERENT reason.',
    '- "contradicts": the page explicitly denies, refutes or debunks THIS claim (e.g. the company or a fact-check says it is false). A page that simply gives a different reason is "unrelated", not "contradicts".',
    '',
    'credibility_adjustment guidance: reward primary sources, named reporting, cited evidence and balance;',
    'penalise sensationalism, anonymous claims, pure opinion presented as fact, and obvious promotional intent.',
  ].join('\n');

  return { system, user };
}

// ---------------------------------------------------------------- scoring

function scoreAndAssemble(ctx, page, cred, parsed) {
  // An unusable model answer must surface as an error, never as an "unrelated" verdict.
  if (!['supports', 'partial', 'unrelated', 'contradicts'].includes(parsed.support)) {
    throw new UpstreamError('The language model returned an unusable answer. Please retry in a moment.');
  }
  const support = parsed.support;
  const mentions_product = parsed.mentions_product === true;
  const mentions_cause = parsed.mentions_cause === true;

  // Anti-hallucination: keep only quotes that really appear in the page.
  const pageLower = page.content.toLowerCase().replace(/\s+/g, ' ');
  const rawEvidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence = rawEvidence
    .filter((q) => typeof q === 'string' && q.trim().length > 10)
    .map((q) => q.trim())
    .filter((q) => pageLower.includes(q.toLowerCase().replace(/\s+/g, ' ').slice(0, 60)))
    .slice(0, 3);
  const evidence_dropped = rawEvidence.length - evidence.length;

  // Support strength — deterministic.
  let support_strength;
  if (support === 'supports') support_strength = 80 + evidence.length * 5;
  else if (support === 'partial') support_strength = 45 + evidence.length * 3;
  else if (support === 'contradicts') support_strength = 0;
  else support_strength = 5;

  if (!mentions_product) support_strength = Math.min(support_strength, 10);
  else if (!mentions_cause) support_strength = Math.min(support_strength, 35);
  // Claimed support but produced nothing quotable — cap it.
  if (support === 'supports' && evidence.length === 0) support_strength = Math.min(support_strength, 60);
  support_strength = Math.max(0, Math.min(100, Math.round(support_strength)));

  // Credibility = deterministic base + the model's bounded nudge.
  let adjust = Number(parsed.credibility_adjustment);
  if (!Number.isFinite(adjust)) adjust = 0;
  adjust = Math.max(-15, Math.min(15, Math.round(adjust)));
  const credibility = Math.max(0, Math.min(100, cred.credibility_base + adjust));

  let verdict;
  if (support === 'contradicts') verdict = 'contradicts_claim';
  else if (!mentions_product) verdict = 'unrelated';
  else if (support_strength >= 70) verdict = 'verified';
  else if (support_strength >= 40) verdict = 'weak_support';
  else verdict = 'unrelated';

  const s = cred.signals;
  const notes = [
    `Support strength ${support_strength}/100 = how strongly THIS page backs "${ctx.product}" + "${ctx.cause}" (from the model's classification, capped by whether the product and cause are actually discussed, and by how many quotes were verifiable).`,
    `Credibility ${credibility}/100 = deterministic base ${cred.credibility_base} (domain tier: ${s.domain_tier}, author: ${s.has_author}, date: ${s.has_date}, length: ${s.content_length}) adjusted by ${adjust >= 0 ? '+' : ''}${adjust} from the model.`,
    evidence_dropped > 0
      ? `${evidence_dropped} quote(s) were discarded because they could not be found verbatim in the page.`
      : '',
    'These scores describe THIS ONE LINK, not whether the boycott claim is true overall.',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    url: ctx.url,
    product: ctx.product,
    cause: ctx.cause,
    cache_key: ctx.cache_key,
    available: true,
    availability_note: '',
    domain: cred.domain,
    content_length: page.content_length,
    verdict,
    support_strength,
    credibility,
    credibility_base: cred.credibility_base,
    credibility_adjust: adjust,
    credibility_reason: String(parsed.credibility_reason ?? '').slice(0, 500),
    mentions_product,
    mentions_cause,
    content_type: String(parsed.content_type ?? 'other'),
    summary: String(parsed.summary ?? '').slice(0, 1000),
    evidence,
    evidence_dropped,
    notes,
    checked_at: new Date().toISOString(),
    served_from: 'live',
  };
}

function unreachableResult(ctx, page, cred) {
  return {
    url: ctx.url,
    product: ctx.product,
    cause: ctx.cause,
    cache_key: ctx.cache_key,
    available: false,
    availability_note: page.note,
    domain: cred.domain,
    content_length: page.content_length,
    verdict: 'unreachable',
    support_strength: 0,
    credibility: 0,
    credibility_base: cred.credibility_base,
    credibility_adjust: 0,
    credibility_reason: 'Not assessed — page content could not be read.',
    mentions_product: false,
    mentions_cause: false,
    content_type: 'unknown',
    summary: '',
    evidence: [],
    evidence_dropped: 0,
    notes: `The link could not be verified: ${page.note}. This says nothing about whether the claim is true — only that THIS link cannot support it.`,
    checked_at: new Date().toISOString(),
    served_from: 'live',
  };
}

// ---------------------------------------------------------------- storage

const UPSERT_SQL = `
INSERT INTO link_verifications
  (url, product, cause, cache_key, available, availability_note, domain, content_length,
   verdict, support_strength, credibility, credibility_base, credibility_adjust, credibility_reason,
   mentions_product, mentions_cause, content_type, summary, evidence, evidence_dropped, notes, checked_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
ON CONFLICT (cache_key) DO UPDATE SET
  url = EXCLUDED.url,
  product = EXCLUDED.product,
  cause = EXCLUDED.cause,
  available = EXCLUDED.available,
  availability_note = EXCLUDED.availability_note,
  domain = EXCLUDED.domain,
  content_length = EXCLUDED.content_length,
  verdict = EXCLUDED.verdict,
  support_strength = EXCLUDED.support_strength,
  credibility = EXCLUDED.credibility,
  credibility_base = EXCLUDED.credibility_base,
  credibility_adjust = EXCLUDED.credibility_adjust,
  credibility_reason = EXCLUDED.credibility_reason,
  mentions_product = EXCLUDED.mentions_product,
  mentions_cause = EXCLUDED.mentions_cause,
  content_type = EXCLUDED.content_type,
  summary = EXCLUDED.summary,
  evidence = EXCLUDED.evidence,
  evidence_dropped = EXCLUDED.evidence_dropped,
  notes = EXCLUDED.notes,
  checked_at = EXCLUDED.checked_at
`;

async function save(r) {
  await query(UPSERT_SQL, [
    r.url, r.product, r.cause, r.cache_key, r.available, r.availability_note, r.domain, r.content_length,
    r.verdict, r.support_strength, r.credibility, r.credibility_base, r.credibility_adjust, r.credibility_reason,
    r.mentions_product, r.mentions_cause, r.content_type, r.summary, JSON.stringify(r.evidence),
    r.evidence_dropped, r.notes, r.checked_at,
  ]);
}

// ---------------------------------------------------------------- public

/**
 * Full pipeline. Returns the complete record; use `slim()` for the API response.
 * The options exist for the eval (eval/run.js): it reads saved page snapshots,
 * pins the model, and must neither read nor write the cache.
 */
export async function verifyLink(
  body,
  { useCache = true, save: persist = true, extract = tavilyExtract, contextMode = 'passages', models } = {}
) {
  const ctx = normalizeInput(body);

  // 1. Cache — a page's content rarely changes, so verifications stay valid a while.
  if (useCache) {
    const { rows } = await query('SELECT * FROM link_verifications WHERE cache_key = $1 LIMIT 1', [
      ctx.cache_key,
    ]);
    const cached = rows[0];
    if (cached && isFresh(cached.checked_at, config.freshness.linkDays)) {
      return { ...cached, evidence: cached.evidence ?? [], served_from: 'cache' };
    }
  }

  // 2. Fetch the page. A dead link is an answer, not a crash.
  // Check the model budget first, so a page is never paid for when it can't be judged.
  await ensureAvailable({ llm: 1 });
  let extracted;
  try {
    extracted = await extract(ctx.url);
  } catch (err) {
    // A spent budget is not a dead link: never record it as "unreachable".
    if (err instanceof BudgetExceeded) throw err;
    extracted = { error: err.message };
  }
  const page = readPage(extracted);
  const cred = credibilityBase(ctx, page);

  if (!page.available) {
    const result = unreachableResult(ctx, page, cred);
    if (persist) await save(result);
    return result;
  }

  // 3. Classify, grounded strictly on this page's text.
  const parsed = await llmJson(buildPrompt(ctx, page, contextMode), { models });

  // 4. Score in code, then store.
  const result = scoreAndAssemble(ctx, page, cred, parsed);
  if (persist) await save(result);
  return result;
}

/** The 10 fields a caller actually needs. */
export function slim(r) {
  return {
    url: r.url,
    product: r.product,
    cause: r.cause,
    verdict: r.verdict,
    support_strength: r.support_strength,
    credibility: r.credibility,
    summary: r.summary || r.availability_note || '',
    evidence: r.evidence ?? [],
    checked_at: r.checked_at,
    served_from: r.served_from,
  };
}
