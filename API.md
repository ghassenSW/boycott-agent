# Boycott Agent API — integration guide

A REST API that checks consumer boycotts against live web sources:

- **`/v1/boycott-check`**: is this brand the target of a boycott, and why? With sources.
- **`/v1/verify-link`**: does this specific web page actually support "boycott *product* because of *cause*"? And how credible is the source?
- **`/v1/brand-report`**: both of the above. It finds the sources for a brand, then audits each one.

Every number in a response is computed by code from what was found. The language model only reads
the pages and classifies them, and every quote it returns is checked to appear word for word on the
page. Answers are in English.

A machine-readable description of everything below is in [`openapi.yaml`](openapi.yaml)
(import it into Postman, Insomnia or Swagger UI).

---

## 1. Basics

| | |
|---|---|
| Base URL | given to you with your key, e.g. `https://api.example.com` |
| Format | JSON in, JSON out (`Content-Type: application/json`) |
| Auth | `Authorization: Bearer <your-key>` on every `/v1/...` request |
| Health | `GET /health` (no key needed) returns `{"ok": true}` |
| Budget left today | `GET /v1/usage` (key needed, free), see section 4 |

> **Call the API from your website's server, never from browser JavaScript.**
> Anything in a web page can be read by visitors, including your key. Your page talks to your
> server, your server talks to this API.

### Timeouts: set at least 120 seconds

Answers come from live searches and a language model, so they take time:

| Request | Typical time |
|---|---|
| Any request already answered in the last days (cached) | under 0.1 s |
| `verify-link`, first time for that link + product + cause | 3–30 s |
| `boycott-check`, first time for that brand | 5–30 s |
| `brand-report` | 10 s – 3 min (grows with `max_sources`) |

Show a loading state in your interface, and use a client timeout of **at least 120 s**
(240 s for `brand-report` with many sources).

### Caching

The API stores every answer. Repeating the same request returns the stored answer instantly
(`"served_from": "cache"`) and costs no quota: 7 days for brands, 30 days for links.

---

## 2. Endpoints

### `POST /v1/verify-link`

Request:

```json
{
  "url": "https://www.bbc.com/news/business-66398296",
  "product": "Bud Light",
  "cause": "partnership with transgender influencer Dylan Mulvaney"
}
```

Response:

```json
{
  "url": "https://www.bbc.com/news/business-66398296",
  "product": "Bud Light",
  "cause": "partnership with transgender influencer Dylan Mulvaney",
  "verdict": "verified",
  "support_strength": 90,
  "credibility": 70,
  "summary": "One neutral sentence on what the page says about the product and the cause.",
  "evidence": ["Quote copied word for word from the page"],
  "checked_at": "2026-10-06T18:19:07.603Z",
  "served_from": "live"
}
```

| Field | Meaning |
|---|---|
| `verdict` | `verified`: the page clearly links this product to this cause. `weak_support`: it does, but weakly or in passing. `unrelated`: it doesn't (this includes a page about a boycott for a *different* reason). `contradicts_claim`: the page explicitly denies or debunks the claim. `unreachable`: the page couldn't be read (dead link, paywall, blocked site). That says nothing about the claim itself. |
| `support_strength` | 0–100: how strongly **this page** supports **this product + this cause**. |
| `credibility` | 0–100: how much the source itself is worth (type of site, named author, date, length…). Independent of the claim. |
| `evidence` | Up to 3 quotes from the page, verified to appear on it word for word. |
| `summary` | For `unreachable`, the reason the page couldn't be read. |

Pages in French and Arabic work. `product` and `cause` can be written in English.

### `POST /v1/boycott-check`

Request: `{ "brand": "Nike" }`

Response:

```json
{
  "brand": "Adidas",
  "status": "active_boycott",
  "confidence": 100,
  "reason": "Short neutral summary of why people are boycotting now.",
  "sources": [
    { "title": "…", "url": "https://…", "date": "Sun, 06 Sep 2026 18:56:25 GMT", "timing": "current" }
  ],
  "checked_at": "2026-10-06T18:19:19.549Z",
  "served_from": "live"
}
```

| Field | Meaning |
|---|---|
| `status` | `active_boycott`: at least two independent, non-social-media sites describe a **current** boycott of this brand. `unclear`: some current signs (e.g. only social-media posts) or undated ones. `no_evidence`: nothing current; this includes boycotts that only happened in the past. |
| `confidence` | 0–100: how strongly the evidence shows an active boycott **exists**, from how much current evidence there is, how recent it is, and how many independent sites report it. It is **not** the share of people boycotting. It always matches the status: `no_evidence` 0–10, `unclear` up to 45, `active_boycott` 50–100. |
| `reason` | Why people boycott the brand **now**. When only past boycotts were found, it says so. |
| `sources` | Only results that are actually about a boycott **of this brand**, current ones first. `timing` is `current`, `past` or `unclear`. Can be empty. Show them to your users. |

Spelling doesn't matter: "McDonald's", "McDonalds" and "mcdonalds" are the same brand.

### `POST /v1/brand-report`

Request: `{ "brand": "Starbucks", "max_sources": 3 }`. `max_sources` is optional: 3 by default, 8 at most.

Response:

```json
{
  "brand": "Starbucks",
  "status": "active_boycott",
  "confidence": 100,
  "reason": "…",
  "evidence_score": 31,
  "sources_checked": 2,
  "sources_verified": 1,
  "sources": [
    { "url": "https://…", "title": "…", "verdict": "verified", "support_strength": 85, "credibility": 70 }
  ],
  "checked_at": "2026-10-06T18:19:21.062Z"
}
```

