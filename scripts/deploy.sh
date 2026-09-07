#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-prod}"

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy.sh [prod|tls|update]

  prod   — production stack, web on 127.0.0.1:8080 (external reverse proxy)
  tls    — production + Caddy with automatic HTTPS (ports 80/443)
  update — pull latest code and rebuild (same mode as last deploy; defaults to prod)

Before first deploy:
  1. Copy .env.example to .env (or run ./scripts/setup.sh)
  2. Set PUBLIC_URL=https://your-domain.com
  3. For tls mode: set PUBLIC_HOST=your-domain.com and point DNS to the server

EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "✕ Docker not found. Install: https://docs.docker.com/engine/install/"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "✕ Docker Compose plugin not found."
  exit 1
fi

if [[ "$MODE" == "update" ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    branch="$(git rev-parse --abbrev-ref HEAD)"
    echo "→ git fetch origin/${branch}"
    git fetch origin "$branch"
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "→ discarding local changes before deploy ($(git status --porcelain | wc -l | tr -d ' ') file(s))"
      git reset --hard HEAD
    fi
    echo "→ sync to origin/${branch}"
    git reset --hard "origin/${branch}"
  fi
  MODE="${DEPLOY_MODE:-prod}"
fi

./scripts/setup.sh

# shellcheck disable=SC1091
set -a && source .env && set +a

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

if [[ "$MODE" == "tls" ]]; then
  if [[ -z "${PUBLIC_HOST:-}" ]]; then
    echo "✕ Set PUBLIC_HOST=your.domain.com in .env for tls mode"
    exit 1
  fi
  if [[ -z "${PUBLIC_URL:-}" || "$PUBLIC_URL" == http://localhost* ]]; then
    echo "→ Hint: set PUBLIC_URL=https://${PUBLIC_HOST} in .env"
  fi
  COMPOSE+=(-f docker-compose.tls.yml --profile tls)
elif [[ "$MODE" != "prod" ]]; then
  echo "✕ Unknown mode: $MODE"
  usage
  exit 1
fi

# Build BEFORE stopping anything: set -e aborts here on a failure, leaving the
# running stack untouched. Building after the shutdown once took the site down
# for as long as the fix took — an unreachable registry (a base image that
# isn't cached locally) is enough to fail the build.
echo "→ Building images ($MODE)..."
"${COMPOSE[@]}" build

echo "→ Stopping existing timelog containers..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose -f docker-compose.yml -f docker-compose.prod.yml down --remove-orphans 2>/dev/null || true
if ids=$(docker ps -aq --filter name='^timelog-' 2>/dev/null); then
  [[ -n "$ids" ]] && docker rm -f $ids 2>/dev/null || true
fi

echo "→ Starting ($MODE)..."
"${COMPOSE[@]}" up -d --wait

if docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
  echo "→ Database migrations..."
  ./scripts/migrate-db.sh || echo "  (migration warning — check ./scripts/diagnose.sh)"
fi

echo ""
echo "✓ Deploy complete"
"${COMPOSE[@]}" ps

if [[ "$MODE" == "tls" ]]; then
  echo ""
  echo "→ Health: https://${PUBLIC_HOST}/health"
  curl -sf "https://${PUBLIC_HOST}/health" && echo " ok" || echo " (wait for TLS cert or check DNS)"
else
  PORT="${HTTP_PORT:-8080}"
  BIND="${BIND_ADDRESS:-127.0.0.1}"
  echo ""
  echo "→ Health: http://${BIND}:${PORT}/health"
  curl -sf "http://127.0.0.1:${PORT}/health" && echo " ok" || echo " failed"
  if [[ "$BIND" == "127.0.0.1" ]]; then
    echo "→ NPM in Docker: forward to 172.17.0.1:${PORT} (not 127.0.0.1)"
  fi
  echo "→ Put reverse proxy in front of ${BIND}:${PORT} for HTTPS"
fi
