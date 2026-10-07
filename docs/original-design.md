# Boycott Agent: original design notes

> **History document.** This describes how the project started: the design reasoning and the
> original n8n workflows (the `workflow-*.json` files at the repo root). The product today is the
> Dockerized REST API described in the [main README](../README.md). The n8n workflows predate the
> API's fixes (page cleaning, passages, model fallback, keys, budget), so the sections below that
> mention `/webhook/...` or port 5679 describe that older version.



An AI agent that takes a **brand name** (e.g. "Coca-Cola", "Nike") and returns a **grounded, sourced
assessment** of whether it currently faces a consumer boycott — with a **confidence score (0–100)** and
**reference links**. Everything is grounded in a live web search (Tavily); nothing is invented from the
model's memory.

## What it outputs

```json
{
  "brand": "Nike",
  "status": "active_boycott",          // active_boycott | no_evidence | unclear
  "confidence": 78,                     // Option A: confidence that an active boycott EXISTS (not a survey %)
  "reason": "Consumer campaigns over ...",
  "sources": [
    { "title": "...", "url": "https://...", "date": "2026-06-30" }
  ],
  "checked_at": "2026-07-10T09:00:00.000Z",
  "served_from": "live"                 // or "cache"
}
```

Send `"detail": true` to also get `who_is_calling`, `recency`, `notes` and `brand_normalized`.
Every field is always stored in Postgres regardless — the trimming is only on the response.

## Architecture

Two workflows share one Postgres table.

**Workflow 1 — Live Lookup API** (`workflow-1-live-lookup.json`)
```
POST /boycott-check {brand}
  → Normalize Input        (lowercase/trim, build search query)
  → Cache Lookup (Postgres) (is this brand already known?)
  → Evaluate Cache          (fresh if checked < 7 days ago?)
  → IF fresh ──► Respond (cached)          ← fast path, no API cost
        else ─► Tavily Search              (live web results — the "eyes")
              → Build LLM Context          (grounding prompt + count sources / recency)
              → LLM Judge                  (reads results → status/reason JSON — the "brain")
              → Compute Score & Assemble   (confidence computed in CODE, not by the model)
              → Upsert Status (Postgres)   (cache the result + build history)
              → Respond (live)
```

**Workflow 2 — Daily Refresher** (`workflow-2-refresher.json`)
```
Every day @ 03:00
  → Select Stale Brands (Postgres, last_checked > 1 day, oldest first, 50/run)
  → Loop Over Brands
       → Build Query → Tavily → Build Context → LLM → Score → Upsert  (same logic)
       ↺ next brand
```
The refresher only re-checks brands **already in the table**. New brands enter the table automatically the
first time someone queries them via the API. So the two workflows feed each other.

## Why the score is trustworthy

The **LLM decides `status` and `reason`** (qualitative judgement).
The **confidence number is computed in a Code node** from real signals — how many sources came back and how
recent they are — using a fixed formula. The model never picks the number, so it's reproducible and can't be
hallucinated. Tune the weights in the `Compute Score & Assemble` node.

---

## Setup

### 1. Database
Run [`schema.sql`](../schema.sql) against your Postgres once.

### 2. n8n credentials
- **Postgres credential** → select it on every Postgres node (Cache Lookup, Upsert, Select Stale Brands).

### 3. Environment variables (set in n8n, then restart)
| Variable | Example | What it is |
|---|---|---|
| `TAVILY_API_KEY` | `tvly-xxxx` | Tavily key — free tier at tavily.com |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL of your provider |
| `LLM_API_KEY` | `sk-xxxx` | Your LLM **API** key (not a chat-app subscription) |
| `LLM_MODEL` | `gpt-4o-mini` | Model id at that provider |

> The LLM call is a generic **OpenAI-compatible** `/chat/completions` request, so it works with OpenAI,
> OpenRouter (`https://openrouter.ai/api/v1`), Groq, Together, Mistral, or a local Ollama/LM Studio
> (`http://localhost:11434/v1`). Just point the three `LLM_*` vars at your provider.
> If your provider is **not** OpenAI-compatible (e.g. raw Gemini or Anthropic), tell me and I'll swap the
> `LLM Judge` node for the right one.

### 4. Import
In n8n: **Import from File** → pick `workflow-1-live-lookup.json`, then `workflow-2-refresher.json`.
Assign the Postgres credential on the Postgres nodes. Activate both.

### 5. Test the API
```bash
curl -X POST https://YOUR-N8N/webhook/boycott-check \
  -H "Content-Type: application/json" \
  -d '{"brand":"Nike"}'
```

---

# Agent 2 — Link Verifier (source auditor)

Where Agent 1 **finds** sources, Agent 2 **audits one**. You give it a link plus the claim it is supposed
to back up, and it reports whether that link actually supports it — and how much the source is worth.

**Input**
```json
{ "url": "https://example.com/article", "product": "Starbucks", "cause": "perceived political stance on the Gaza war" }
```

**Output**
```json
{
  "url": "https://example.com/article",
  "product": "Starbucks",
  "cause": "perceived political stance on the Gaza war",
  "verdict": "verified",            // verified | weak_support | unrelated | contradicts_claim | unreachable
  "support_strength": 85,           // 0-100: how strongly THIS page backs THIS product + THIS cause
  "credibility": 62,                // 0-100: hybrid score for the source itself
  "summary": "One neutral sentence about what the page says.",
  "evidence": ["short verbatim quote from the page"],
  "checked_at": "2026-07-26T09:00:00.000Z",
  "served_from": "live"
}
```

Send `"detail": true` for the full 23-field record — `credibility_base` / `credibility_adjust` /
`credibility_reason`, `mentions_product`, `mentions_cause`, `content_type`, `evidence_dropped`,
`domain`, `content_length`, `available`, `availability_note`, `notes`. All of it is written to
Postgres on every run whether you ask for it or not, so nothing is lost by keeping responses slim.

