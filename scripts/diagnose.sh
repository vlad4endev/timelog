#!/usr/bin/env bash
# Quick production diagnostics (502, health, API).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

PORT="${HTTP_PORT:-8080}"

echo "=== Docker Compose ==="
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps 2>/dev/null || docker compose ps

echo ""
echo "=== Local health (127.0.0.1:${PORT}/health) ==="
if curl -sf "http://127.0.0.1:${PORT}/health"; then
  echo " ok"
else
  echo "✕ FAILED — timelog web is down or not bound to 127.0.0.1:${PORT}"
  echo "  Check: docker compose logs web --tail 50"
fi

echo ""
echo "=== Web container health ==="
docker compose ps web --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true

echo ""
echo "=== API smoke test ==="
ANON_KEY="${ANON_KEY:-}"
if [[ -n "$ANON_KEY" ]]; then
  if curl -sf "http://127.0.0.1:${PORT}/rest/v1/projects?limit=1" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" >/dev/null; then
    echo "✓ PostgREST ok"
  else
    echo "✕ PostgREST failed — docker compose logs postgrest --tail 30"
  fi
else
  echo "⊘ Set ANON_KEY in .env to test API"
fi

echo ""
echo "=== active_timer table ==="
docker compose exec -T postgres psql -U "${POSTGRES_USER:-timelog}" -d "${POSTGRES_DB:-timelog}" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'active_timer');" 2>/dev/null \
  | grep -q t && echo "✓ active_timer exists" || echo "✕ active_timer missing — run: ./scripts/migrate-db.sh"

echo ""
echo "=== Reverse proxy (502) hints ==="
cat <<'EOF'
If NPM/Caddy returns 502 but local curl above works:
  • NPM in Docker cannot use 127.0.0.1:8080 (that is inside NPM container).
  • Use host IP, e.g. 172.17.0.1:8080, or add NPM to timelog network:
      docker network connect timelog_timelog nginx_proxy_manager
    then upstream: http://web:80
  • Or proxy to the server's LAN IP: http://YOUR_SERVER_IP:8080
EOF
