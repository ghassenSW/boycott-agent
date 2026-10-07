# Boycott Agent API

A small service that answers two questions from **live web sources**:

1. **Is this brand being boycotted right now, and why?** (with the articles it found)
2. **Does this web page really support "boycott X because of Y"?** (with quotes taken from the page)

It runs in Docker next to your website, on the same server. Your website's server calls it; visitors
never talk to it directly. Answers are in English.

```
 Visitor's browser ──► your Next.js site ──► Boycott API (127.0.0.1:3100, on the same server)
                      /api/boycott/check     checks the web, answers in JSON
                      (holds the secret key)
```

**Contents:** [1. Install](#1-install-on-the-server-10-minutes) ·
[2. Add it to the website](#2-add-it-to-the-website-nextjs) ·
[3. Inputs and outputs](#3-inputs-and-outputs) · [4. Errors](#4-errors) ·
[5. Limits](#5-limits-speed-and-daily-budget) · [6. Day-to-day](#6-day-to-day-commands)

---

## 1. Install on the server (10 minutes)

**You need:** Linux with Docker and the Docker Compose plugin
([install guide](https://docs.docker.com/engine/install/)). At rest it uses about 60 MB of RAM in total,
and each of its two containers is capped at 1 CPU and 512 MB, so it can't slow down your site. **Nothing is opened to the internet**,
and nothing on ports 80/443 changes.

**You also need two keys** (Tavily and Gemini): ask Ghassen, he'll send them privately.

```bash
git clone https://github.com/ghassenSW/boycott-agent.git
cd boycott-agent
bash deploy/setup.sh
```

The script:
1. checks Docker;
2. asks you to paste the two keys (they're written only to `.env` on the server, never to GitHub);
3. generates a database password and a **website key**;
4. builds and starts everything, then tests it.

At the end it prints what your website needs:

```
  The API answers on this server at:   http://127.0.0.1:3100
  Website key:                         Xy3k... (40 characters)

  In the website's .env.local (Next.js), add:
      BOYCOTT_API_URL=http://127.0.0.1:3100
      BOYCOTT_API_KEY=Xy3k...
```

Port 3100 already taken? Run `API_PORT=3200 bash deploy/setup.sh` instead.

Check it yourself at any time:

```bash
curl http://127.0.0.1:3100/health        # {"ok":true,...}
```

It restarts on its own after a reboot.

---

## 2. Add it to the website (Next.js)

Ready-made files are in [`examples/nextjs/`](examples/nextjs). Copy them into your project, keeping
the same paths (under `src/` if your project uses a `src` folder). They import each other with the
`@/` alias that `create-next-app` sets up by default.

| File | What it does |
|---|---|
| `lib/boycott.ts` | Talks to the API (server side only), with TypeScript types for every answer |
| `app/api/boycott/check/route.ts` | Your route `POST /api/boycott/check` → brand check |
| `app/api/boycott/verify/route.ts` | Your route `POST /api/boycott/verify` → link check |
| `components/BoycottChecker.tsx` | A search box that shows the result (unstyled, restyle it freely) |

Then:

1. Add the two lines printed by the setup script to `.env.local` (see `.env.local.example`).
2. Put the component on any page:

   ```tsx
   import BoycottChecker from '@/components/BoycottChecker';

   export default function Page() {
     return <BoycottChecker />;
   }
   ```

3. Restart your site. Type a brand, click **Check**.

These files are tested: built with Next.js 16 in strict TypeScript, and run against this API. The
key never reaches the browser (it's not in any file Next.js sends to visitors).

**Using it somewhere else in your code** (a server component, a server action, a cron job):

```ts
import { checkBrand, verifyLink } from '@/lib/boycott';

const result = await checkBrand('Adidas');            // see section 3 for what you get
const link = await verifyLink(url, 'Adidas', 'its advertising campaign');
```

**If your website runs in Docker** (not directly on the server), `127.0.0.1` inside its container
means the container itself. Instead, join the API's Docker network and use its name. In your site's
`docker-compose.yml`:

```yaml
services:
  your-website:
    # ...your existing settings...
    environment:
      BOYCOTT_API_URL: http://boycott-api:3000
      BOYCOTT_API_KEY: ${BOYCOTT_API_KEY}
    networks: [default, boycott-net]

networks:
  boycott-net:
    external: true
```

---

## 3. Inputs and outputs

Every call is a `POST` with a JSON body and the header `Authorization: Bearer <website key>`.
The `lib/boycott.ts` file does this for you. The examples below are **real answers** from this API.

### Brand check: is this brand being boycotted?

`POST /v1/boycott-check`

**You send:**

| Field | Required | Example |
|---|---|---|
| `brand` | yes | `"Adidas"`. Spelling doesn't matter: "McDonald's" = "McDonalds" = "mcdonalds" |

**You get back:**

```json
{
  "brand": "Adidas",
  "status": "active_boycott",
  "confidence": 100,
  "reason": "Adidas is facing calls for a boycott due to an advertising campaign and promotion for its single-shoe service that featured a former Israeli soldier who lost his leg while serving in the military.",
  "sources": [
    {
      "title": "Adidas faces boycott calls over promotion featuring ex-IDF soldier who lost leg in 2021",
      "url": "https://www.timesofisrael.com/adidas-faces-boycott-over-promotion-featuring-ex-idf-soldier-who-lost-leg-in-2021",
      "date": "Sun, 06 Sep 2026 08:42:15 GMT",
      "timing": "current"
    },
    {
      "title": "Adidas faces global boycott calls for campaign featuring former Israeli soldier",
      "url": "https://www.aa.com.tr/en/world/adidas-faces-global-boycott-calls-for-campaign-featuring-former-israeli-soldier/4051406",
      "date": "Tue, 08 Sep 2026 22:43:00 GMT",
      "timing": "current"
    }
  ],
  "checked_at": "2026-10-07T02:25:29.438Z",
  "served_from": "live"
}
```

**How to read it:**

| Field | Meaning |
|---|---|
| `status` | **`active_boycott`**: at least two independent news or campaign sites (not just social media) report a current boycott. **`unclear`**: some signs, but weak (e.g. only social-media posts). **`no_evidence`**: nothing current. Old boycotts that are over count as `no_evidence`. |
| `confidence` | 0 to 100: how strong the evidence is that a boycott exists. Always in line with `status`: `no_evidence` 0–10, `unclear` up to 45, `active_boycott` 50–100. **Not** the share of people boycotting. |
| `reason` | Why people are boycotting it now, in one or two sentences. Empty when nothing was found. |
| `sources` | The articles the answer is based on, current ones first. `timing` is `current`, `past` or `unclear`. Can be empty. **Show them to visitors.** |
| `checked_at` | When the web was checked. |
| `served_from` | `live` (just checked) or `cache` (an answer from the last 7 days, instant and free). |

### Link check: does this page really support the claim?

`POST /v1/verify-link`

**You send:**

| Field | Required | Example |
|---|---|---|
| `url` | yes | `"https://www.aljazeera.com/sports/2026/9/6/adidas-faces-boycott-calls-over-campaign-featuring-former-israeli-soldier"` |
| `product` | yes | `"Adidas"` |
| `cause` | yes | `"advertising campaign featuring a former Israeli soldier"` |

**You get back:**

```json
{
  "url": "https://www.aljazeera.com/sports/2026/9/6/adidas-faces-boycott-calls-over-campaign-featuring-former-israeli-soldier",
  "product": "Adidas",
  "cause": "advertising campaign featuring a former Israeli soldier",
  "verdict": "verified",
  "support_strength": 90,
  "credibility": 59,
  "summary": "The article reports that Adidas is facing calls for a boycott due to an advertising campaign featuring a former Israeli soldier.",
  "evidence": [
    "Adidas faces boycott calls over campaign featuring former Israeli soldier",
    "Sportswear giant Adidas has faced criticism and calls for a boycott for featuring a former Israeli army soldier"
  ],
  "checked_at": "2026-10-07T02:26:33.048Z",
  "served_from": "live"
}
```

Same page, but with a cause it doesn't talk about (`"cause": "child labour in its factories"`):

```json
{
  "verdict": "unrelated",
  "support_strength": 5,
  "credibility": 59,
  "summary": "The page reports on boycott calls against Adidas due to an advertising campaign featuring a former Israeli soldier, not because of child labour in its factories."
}
```

**How to read it:**

| Field | Meaning |
|---|---|
| `verdict` | **`verified`**: the page clearly links this product to this cause. **`weak_support`**: it does, but weakly or in passing. **`unrelated`**: it doesn't (including a page about a boycott for a *different* reason). **`contradicts_claim`**: the page says the claim is false (e.g. a company denial). **`unreachable`**: the page couldn't be read (dead link, paywall, blocked site). That says nothing about the claim itself. |
| `support_strength` | 0 to 100: how strongly **this page** supports **this product + this cause**. |
| `credibility` | 0 to 100: how trustworthy the **source** is (type of site, author, date…). Doesn't depend on the claim. |
| `summary` | One neutral sentence about what the page says. For `unreachable`, why it couldn't be read. |
| `evidence` | Up to 3 quotes, checked to appear **word for word** on the page. |

Pages in English, French and Arabic work.

### Brand report: both at once (slow)

`POST /v1/brand-report` with `{ "brand": "Adidas", "max_sources": 2 }` (`max_sources`: 1 to 8, default 3).

It runs the brand check, then checks each source like a link check:

```json
{
  "brand": "Adidas",
  "status": "active_boycott",
  "confidence": 100,
  "reason": "Adidas is facing calls for a boycott due to an advertising campaign...",
  "evidence_score": 42,
  "sources_checked": 2,
  "sources_verified": 2,
  "sources": [
    { "url": "https://www.timesofisrael.com/...", "title": "Adidas faces boycott calls over promotion featuring ex-IDF soldier who lost leg in 2021",
      "verdict": "verified", "support_strength": 90, "credibility": 55 },
    { "url": "https://www.aa.com.tr/...", "title": "Adidas faces global boycott calls for campaign featuring former Israeli soldier",
      "verdict": "verified", "support_strength": 90, "credibility": 39 }
  ],
  "checked_at": "2026-10-07T02:26:44.023Z"
}
```

`evidence_score` (0–100) says how well the sources hold up once checked one by one. It costs more of
the daily budget (section 5), so it's better suited to an admin page than to a public search box.

### Extra detail

Add `"detail": true` to any request body to get every stored field (how each score was built,
rejected quotes, etc.). The full reference is in [`API.md`](API.md), and in machine-readable form in
[`openapi.yaml`](openapi.yaml).

---

## 4. Errors

Every error has the same shape:

```json
{ "error": "\"url\" does not look like a valid URL (expected http://… or https://…): not-a-link", "type": "BadRequest" }
```

| HTTP | `type` | Meaning | What to show visitors |
|---|---|---|---|
| 400 | `BadRequest` | A field is missing or invalid | The `error` message |
| 401 | `Unauthorized` | Wrong or missing website key | (your config: check `.env.local`) |
| 429 | `RateLimited` | Too many requests for this key in a minute or a day | "Busy, try again in a minute" |
| 502 | `UpstreamError` | The search or AI service is temporarily overloaded | "Busy, try again in a minute" |
| 503 | `BudgetExceeded` | The shared daily budget is used up (section 5) | "New checks resume tomorrow" |

`friendlyMessage()` in `lib/boycott.ts` already turns each of these into a sentence for visitors.
Never show an error as if it were a result about the brand.

---

## 5. Limits, speed and daily budget

| | |
|---|---|
| Speed | 5–30 s the first time a brand or link is checked (it searches the web); **instant afterwards** (cached 7 days for brands, 30 days for links). The very first request after a restart can take up to a minute. Your code should wait at least **120 s**. |
| Daily budget | The free plans behind it allow about **15 new brands or 30 new links per day**, shared by everyone. Cached answers cost nothing. When it's used up, new checks get `503` until midnight UTC (1 a.m. in Tunisia), and everything already checked keeps working. |
| Per key | 20 units per minute and 300 per day (a check = 1 unit, a brand report = 1 + `max_sources`). |

See what's left today:

```bash
curl -H "Authorization: Bearer <website key>" http://127.0.0.1:3100/v1/usage
```

All limits are in `.env` (`TAVILY_DAILY_CREDITS`, `RATE_LIMIT_PER_MINUTE`, ...). After editing it, run
`docker compose up -d` to apply.

---

## 6. Day-to-day commands

Run them in the `boycott-agent` folder.

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Live logs (one line per request) | `docker compose logs -f api` |
| Update to the latest version | `git pull && docker compose up -d --build` |
| Apply a change made in `.env` | `docker compose up -d` (`restart` does **not** reload `.env`) |
| Restart | `docker compose restart api` |
| Stop / start | `docker compose down` / `docker compose up -d` (data is kept) |
| Back up the database now | `bash deploy/backup.sh` (saved in `backups/`, keeps 7 days) |
| Back up every night at 3:00 | `crontab -e`, then add: `0 3 * * * bash /full/path/to/boycott-agent/deploy/backup.sh >> /full/path/to/boycott-agent/backups/backup.log 2>&1` |
| Give another website access | Add `,othersite:<new key>` to `API_KEYS` in `.env`, then `docker compose up -d`. New key: `head -c 2048 /dev/urandom \| tr -dc A-Za-z0-9 \| cut -c1-40` |

Losing the database isn't serious: answers are simply recomputed on the next request.

---

## What's in this repository

| Path | What it is |
|---|---|
| `server/` | The API itself (Node.js). How it works inside: [`server/README.md`](server/README.md) |
| `deploy/` | `setup.sh` (installation) and `backup.sh` |
| `docker-compose.yml` + `docker-compose.server.yml` | The Docker setup; `setup.sh` makes the server version the default |
| `examples/nextjs/` | The files to copy into the website |
| `API.md`, `openapi.yaml` | Full API reference |
| `postman/` | A Postman collection to try every endpoint |
| `DEPLOY-RENDER.md`, `DEPLOY.md` | Other ways to host it (free cloud, or a server of its own with HTTPS) |
| `docs/original-design.md`, `workflow-*.json` | Project history: the original n8n version |
