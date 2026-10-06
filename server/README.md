# Boycott Agent API — plain Node.js

The same three agents as the n8n workflows, as one Express server.

## Run it (Docker, recommended)

From the project root, with Docker Desktop open:

```bash
docker compose up -d --build
```

That starts the database and the API. The API answers on http://localhost:3000 with the
same requests as the Postman collection. Both containers restart on their own after a
reboot. After changing code, run the same command again to rebuild.

| Task | Command |
|---|---|
| Logs | `docker logs -f boycott-api` |
| Stop (data is kept) | `docker compose down` |
| Old n8n version too | `docker compose --profile n8n up -d` |

## Run it without Docker (for development)

Stop the `boycott-api` container first (it uses port 3000), keep Postgres running, then:

```bash
cd server
npm install
npm run dev
```

`npm run dev` restarts on every file change.

## Endpoints

`POST /v1/verify-link`, `POST /v1/boycott-check`, `POST /v1/brand-report`, plus `GET /health`.
Every `/v1` request needs `Authorization: Bearer <key>` with a key from `API_KEYS`.

The full reference (fields, errors, limits, examples in curl / Node / PHP / Python) is in
[`../API.md`](../API.md), and in machine-readable form in [`../openapi.yaml`](../openapi.yaml).
Putting it online: [`../DEPLOY.md`](../DEPLOY.md).

```bash
curl -X POST http://localhost:3000/v1/verify-link \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.bbc.com/news/business-66398296","product":"Bud Light","cause":"partnership with Dylan Mulvaney"}'
```

## Layout

| File | What's in it |
|---|---|
| `src/index.js` | Express app, routes, request log, error handling |
| `src/access.js` | API keys and per-key usage limits |
| `src/config.js` | Reads the project `.env`, validates it at boot |
| `src/db.js` | Postgres pool, schema bootstrap, freshness check |
| `src/clients.js` | Tavily search / extract, LLM call with model fallback and a concurrency queue |
| `src/page-text.js` | Strips menus, links and banners from extracted pages |
| `src/passages.js` | Picks the paragraphs about the product and cause to send to the model |
| `eval/` | The answer key (23 cases), saved pages, and the runner |
| `src/agents/boycott-check.js` | Agent 1 — search, judge, confidence formula |
| `src/agents/verify-link.js` | Agent 2 — extract, credibility tiers, quote validation, scoring |
| `src/agents/brand-report.js` | Agent 3 — chains 1 into 2, computes `evidence_score` |

## Configuration

Read from the project's `.env` (one level up, the same file docker-compose uses).
A `server/.env` overrides it if you make one.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `API_KEYS` | — (required) | `name:key` pairs, comma-separated, one per website. Keys must be 24+ characters. `npm run new-key` makes one. |
| `RATE_LIMIT_PER_MINUTE` / `_PER_DAY` | `20` / `300` | Usage units allowed per key (see `API.md`) |
| `LLM_MAX_CONCURRENCY` | `2` | Model calls running at once; the rest wait their turn |
| `TAVILY_DAILY_CREDITS` / `TAVILY_MONTHLY_CREDITS` | `30` / `950` | Global budget, all keys together. Stored in Postgres (`api_budget`), so restarts don't reset it. The monthly count is synced with Tavily's own usage every 15 min. |
| `LLM_DAILY_CALLS` | `400` | Global daily cap on model calls |
| `TAVILY_SEARCH_DEPTH` / `TAVILY_EXTRACT_DEPTH` | `advanced` / `basic` | `basic` = 1 credit, `advanced` = 2. Measured choice, see "Basic vs advanced" below |
| `CORS_ORIGIN` | off | Allow one browser origin to call the API directly. Leave unset: the API is for website servers. |
| `PGHOST` / `PGPORT` | `localhost` / `5433` | Where Postgres is. `5433` is the Docker port mapping. |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | — | Database credentials (already in `.env`) |
| `DATABASE_URL` | — | Set this instead, and the `PG*` vars are ignored |
| `TAVILY_API_KEY` | — | Tavily key |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | Any OpenAI-compatible provider |
| `LLM_FALLBACK_MODELS` | 4 free Gemini models | Comma list tried in order when the model before it is busy (503/429) or retired (404). A failing model is skipped for 2 minutes. |
| `BRAND_FRESH_DAYS` | `7` | How long a brand answer stays cached |
| `LINK_FRESH_DAYS` | `30` | How long a link verification stays cached |
| `REPORT_MAX_SOURCES` | `3` | Default sources audited per `/brand-report` (hard cap 8) |
| `REPORT_DELAY_MS` | `1500` | Pause between audits, for free-tier LLM rate limits |

## Where the scores come from

