// Agent 3 — Brand Report.
// Runs Agent 1, then puts each source it returned through Agent 2. Answers both
// "does a boycott exist?" and "does the evidence for it survive an audit?".
//
// In n8n this had to call itself over HTTP. Here it's just two function calls.

import { config } from '../config.js';
import { sleep } from '../clients.js';
import { BadRequest, BudgetExceeded } from '../errors.js';
import { ensureAvailable, tavilyCost } from '../budget.js';
import { boycottCheck } from './boycott-check.js';
import { verifyLink } from './verify-link.js';

export async function brandReport(body = {}) {
  const brand = String(body.brand ?? '').trim();
  if (!brand) throw new BadRequest('Missing "brand". Send JSON: { "brand": "Nike" }');

  // Each audited source costs a Tavily extract + an LLM call, so keep the cap low.
  let maxSources = Number.parseInt(body.max_sources, 10);
  if (!Number.isFinite(maxSources) || maxSources < 1) maxSources = config.report.defaultMaxSources;
  maxSources = Math.min(maxSources, config.report.hardMaxSources);

  // Refuse up front if the whole report can't be paid for, rather than stopping halfway.
  // Worst case: nothing is cached, so one search and one extract per source.
  await ensureAvailable({
    tavily: tavilyCost(config.tavily.searchDepth) + maxSources * tavilyCost(config.tavily.extractDepth),
    llm: 1 + maxSources,
  });

  const brandResult = await boycottCheck({ brand });

  // The cause we hand the verifier is the reason Agent 1 reported. If it found
  // nothing, fall back to a generic phrasing so the verifier still has something concrete.
  const cause = brandResult.reason?.trim()
    ? brandResult.reason.trim().slice(0, 300)
    : `consumer boycott of ${brandResult.brand}`;

  const picked = (brandResult.sources ?? []).filter((s) => s?.url).slice(0, maxSources);

  const sources = [];
  for (const [i, source] of picked.entries()) {
    // Spaced out — free-tier LLMs rate-limit aggressively.
    if (i > 0) await sleep(config.report.delayMs);
    try {
      const v = await verifyLink({ url: source.url, product: brandResult.brand, cause });
      sources.push({
        url: v.url,
        title: source.title ?? '',
        verdict: v.verdict,
        support_strength: v.support_strength,
        credibility: v.credibility,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      // One bad link must not sink the whole report.
      sources.push({
        url: source.url,
        title: source.title ?? '',
        verdict: 'unreachable',
        support_strength: 0,
        credibility: 0,
        error: err.message,
      });
    }
  }

  // Evidence score — deterministic, same principle as everywhere else in this project.
  // A source is only worth (how well it backs the claim) x (how trustworthy it is).
  const quality = sources
    .map((s) => (s.support_strength * s.credibility) / 100)
    .sort((a, b) => b - a)
    .slice(0, 3);
  const evidence_score = quality.length
    ? Math.round(quality.reduce((a, b) => a + b, 0) / quality.length)
    : 0;

  return {
    brand: brandResult.brand,
    status: brandResult.status,
    confidence: brandResult.confidence, // does a boycott appear to exist?
    reason: brandResult.reason ?? '',
    evidence_score, // do its sources hold up? 0-100
    sources_checked: sources.length,
    sources_verified: sources.filter((s) => s.verdict === 'verified').length,
    sources,
    checked_at: new Date().toISOString(),
  };
}