### Pipeline
```
Input {url, product, cause}
  → Normalize Input        (validate the URL, build the cache key)
  → Cache Lookup           (seen this exact url+product+cause before?)
  → Fresh? ──yes→ Cached Result                       ← 30-day window, pages rarely change
        └──no → Tavily Extract      (pull the page's readable text)
              → Check Availability  (real content? + deterministic credibility base)
              → Available? ──no→ Unavailable Result   ← honest "unreachable", not a fake verdict
                          └─yes→ Build LLM Context    (grounded strictly on this page's text)
                                → LLM Verifier        (supports / partial / unrelated / contradicts)
                                → Score & Assemble    (validate quotes, compute both scores)
                                → Upsert Verification (Postgres)
                                → Result
```

### Three things that make the verdict trustworthy

1. **Quotes are verified against the page.** Every evidence quote the model returns is checked to exist
   verbatim in the extracted text. Invented quotes are dropped and counted in `evidence_dropped`.
2. **The product AND the cause must both be present.** A page about the right brand but the *wrong* cause
   gets capped at 35 support strength; a page that never mentions the brand is capped at 10. This is the
   whole point of the agent — it stops a vaguely-related link from being treated as proof.
3. **Credibility is anchored, not vibes.** A deterministic base (max 70) comes from domain tier, author,
   date, HTTPS and length. The model may only adjust it by ±15. So a page cannot talk its way to a high
   score, and the two components are reported separately for transparency.

### Files
| File | Purpose |
|---|---|
| `schema-verifier.sql` | The `link_verifications` table (run once) |
| `workflow-3-verify-link-TEST.json` | Manual version — type url/product/cause, click Execute |
| `workflow-3-verify-link-API.json` | `POST /verify-link` REST endpoint |
| `workflow-4-brand-report-API.json` | `POST /brand-report` — runs Agent 1, then Agent 2 on each source |

### Test it
```bash
curl -X POST http://localhost:5679/webhook/verify-link \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/article","product":"Starbucks","cause":"political stance"}'
```

### Hooking it into Agent 1 later
Agent 1 already returns a `sources[]` array. To auto-audit them, add an **Execute Workflow** node after
`Compute Score & Assemble` that calls this verifier once per source, then keep only those with
`verdict = "verified"`. The verifier was built standalone precisely so this stays a drop-in step.

---

# The REST API (all three agents, one surface)

Everything is reachable over plain HTTP on the same n8n instance. Import all three workflows and
**activate** them — a webhook only answers on `/webhook/...` while its workflow is active.

| Method | Path | Body | What you get |
|---|---|---|---|
| POST | `/webhook/boycott-check` | `{ "brand": "Nike" }` | Is this brand boycotted? (Agent 1) |
| POST | `/webhook/verify-link` | `{ "url": "...", "product": "...", "cause": "..." }` | Does this one link hold up? (Agent 2) |
| POST | `/webhook/brand-report` | `{ "brand": "Nike", "max_sources": 3 }` | Agent 1 **plus** Agent 2 run on each of its sources |

Base URL locally: `http://localhost:5679`. Add `"detail": true` to any body (or `?detail=1`) for the
full record instead of the slim one.

### `/brand-report` — the combined endpoint

This is "all of it in one call". It runs Agent 1, takes the sources Agent 1 returned, and pushes each
one through Agent 2 — so you learn both *whether a boycott exists* and *whether the evidence for it
survives auditing*.

```
POST /webhook/brand-report {brand, max_sources}
  → Call /boycott-check           (Agent 1, over its own webhook)
  → Explode Sources               (one item per source URL, capped at max_sources)
  → Any Sources? ──no──────────────┐
        └─yes→ Verify Each Source  │  (Agent 2, once per link, 1 at a time / 1.5s apart)
                     ↓             │
              Assemble Report ◄────┘
                     → Respond
```

```json
{
  "brand": "Nike",
  "status": "active_boycott",
  "confidence": 78,          // does a boycott appear to exist?
  "reason": "...",
  "evidence_score": 61,      // do its sources actually hold up? 0-100
  "sources_checked": 3,
  "sources_verified": 2,
  "sources": [
    { "url": "https://...", "verdict": "verified", "support_strength": 85, "credibility": 62 }
  ],
  "checked_at": "2026-07-26T09:00:00.000Z"
}
```

`evidence_score` is computed in code, never by the model: each source is worth
`support_strength × credibility ÷ 100`, and the score is the mean of the best three. A brand can
therefore come back with **high confidence but a low evidence score** — lots of chatter, nothing
that survives an audit. That gap is the most useful thing the API tells you.

**Costs:** one `/brand-report` call = 1 Tavily search + 1 LLM call (Agent 1) + up to `max_sources` ×
(1 Tavily extract + 1 LLM call). Default cap is 3, max 8. Both sub-agents cache, so repeat calls are
mostly free.

**Before exposing the n8n version publicly:** it has no auth. (The Node API has keys; see `API.md`.) Add an API-key check as the first node of each
webhook, or put n8n behind a reverse proxy that requires a header.

```bash
curl -X POST http://localhost:5679/webhook/brand-report -H "Content-Type: application/json" -d '{"brand":"Nike","max_sources":3}'
```

---

## Things you can tune / decide later
- **Freshness window** (currently 7 days) in `Evaluate Cache`.
- **Score weights** in `Compute Score & Assemble`.
- **Search query wording** in `Normalize Input` / `Build Query` (e.g. add language or region).
- **Refresh volume/cadence** in the schedule + `LIMIT 50`.
- Add **rate limiting / an API key check** on the webhook before exposing it publicly.
