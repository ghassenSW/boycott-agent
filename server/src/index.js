import express from 'express';
import { config, assertConfig } from './config.js';
import { ensureSchema, pool } from './db.js';
import * as brandAgent from './agents/boycott-check.js';
import * as linkAgent from './agents/verify-link.js';
import { brandReport } from './agents/brand-report.js';
import { requireApiKey, rateLimit } from './access.js';
import { usage, syncTavilyUsage } from './budget.js';
import { BudgetExceeded } from './errors.js';

assertConfig();

const app = express();
app.disable('x-powered-by');
// Behind the HTTPS proxy (Caddy) in production; makes req.ip the caller's real address in logs.
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// One line per request: who, what, result, how long.
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') return;
    console.log(`${new Date().toISOString()} ${req.client ?? '-'} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Browser access is off by default (the API is for website servers). Set CORS_ORIGIN to allow one site.
if (config.corsOrigin) {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.corsOrigin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Express 4 doesn't catch rejected promises — wrap every async handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/** Full record or slim one? `detail: true` in the body, or ?detail=1. */
function wantsDetail(req) {
  const flag = req.query.detail ?? req.body?.detail ?? '';
  return ['1', 'true', 'yes'].includes(String(flag).toLowerCase());
}

// A brand report audits up to max_sources links, so it costs that many extra units.
const reportCost = (req) => {
  const n = Number.parseInt(req.body?.max_sources, 10);
  const sources = Number.isFinite(n) && n >= 1 ? n : config.report.defaultMaxSources;
  return 1 + Math.min(sources, config.report.hardMaxSources);
};

const routes = {
  '/v1/boycott-check': [
    rateLimit(() => 1),
    wrap(async (req, res) => {
      const full = await brandAgent.boycottCheck(req.body);
      res.json(wantsDetail(req) ? full : brandAgent.slim(full));
    }),
  ],
  '/v1/verify-link': [
    rateLimit(() => 1),
    wrap(async (req, res) => {
      const full = await linkAgent.verifyLink(req.body);
      res.json(wantsDetail(req) ? full : linkAgent.slim(full));
    }),
  ],
  '/v1/brand-report': [
    rateLimit(reportCost),
    wrap(async (req, res) => {
      res.json(await brandReport(req.body));
    }),
  ],
};

for (const [path, handlers] of Object.entries(routes)) app.post(path, requireApiKey, ...handlers);

// What the shared budget has left today and this month. Free: costs no units.
app.get('/v1/usage', requireApiKey, wrap(async (_req, res) => res.json(await usage())));

// Public, no key: for uptime monitors and the Docker health check.
app.get('/health', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
}));

app.use((_req, res) =>
  res.status(404).json({ error: 'Not found', type: 'NotFound', endpoints: Object.keys(routes).map((p) => `POST ${p}`) })
);

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  // Malformed JSON body from express.json().
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.', type: 'BadRequest' });
  }
  const status = err.status ?? 500;
  if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
  if (status >= 500 && !(err instanceof BudgetExceeded)) console.error(err);
  // Never leak internals on an unexpected crash; upstream (502) messages are safe and useful.
  const message = status === 500 ? 'Internal error. The server log has details.' : err.message;
  res.status(status).json({ error: message, type: status === 500 ? 'InternalError' : err.name });
});

const server = app.listen(config.port, async () => {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('Could not reach Postgres:', err.message);
    console.error(`Tried ${config.db.host}:${config.db.port}. Is the boycott-postgres container running?`);
    process.exit(1);
  }
  console.log(`Boycott Agent API on http://localhost:${config.port}`);
  console.log(`  POST /v1/boycott-check   { brand }`);
  console.log(`  POST /v1/verify-link     { url, product, cause }`);
  console.log(`  POST /v1/brand-report    { brand, max_sources }`);
  console.log(`  GET  /health             (no key)`);
  console.log(`  keys: ${config.access.apiKeys.map((k) => k.name).join(', ')} | limits: ${config.access.perMinute}/min, ${config.access.perDay}/day per key`);
  console.log(`  LLM: ${config.llm.models.join(' -> ')} (max ${config.llm.maxConcurrency} at once)`);
  const b = config.budget;
  console.log(
    `  budget (all keys together): Tavily ${b.tavilyDaily}/day, ${b.tavilyMonthly}/month · LLM ${b.llmDaily}/day · ` +
      `Tavily depth: search ${config.tavily.searchDepth}, extract ${config.tavily.extractDepth}`
  );

  // Count credits spent outside this API too (tests, other apps on the same Tavily key).
  const sync = () =>
    syncTavilyUsage()
      .then((n) => console.log(`  Tavily reports ${n} credits used this billing month`))
      .catch((err) => console.warn(`  could not sync Tavily usage: ${err.message}`));
  await sync();
  setInterval(sync, 15 * 60_000).unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
