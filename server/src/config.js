import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.join(here, '..', '..');

// The project's .env — the same file docker-compose reads — lives at the repo root.
dotenv.config({ path: path.join(projectRoot, '.env') });
// A server/.env, if you create one, wins. Handy for pointing at a different database.
dotenv.config({ path: path.join(here, '..', '.env'), override: true });

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  // The API is meant to be called from a website's SERVER, so browser CORS is off
  // unless an origin is set here explicitly.
  corsOrigin: env.CORS_ORIGIN || '',

  access: {
    // "site-a:key1,site-b:key2". A bare key with no name gets the name "default".
    apiKeys: (env.API_KEYS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const i = entry.indexOf(':');
        return i > 0
          ? { name: entry.slice(0, i).trim(), key: entry.slice(i + 1).trim() }
          : { name: 'default', key: entry };
      }),
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE || 20),
    perDay: Number(env.RATE_LIMIT_PER_DAY || 300),
  },

  db: {
    // Neon's addresses end in "sslmode=require". node-postgres treats that as full certificate
    // verification today, but its next major version will weaken it to libpq's meaning
    // (encrypted, server not verified). Pin the strong behaviour explicitly.
    connectionString: env.DATABASE_URL ? env.DATABASE_URL.replace(/sslmode=require\b/, 'sslmode=verify-full') : undefined,
    host: env.PGHOST || 'localhost',
    // The Docker container publishes 5432 on host port 5433.
    port: Number(env.PGPORT || 5433),
    user: env.PGUSER || env.POSTGRES_USER,
    password: env.PGPASSWORD || env.POSTGRES_PASSWORD,
    database: env.PGDATABASE || env.POSTGRES_DB,
  },

  tavily: {
    apiKey: env.TAVILY_API_KEY,
    // "basic" costs 1 credit per call, "advanced" 2. Measured on the answer keys (2026-10-06):
    // basic extraction returned identical text on all 15 test pages, so it's the default;
    // basic search returned mostly off-topic results and missed 2 of 7 real boycotts, so search stays advanced.
    searchDepth: env.TAVILY_SEARCH_DEPTH || 'advanced',
    extractDepth: env.TAVILY_EXTRACT_DEPTH || 'basic',
  },

  // Caps shared by ALL website keys together, so the free plans are never exceeded.
  // Stored in Postgres: a restart doesn't reset them. Days and months are UTC.
  budget: {
    tavilyDaily: Number(env.TAVILY_DAILY_CREDITS || 30),
    tavilyMonthly: Number(env.TAVILY_MONTHLY_CREDITS || 950), // free plan: 1000, minus a margin
    llmDaily: Number(env.LLM_DAILY_CALLS || 400),
    // How often the monthly Tavily count is checked against Tavily's own figure.
    syncMinutes: Number(env.BUDGET_SYNC_MINUTES || 60),
  },

  llm: {
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || 'gemini-3.8-flash',
    // Tried in order when the one before is congested. All free on the same Gemini key.
    models: [
      env.LLM_MODEL || 'gemini-3.8-flash',
      ...(env.LLM_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
    ].filter((m, i, all) => all.indexOf(m) === i),
    // Model calls running at once. Free tiers allow few requests per minute, so
    // extra requests wait their turn instead of all failing together.
    maxConcurrency: Number(env.LLM_MAX_CONCURRENCY || 2),
  },

  // How long a stored answer counts as current before we re-check.
  freshness: {
    brandDays: Number(env.BRAND_FRESH_DAYS || 7),
    linkDays: Number(env.LINK_FRESH_DAYS || 30),
  },

  // /brand-report: how many of a brand's sources to audit, and how long to wait
  // between them so a free-tier LLM doesn't rate-limit us.
  report: {
    defaultMaxSources: Number(env.REPORT_MAX_SOURCES || 3),
    hardMaxSources: 8,
    delayMs: Number(env.REPORT_DELAY_MS || 1500),
  },
};

/** Fail loudly at boot rather than mysteriously on the first request. */
export function assertConfig() {
  const missing = [];
  if (!config.tavily.apiKey) missing.push('TAVILY_API_KEY');
  if (!config.llm.baseUrl) missing.push('LLM_BASE_URL');
  if (!config.llm.apiKey) missing.push('LLM_API_KEY');
  if (!config.db.connectionString && !config.db.user) missing.push('POSTGRES_USER');
  if (!config.db.connectionString && !config.db.database) missing.push('POSTGRES_DB');
  if (!config.access.apiKeys.length) missing.push('API_KEYS');

  const weak = config.access.apiKeys.filter((k) => k.key.length < 24).map((k) => k.name);
  if (weak.length) {
    throw new Error(`API_KEYS: the key(s) for ${weak.join(', ')} are shorter than 24 characters. Use long random keys.`);
  }

  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        `Expected them in ${path.join(projectRoot, '.env')}`
    );
  }
}
