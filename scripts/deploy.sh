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
    echo "→ git pull"
    git pull --ff-only
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

echo "→ Building and starting ($MODE)..."
"${COMPOSE[@]}" up -d --build --wait

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
  echo ""
  echo "→ Health: http://127.0.0.1:${PORT}/health"
  curl -sf "http://127.0.0.1:${PORT}/health" && echo " ok" || echo " failed"
  echo "→ Put reverse proxy (Caddy/nginx) in front of 127.0.0.1:${PORT} for HTTPS"
fi
