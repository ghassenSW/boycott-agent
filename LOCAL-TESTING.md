# Running & testing locally (Docker)

> **This guide is for the old n8n version.** n8n no longer starts by default; to run it, use
> `docker compose --profile n8n up -d`. For the API, see [`server/README.md`](server/README.md).

## 0. Prerequisites
- Docker Desktop running.
- Files in this folder: `docker-compose.yml`, `.env`, `schema.sql`, the two `workflow-*.json`.

## 1. Fill in `.env`
Open [.env](.env) and set real values:
- `POSTGRES_PASSWORD` — any strong password.
- `TAVILY_API_KEY` — from tavily.com.
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — your provider (see examples in the file).

> If your LLM runs **on your own PC** (Ollama / LM Studio), use
> `LLM_BASE_URL=http://host.docker.internal:11434/v1` — inside Docker, `host.docker.internal`
> means "my host machine". `localhost` inside the container would point at the container itself.

## 2. Start everything
From this folder, in PowerShell:
```powershell
docker compose up -d
```
- Postgres starts and **auto-runs `schema.sql`** (creates the `brand_boycott_status` table).
- n8n starts at **http://localhost:5678**.

Check they're healthy:
```powershell
docker compose ps
```

## 3. Open n8n and import the workflows
1. Go to **http://localhost:5678** (create the local owner account on first run).
2. **Import from File** → `workflow-1-live-lookup.json`. Repeat for `workflow-2-refresher.json`.

## 4. Add the Postgres credential (once)
Open the **"Cache Lookup"** node → credential dropdown → **Create New** → enter:

| Field | Value |
|---|---|
| Host | `postgres` |
| Port | `5432` |
| Database | `boycott` (your `POSTGRES_DB`) |
| User | `boycott` (your `POSTGRES_USER`) |
| Password | your `POSTGRES_PASSWORD` |
| SSL | disable |

> Host is `postgres` (the compose service name), **not** `localhost` — the two containers talk over
> Docker's internal network.

Save, then select this **same credential** on the other Postgres nodes: **"Upsert Status"** (workflow 1)
and **"Select Stale Brands"** + **"Upsert Status"** (workflow 2).

## 5. Test workflow 1 — two ways

**A) Manual test in the editor (easiest to debug):**
1. Open workflow 1, click **"Test workflow"** (bottom bar) — this arms the *test* webhook.
2. In a new PowerShell window:
```powershell
Invoke-RestMethod -Uri "http://localhost:5678/webhook-test/boycott-check" `
  -Method Post -ContentType "application/json" `
  -Body '{"brand":"Nike"}'
```
3. Watch each node light up in n8n; click any node to see its data. Great for spotting where something breaks.

**B) Production (after you toggle the workflow to Active):**
```powershell
Invoke-RestMethod -Uri "http://localhost:5678/webhook/boycott-check" `
  -Method Post -ContentType "application/json" `
  -Body '{"brand":"Coca-Cola"}'
```
Note: `/webhook-test/...` = test mode (must click Test each time). `/webhook/...` = active workflow.

Expected result: JSON with `status`, `confidence`, `reason`, `sources`, `notes`.

## 6. Verify it saved to Postgres
```powershell
docker exec -it boycott-postgres psql -U boycott -d boycott -c "SELECT brand_name, status, confidence, last_checked FROM brand_boycott_status;"
```
You should see the brands you queried. The **second** time you query the same brand within 7 days,
the response comes back instantly with `"served_from": "cache"`.

## 7. Test workflow 2 (refresher)
It only refreshes brands already in the table, so run a couple of workflow-1 lookups first.
Then open workflow 2 and click **"Test workflow"** (or wait for the 03:00 schedule once Active).
Watch it loop over the stale brands and update them.

---

## Troubleshooting
| Symptom | Fix |
|---|---|
| `ECONNREFUSED postgres:5432` | DB not ready yet, or credential host isn't `postgres`. `docker compose ps` to confirm healthy. |
| Tavily 401 | `TAVILY_API_KEY` wrong/missing. `docker compose restart n8n` after editing `.env`. |
| LLM 401 / 404 | Check `LLM_BASE_URL` (must end in `/v1`), key, and model id. |
| Env var empty in a node | You edited `.env` after starting — run `docker compose up -d` again to reload it. |
| Can't reach local Ollama | Use `http://host.docker.internal:11434/v1`, not `localhost`. |

## Useful commands
```powershell
docker compose logs -f n8n        # watch n8n logs
docker compose restart n8n        # reload after .env changes
docker compose down               # stop (keeps data)
docker compose down -v            # stop AND wipe DB/n8n data (fresh start)
```
