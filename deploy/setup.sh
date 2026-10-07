#!/usr/bin/env bash
# One-time setup of the Boycott Agent API on a Linux server that already hosts a website.
#
#   bash deploy/setup.sh              create .env (asks for the 2 service keys), build, start, test
#   bash deploy/setup.sh --no-start   only create .env
#
# The API ends up reachable ONLY from this server, at http://127.0.0.1:3100 by default.
# Safe to run again: an existing .env is never overwritten.

set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Letters and digits only, so the value never needs quoting anywhere.
# (cut reads all its input, so nothing in the pipe dies early, which pipefail would treat as an error.)
random() { head -c 2048 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c "1-$1"; }

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    [[ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]]
  elif command -v netstat >/dev/null 2>&1; then
    [[ -n "$(netstat -ltn 2>/dev/null | awk -v p="[:.]$1\$" '$4 ~ p')" ]]
  else
    return 1
  fi
}

NO_START=false
[[ "${1:-}" == "--no-start" ]] && NO_START=true

# ---------------------------------------------------------------- 1. requirements
say "1/4  Checking requirements"
if $NO_START; then
  ok "skipped (--no-start)"
else
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || fail "'docker compose' is missing. Install the Docker Compose plugin."
  docker info >/dev/null 2>&1 || fail "Can't talk to Docker. Run this script with sudo, or add your user to the 'docker' group."
  ok "Docker $(docker version --format '{{.Server.Version}}') with Compose $(docker compose version --short)"
fi

# ---------------------------------------------------------------- 2. .env
say "2/4  Configuration (.env)"
if [[ -f .env ]]; then
  ok ".env already exists, keeping it as is"
else
  API_PORT="${API_PORT:-3100}"
  if port_in_use "$API_PORT"; then
    fail "Port $API_PORT is already used on this server. Re-run with another one, e.g.:  API_PORT=3200 bash deploy/setup.sh"
  fi

  # The two service keys come from the project owner. They can also be passed as
  # environment variables (TAVILY_API_KEY=... LLM_API_KEY=... bash deploy/setup.sh).
  if [[ -z "${TAVILY_API_KEY:-}" ]]; then
    read -rsp "  Paste the Tavily key (starts with tvly-), then Enter: " TAVILY_API_KEY; echo
  fi
  if [[ -z "${LLM_API_KEY:-}" ]]; then
    read -rsp "  Paste the Gemini key, then Enter: " LLM_API_KEY; echo
  fi
  [[ -n "$TAVILY_API_KEY" ]] || fail "The Tavily key is empty."
  [[ -n "$LLM_API_KEY" ]] || fail "The Gemini key is empty."

  WEBSITE_KEY="$(random 40)"
  umask 077   # .env is readable by its owner only
  cat > .env <<EOF
# Created by deploy/setup.sh on $(date -u +%F). Keep this file private: it holds keys.

# Use the server version of the Docker setup for every "docker compose" command.
COMPOSE_FILE=docker-compose.yml:docker-compose.server.yml
# The API listens on 127.0.0.1:API_PORT (reachable from this server only).
API_PORT=${API_PORT}

# Database (lives in a Docker volume; never exposed)
POSTGRES_USER=boycott
POSTGRES_DB=boycott
POSTGRES_PASSWORD=$(random 32)

# Services the API uses
TAVILY_API_KEY=${TAVILY_API_KEY}
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_API_KEY=${LLM_API_KEY}
LLM_MODEL=gemini-3.8-flash
LLM_FALLBACK_MODELS=gemini-3.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest
LLM_MAX_CONCURRENCY=2

# Who may call the API: one name:key pair per website (comma-separated).
API_KEYS=website:${WEBSITE_KEY}
RATE_LIMIT_PER_MINUTE=20
RATE_LIMIT_PER_DAY=300

# Shared daily budget, so the free Tavily plan (1000 credits/month) is never exceeded.
TAVILY_SEARCH_DEPTH=advanced
TAVILY_EXTRACT_DEPTH=basic
TAVILY_DAILY_CREDITS=30
TAVILY_MONTHLY_CREDITS=950
LLM_DAILY_CALLS=400
EOF
  ok ".env created (database password and website key generated)"
fi

if $NO_START; then
  say "Done (--no-start). Start later with:  docker compose up -d --build"
  exit 0
fi

# ---------------------------------------------------------------- 3. build & start
say "3/4  Building and starting (the first build takes a few minutes)"
docker compose up -d --build

printf '  waiting for the API'
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Health.Status}}' boycott-api 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  printf '.'; sleep 2
done
echo
[[ "${status:-}" == "healthy" ]] || fail "The API didn't become healthy. Look at:  docker compose logs api"
ok "containers running"

# ---------------------------------------------------------------- 4. test
say "4/4  Testing"
API_PORT="$(grep -E '^API_PORT=' .env | cut -d= -f2)"
WEBSITE_KEY="$(grep -E '^API_KEYS=' .env | cut -d= -f2 | cut -d, -f1 | cut -d: -f2-)"
URL="http://127.0.0.1:${API_PORT:-3100}"

# The image has Node, so the test doesn't depend on curl being installed on the server.
health="$(docker exec boycott-api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log).catch(e=>console.log('ERROR '+e.message))")"
[[ "$health" == *'"ok":true'* ]] || fail "Health check failed: $health"
ok "API and database answer: $health"

say "All set."
cat <<EOF

  The API answers on this server at:   ${URL}
  Website key:                         ${WEBSITE_KEY}

  In the website's .env.local (Next.js), add:

      BOYCOTT_API_URL=${URL}
      BOYCOTT_API_KEY=${WEBSITE_KEY}

  (If the website runs in Docker, use BOYCOTT_API_URL=http://boycott-api:3000 instead: see README.)

  Useful commands (run in this folder):
      docker compose ps              status
      docker compose logs -f api     live logs, one line per request
      docker compose up -d           apply changes after editing .env
      bash deploy/backup.sh             back up the database now

EOF