`evidence_score` (0–100) measures how well the sources hold up once audited one by one. Comparing
it with `confidence` is the useful part: **high confidence with a low evidence score** means plenty
of coverage but little that survives checking.

### More detail

Add `"detail": true` to any request body (or `?detail=1` to the URL) to get every stored field:
how each score was built, which quotes were rejected, the content type of the page, etc.

---

## 3. Errors

Every error has the same shape: `{ "error": "human-readable message", "type": "…" }`.

| HTTP | `type` | What to do |
|---|---|---|
| 400 | `BadRequest` | The request is wrong (missing field, invalid URL, invalid JSON). The message says what. Don't retry as-is. |
| 401 | `Unauthorized` | Missing or wrong key. |
| 404 | `NotFound` | Wrong path. The response lists the valid ones. |
| 429 | `RateLimited` | Usage limit reached. Wait the number of seconds in the `Retry-After` header. |
| 502 | `UpstreamError` | The search service or the language model is temporarily unavailable (common on free tiers at busy hours). Retry in a few minutes. |
| 503 | `BudgetExceeded` | The service's shared daily research budget is used up. Brands and links **already checked still answer normally**; new checks resume after midnight UTC (`Retry-After` gives the seconds). Show it as "new checks are paused until tomorrow". |
| 500 | `InternalError` | Unexpected problem. Retrying later is fine; report it if it persists. |

## 4. Usage limits

Each key has a budget of **units**, by default 20 per minute and 300 per day:

| Request | Units |
|---|---|
| `verify-link`, `boycott-check` | 1 |
| `brand-report` | 1 + `max_sources` (default: 4) |

Every successful response says where you stand:
`X-Units-Used`, `X-Units-Remaining-Minute`, `X-Units-Remaining-Day`.

### The shared daily budget

On top of your key's limits, the service runs on free research plans with a **daily budget
shared by every website**. When it's used up, new checks get `503 BudgetExceeded` until midnight
UTC, while anything already checked keeps answering from the cache. `GET /v1/usage` (your key,
costs nothing) shows what's left today:

```json
{
  "tavily_credits": { "today": { "used": 12, "limit": 30, "remaining": 18 },
                      "this_month": { "used": 310, "limit": 950, "remaining": 640 } },
  "llm_calls": { "today": { "used": 14, "limit": 400, "remaining": 386 } },
  "resets": { "daily": "midnight UTC", "monthly": "first day of the month UTC" }
}
```

A new brand check uses 2 credits, a new link check 1, a brand report up to 2 + `max_sources`.
Cached answers use none, so popular brands cost almost nothing after their first check.

---

## 5. Examples (server side)

### curl

```bash
curl -X POST https://api.example.com/v1/verify-link \
  -H "Authorization: Bearer $BOYCOTT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.bbc.com/news/business-66398296","product":"Bud Light","cause":"partnership with Dylan Mulvaney"}'
```

### Node.js (18+)

```js
async function verifyLink({ url, product, cause }) {
  const res = await fetch(`${process.env.BOYCOTT_API_URL}/v1/verify-link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BOYCOTT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, product, cause }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${data.type}: ${data.error}`);
  return data;
}
```

### PHP

```php
function boycott_verify_link(string $url, string $product, string $cause): array {
    $ch = curl_init(getenv('BOYCOTT_API_URL') . '/v1/verify-link');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . getenv('BOYCOTT_API_KEY'),
            'Content-Type: application/json',
        ],
        CURLOPT_POSTFIELDS => json_encode(compact('url', 'product', 'cause')),
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $data = json_decode($body ?: '{}', true);
    if ($status !== 200) {
        throw new RuntimeException("$status {$data['type']}: {$data['error']}");
    }
    return $data;
}
```

### Python

```python
import os, requests

def verify_link(url: str, product: str, cause: str) -> dict:
    res = requests.post(
        f"{os.environ['BOYCOTT_API_URL']}/v1/verify-link",
        headers={"Authorization": f"Bearer {os.environ['BOYCOTT_API_KEY']}"},
        json={"url": url, "product": product, "cause": cause},
        timeout=120,
    )
    data = res.json()
    if not res.ok:
        raise RuntimeError(f"{res.status_code} {data['type']}: {data['error']}")
    return data
```

---

## 6. Showing results to your visitors

- **Always show the sources** (`sources`, `evidence`) next to a score, so visitors can check for themselves.
- **Describe what the scores measure**: the evidence found online at a given date, not the truth of the claim or the morality of the boycott. For example: *"Based on 4 sources found on 6 Oct 2026. Confidence reflects how much evidence exists, not how many people are boycotting."*
- **Show the date** (`checked_at`).
- **Treat `unreachable` as "couldn't check"**, never as "false".
- **Handle 429, 502 and 503 kindly** ("the service is busy, try again later"), not as a broken page.
  Never present them as a result about the brand.

## 7. Known limitations

- Answers (`reason`, `summary`) are in English.
- `boycott-check` searches the web in English. A boycott covered only in French or Arabic media
  can be missed or rated `unclear`. (`verify-link` reads pages in any of the three languages.)
- Both endpoints are measured against answer keys built by hand (23 link cases, 15 brands);
  results are in `server/README.md`. They're a good check, not a guarantee: keep showing sources.
- Usage counters reset when the API restarts.
- Free Gemini models are sometimes overloaded; the API then falls back to lighter models
  automatically, and returns `502` only if all of them are busy.
