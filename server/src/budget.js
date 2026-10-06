// The global budget: what every website key together may spend per day and per month.
//
// Each Tavily or LLM call first reserves its cost here. The reservation is a single
// conditional UPDATE inside a transaction, so two requests can never both take the
// last credits. When a cap is reached the call is refused with BudgetExceeded (503);
// answers already in the cache keep working.

import { pool, query } from './db.js';
import { config } from './config.js';
import { BudgetExceeded } from './errors.js';

const TAVILY = 'tavily_credits';
const LLM = 'llm_calls';

const day = (d = new Date()) => `day:${d.toISOString().slice(0, 10)}`;
const month = (d = new Date()) => `month:${d.toISOString().slice(0, 7)}`;

function limitsFor(resource) {
  const b = config.budget;
  if (resource === TAVILY) return [[day(), b.tavilyDaily, 'daily'], [month(), b.tavilyMonthly, 'monthly']];
  if (resource === LLM) return [[day(), b.llmDaily, 'daily']];
  throw new Error(`unknown budget resource ${resource}`);
}

function secondsToNextUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
}

function exceeded(resource, which) {
  const what = resource === TAVILY ? 'web research' : 'language model';
  return new BudgetExceeded(
    `The ${which} ${what} budget is used up. Answers already checked still work; new checks resume ` +
      (which === 'daily' ? 'after midnight UTC.' : 'next month.'),
    { retryAfterS: which === 'daily' ? secondsToNextUtcDay() : 86_400 }
  );
}

/** Reserve `amount` of `resource` in every period that caps it, or throw BudgetExceeded. */
export async function spend(resource, amount) {
  if (amount <= 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [period, limit, which] of limitsFor(resource)) {
      await client.query(
        'INSERT INTO api_budget (period, resource, used) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING',
        [period, resource]
      );
      const { rowCount } = await client.query(
        'UPDATE api_budget SET used = used + $3 WHERE period = $1 AND resource = $2 AND used + $3 <= $4',
        [period, resource, amount, limit]
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        throw exceeded(resource, which);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function usedIn(period, resource) {
  const { rows } = await query('SELECT used FROM api_budget WHERE period = $1 AND resource = $2', [period, resource]);
  return rows[0]?.used ?? 0;
}

/** Throw now if a whole job (e.g. a brand report) can't be paid for, before spending anything. */
export async function ensureAvailable({ tavily = 0, llm = 0 }) {
  for (const [resource, amount] of [[TAVILY, tavily], [LLM, llm]]) {
    if (amount <= 0) continue;
    for (const [period, limit, which] of limitsFor(resource)) {
      if ((await usedIn(period, resource)) + amount > limit) throw exceeded(resource, which);
    }
  }
}

/** What's been used and what's left, for GET /v1/usage. */
export async function usage() {
  const b = config.budget;
  const row = async (period, resource, limit) => {
    const used = await usedIn(period, resource);
    return { used, limit, remaining: Math.max(0, limit - used) };
  };
  return {
    tavily_credits: {
      today: await row(day(), TAVILY, b.tavilyDaily),
      this_month: await row(month(), TAVILY, b.tavilyMonthly),
    },
    llm_calls: { today: await row(day(), LLM, b.llmDaily) },
    resets: { daily: 'midnight UTC', monthly: 'first day of the month UTC' },
  };
}

/**
 * Align the monthly Tavily counter with what Tavily itself reports for the account,
 * so credits spent elsewhere (tests, other apps) count too. Calls made while the
 * request is in flight are kept: reported + (local now - local at start).
 * Tavily's own counter lags a few minutes behind, so this only ever RAISES ours:
 * an undercount could overspend, an overcount just pauses research a little early.
 */
export async function syncTavilyUsage() {
  const period = month();
  const before = await usedIn(period, TAVILY);
  const res = await fetch('https://api.tavily.com/usage', {
    headers: { Authorization: `Bearer ${config.tavily.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tavily usage endpoint returned ${res.status}`);
  const reported = Number((await res.json())?.account?.plan_usage);
  if (!Number.isFinite(reported)) throw new Error('Tavily usage endpoint returned no plan_usage');
  await query('INSERT INTO api_budget (period, resource, used) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [period, TAVILY]);
  await query('UPDATE api_budget SET used = GREATEST(used, $3 + (used - $4)) WHERE period = $1 AND resource = $2', [
    period,
    TAVILY,
    reported,
    before,
  ]);
  return reported;
}

export const RESOURCES = { TAVILY, LLM };

/** Tavily price of one call at the configured depth. */
export const tavilyCost = (depth) => (depth === 'basic' ? 1 : 2);
