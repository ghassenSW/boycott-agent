# Putting the API online for free: Render + Neon

No server to manage, no domain, no credit card. The result: the API at
`https://boycott-agent.onrender.com` (or a close variant), with HTTPS included.

| | Render (runs the API) | Neon (the database) |
|---|---|---|
| Cost | Free, no card | Free, no card |
| Limits | 512 MB RAM, 750 hours/month, **sleeps after 15 min without requests** (~1 min to wake) | 1 GB, 100 compute-hours/month, pauses after 5 min idle (wakes in under a second) |

Why Neon and not Render's own database: Render's free Postgres is **deleted after 30 days**.

Prices and limits checked in October 2026; free plans change, so glance at both sites' pricing pages.

---

## 1. Create the database on Neon (5 min)

1. Go to https://neon.tech and sign up (the "Continue with GitHub" button is quickest).
2. Create a project:
   - Name: `boycott-agent`
   - Region: **AWS Europe Central (Frankfurt)**, the same city as the Render service, so they talk fast.
3. Open **Connect** on the project dashboard and copy the **connection string**. It looks like:

   ```
   postgresql://neondb_owner:xxxxxxxx@ep-something-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```

   Keep it for step 3. It contains a password: don't paste it anywhere public.

You don't need to create tables: the API creates them itself on its first start.

## 2. Make a production API key (1 min)

Don't reuse the `local-test` key from your PC. On your PC:

```bash
cd "C:\Users\ghass\OneDrive\Desktop\Boycott agent\server"
npm run new-key
```

Copy the printed key and write it as `name:key`, for example `my-website:Xy3...`.
That's the value of `API_KEYS` in step 3, and what the website's developer will use.

## 3. Create the API on Render (10 min)

1. Go to https://render.com and sign up **with GitHub**. Allow Render to access the
   `boycott-agent` repository.
2. Click **New +** → **Blueprint**, and pick the `boycott-agent` repository.
3. Render reads `render.yaml` and shows a service called `boycott-agent` (free plan, Frankfurt).
   It asks for 4 secret values:

   | Variable | What to paste |
   |---|---|
   | `DATABASE_URL` | The Neon connection string from step 1 |
   | `TAVILY_API_KEY` | The `TAVILY_API_KEY` value from your local `.env` |
   | `LLM_API_KEY` | The `LLM_API_KEY` value from your local `.env` |
   | `API_KEYS` | The `name:key` from step 2 |

4. Click **Apply** (or **Deploy Blueprint**). The first build takes about 3 to 6 minutes.
   In the service's **Logs** tab, success looks like:

   ```
   Boycott Agent API on http://localhost:10000
   ...
   Tavily reports NN credits used this billing month
   ```

5. The service page shows its address, e.g. `https://boycott-agent.onrender.com`.

## 4. Check it works

In a browser:

- `https://boycott-agent.onrender.com/ping` → `{"ok":true}`
- `https://boycott-agent.onrender.com/health` → `{"ok":true,...}` (this one also checks Neon)

In Postman, open the collection's **Variables**: set `baseUrl` to your Render address and
`apiKey` to the production key, then run the collection.

## 5. Keep it awake (recommended, free)

Without traffic for 15 minutes, Render puts the API to sleep and the next request waits about
a minute. To avoid it, have a free scheduler call `/ping` every 10 minutes:

1. Sign up at https://cron-job.org (free, no card).
2. Create a cron job: URL `https://boycott-agent.onrender.com/ping`, every 10 minutes.

Use `/ping`, **not** `/health`: `/ping` never touches the database, so Neon can still pause and
keep its free compute hours. This is common practice, but check Render's terms of use from time
to time in case they change their stance on it.

If you skip this step, everything still works: the first visitor after a quiet period just waits
about a minute (the integration guide tells developers to allow 120 s).

## Updating

Push to GitHub. Render rebuilds and redeploys on its own (a few minutes):

```bash
git add <the files you changed>
git commit -m "what changed"
git push
```

## Day-to-day

| What | Where |
|---|---|
| Logs (one line per request) | Render → your service → **Logs** |
| Budget left today | `GET /v1/usage` with your key |
| Neon compute hours used (100/month) | Neon → project → **Monitoring** / usage |
| Add a website | Render → service → **Environment** → edit `API_KEYS` (`site-one:key1,site-two:key2`) → save; Render restarts the API |
| Change a limit | Same place, e.g. `TAVILY_DAILY_CREDITS` |

## Backups

Neon keeps a short restore history on the free plan. For a copy on your PC (needs Docker):

```bash
docker run --rm postgres:16 pg_dump "PASTE_THE_NEON_CONNECTION_STRING" > backup.sql
```

Losing the database isn't fatal: answers are recomputed on the next request. You'd only lose
the cache and spend credits rebuilding it.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| Build fails | Open the build log: it names the step that failed. If it looks temporary (network, registry), use **Manual Deploy → Deploy latest commit** |
| Log says `Could not reach Postgres` | `DATABASE_URL` is wrong or incomplete: paste the whole Neon string again |
| Log says `Missing required environment variables` | One of the 4 secrets is empty |
| `401` | Wrong key in `Authorization: Bearer ...` |
| `503 BudgetExceeded` | The day's research budget is spent; cached answers still work. See `TAVILY_DAILY_CREDITS` |
| First request takes ~1 minute | The API was asleep. Set up step 5 |
