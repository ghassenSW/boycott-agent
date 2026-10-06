# Deploying the API on a server

Works on any Linux server (VM) where Docker runs, including free-tier cloud VMs.
The result: the API at `https://<your-domain>`, with an automatic HTTPS certificate, and nothing
else reachable from the internet.

## What you need

- **A Linux VM**: 1 GB of RAM is enough (Ubuntu 22.04 or 24.04 recommended). Several cloud
  providers have always-free small VMs; check the current offer and whether it asks for a card
  before signing up, since these change often.
- **A hostname pointing to the VM**, e.g. `api.yoursite.com`: an `A` record in your domain's DNS
  set to the VM's public IP. HTTPS can't work on a bare IP address.
- **Open ports**: 22 (SSH), 80 and 443. In the cloud provider's firewall / security list *and* on
  the VM. Nothing else needs to be open.

## 1. Install Docker on the VM

Follow Docker's official guide for your distribution:
https://docs.docker.com/engine/install/ubuntu/

Check: `docker compose version` prints a version.

## 2. Copy the project to the VM

From your PC (replace user and IP):

```bash
scp -r "Boycott agent" ubuntu@203.0.113.10:~/boycott-agent
```

Leave out `postgres_data`, `n8n_data` and every `node_modules` if they exist; the server builds its own.

## 3. Create the `.env` on the VM

```bash
cd ~/boycott-agent
cp .env.example .env
nano .env
```

Fill in:

- `TAVILY_API_KEY`, `LLM_API_KEY`: the same keys as on your PC.
- `POSTGRES_PASSWORD`: a new long random password. It only takes effect when the database is
  created for the first time, so set it **before** the first start.
- `API_KEYS`: one `name:key` pair per website (see step 6).
- `DOMAIN`: the hostname from "What you need", e.g. `api.yoursite.com`.

## 4. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The first start takes a few minutes (image build plus the HTTPS certificate).

## 5. Check

```bash
curl https://api.yoursite.com/health
# {"ok":true,"uptime_s":...}
```

If it fails: `docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy api`.
The usual cause is DNS not pointing to the VM yet, or port 80/443 closed.

## 6. Give a website access

Generate a key (on any machine with Node, or on the VM inside the container):

```bash
docker exec boycott-api node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Add it to `API_KEYS` in `.env` with a name for that site, comma-separated:

```
API_KEYS=site-one:Xy...,site-two:Ab...
```

Apply (restarts only the API, about 5 s):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Send the site's developer: the URL, their key (privately), and `API.md` + `openapi.yaml`.
To revoke a site, remove its pair and apply again.

## Day-to-day

| Task | Command (from `~/boycott-agent`) |
|---|---|
| Logs (one line per request) | `docker logs -f boycott-api` |
| Usage of one site today | `docker logs boycott-api 2>&1 \| grep " site-one "` |
| Update after copying new code | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` |
| Stop | `docker compose -f docker-compose.yml -f docker-compose.prod.yml down` |

## Backups

All answers live in Postgres. To make a backup:

```bash
docker exec boycott-postgres pg_dump -U boycott boycott | gzip > backup-$(date +%F).sql.gz
```

Copy it off the server. To restore into a fresh install:

```bash
gunzip -c backup-2026-10-06.sql.gz | docker exec -i boycott-postgres psql -U boycott boycott
```

Losing the database isn't fatal: every answer is recomputed on the next request. You'd only lose
the cache and spend quota rebuilding it.

## Free quotas

The API runs on free Tavily (1,000 credits/month) and Gemini plans. Two layers keep it inside them:

- **Global budget** (all websites together, stored in the database): `TAVILY_DAILY_CREDITS=30`,
  `TAVILY_MONTHLY_CREDITS=950`, `LLM_DAILY_CALLS=400`. When it's spent, new checks get
  `503 BudgetExceeded` until midnight UTC, and already-checked brands and links keep answering.
- **Per-key limits** (`RATE_LIMIT_PER_MINUTE` / `_PER_DAY`), so one site can't take the whole budget.

Check what's left at any time:

```bash
curl -H "Authorization: Bearer <a key>" https://api.yoursite.com/v1/usage
```

30 credits a day is about 15 new brands, or 30 new links. Popular brands are cached for 7 days,
so they cost nothing after the first check. If 503s become frequent, either accept the pause or
buy extra Tavily credits (about $0.008 each) and raise the budget.