The model classifies; **it never picks a number**. Every score is computed here in JS:

- **`support_strength`** — from the model's `supports`/`partial`/`unrelated`/`contradicts`
  label, then capped: no mention of the product → max 10; product but not the cause → max 35;
  claims support but produced no verifiable quote → max 60.
- **`credibility`** — a deterministic base (max 70) from domain tier, byline, date, HTTPS and
  article length, plus the model's adjustment, clamped to ±15. A page cannot talk its way up.
- **`confidence`** — source count (45) + recency (30) + authority (25), capped at 12 for
  `no_evidence` and 45 for `unclear`.
- **`evidence_score`** — mean of the best three `support_strength × credibility ÷ 100`.

Evidence quotes are checked to appear verbatim in the extracted page text; invented ones are
dropped and counted in `evidence_dropped` (visible with `detail=true`).

A page is only judged at all if it's genuinely readable. Empty pages, paywalls, and **soft 404s**
(a "not found" page that still ships a few thousand characters of nav and footer — Al Jazeera's is
4.3 kB) return `unreachable` instead of a verdict. That's a real distinction for a caller: "this
link doesn't back the claim" and "this link is dead" are different problems.

## Measuring precision (the answer key)

`eval/cases.json` holds 23 link checks whose right answer was set by reading each page:
real support, wrong causes, wrong brands, two company denials, a blocked site, a dead link,
and pages in French and Arabic. `eval/pages/` keeps a saved copy of every page, so results
only change when the code or the model changes, never because a website did.

```bash
npm run eval                                  # both modes side by side
npm run eval -- --mode passages               # just the current behaviour
npm run eval -- --model gemini-3.8-flash      # try another model
npm run eval -- --only bbc                    # only cases whose id contains "bbc"
npm run eval:snapshot                         # save pages for newly added cases
```

Run it after **any** change to a prompt, a model, or the scoring. The column to watch is
**FALSE verified**: a link reported as proof when it isn't is the worst error a fact-checker
can make. It must stay at 0.

To add a case, append to `cases.json` (`url`, `product`, `cause`, `ideal`, `accept`, `why`),
run `npm run eval:snapshot`, then read the saved page before trusting your expected answer.

Results on 2026-10-06 with `gemini-3.5-flash-lite`: 23/23 correct, 22/23 exact, 0 false verified.

### Brand check

`eval/brands.json` holds 15 brands with the expected status and, for each saved search result,
whether its text is about a boycott **of that brand** (at any date). It covers real current
boycotts, boycotts that are over (Bud Light, Puma), weak social-media-only signals (Toyota, Nike),
a brand that is the boycotter rather than the target (Lego), a made-up brand, and spelling variants.

```bash
npm run eval:brands
npm run eval:brands:snapshot -- --show   # save searches for new brands, and print them to label
```

The columns to watch: **FALSE active boycott** (accusing a brand without current evidence, must
stay 0) and **listed sources not about this brand's boycott** (what a visitor would be shown).

| | Before (2026-10-06) | After |
|---|---|---|
| Correct status | 11/15 | 15/15 |
| False "active boycott" | 4 | 0 |
| Listed sources not about the brand's boycott | 28/73 * | 0/63 |
| Avg confidence, real boycott vs. none | 84 vs. 48 | 81 vs. 7 |
| Spelling variants share an answer | no | yes |

\* Measured with the first version of the source labels, which were later corrected after reading
each result's full text. Not strictly comparable, but the main cause is clear: the old version
listed every search result as a source when the model cited none (all 8 for the made-up brand).

### Basic vs advanced (Tavily depth)

Both answer keys can run on snapshots taken at either depth (`--depth basic`):

| | Advanced | Basic |
|---|---|---|
| Page extraction (15 test pages) | — | **identical text on all 15**, half the price → default is `basic` |
| Brand search: correct status | 15/15 | 13/15, misses Carrefour and Tesla (results mostly off-topic) |
| Brand search: avg confidence on real boycotts | 81 | 57 |

So search stays `advanced` (2 credits) and extraction is `basic` (1 credit).

## Tuning

- **Domain credibility tiers** — the `MAJOR_NEWS` / `NGO_WATCHDOG` / … arrays in
  `src/agents/verify-link.js`. Add the outlets your audience actually reads.
- **Score weights** — `scoreAndAssemble` in each agent file.
- **Search wording** — `normalizeInput` in `boycott-check.js` (add a language or region).

## Deploying

See [`../DEPLOY.md`](../DEPLOY.md): any Linux VM with Docker, automatic HTTPS, one key per website.

The daily refresher (n8n workflow 2) has no Node equivalent yet. A cron job calling
`/v1/boycott-check` for stale brands would do the same job.
