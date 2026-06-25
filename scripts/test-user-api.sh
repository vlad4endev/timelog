#!/usr/bin/env bash
# Test login + PostgREST access for a user (diagnose empty UI with data in DB).
# Usage: ./scripts/test-user-api.sh <login> <password>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOGIN="${1:-}"
PASS="${2:-}"

if [[ -z "$LOGIN" || -z "$PASS" ]]; then
  echo "Usage: $0 <login> <password>"
  exit 1
fi

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

PORT="${HTTP_PORT:-8080}"
BASE="${PUBLIC_URL:-http://127.0.0.1:${PORT}}"
ANON_KEY="${ANON_KEY:-}"

echo "=== 1. Auth token ==="
TOKEN_JSON=$(curl -sS -X POST "${BASE}/auth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"${LOGIN}\",\"password\":\"${PASS}\"}")
echo "$TOKEN_JSON"

TOKEN=$(echo "$TOKEN_JSON" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [[ -z "$TOKEN" ]]; then
  echo "✕ No token — check login/password"
  exit 1
fi
echo "✓ Token received (${#TOKEN} chars)"

echo ""
echo "=== 2. Auth /me (DB counts, bypasses RLS) ==="
curl -sS "${BASE}/auth/me" -H "Authorization: Bearer ${TOKEN}"

echo ""
echo ""
echo "=== 3. PostgREST projects (what the app sees) ==="
if [[ -z "$ANON_KEY" ]]; then
  echo "⊘ ANON_KEY not set in .env"
  exit 0
fi

HTTP=$(curl -sS -w "\nHTTP:%{http_code}" \
  "${BASE}/rest/v1/projects?user_login=eq.${LOGIN}&select=id,name" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${TOKEN}")
echo "$HTTP" | sed '$d'
CODE=$(echo "$HTTP" | tail -1 | sed 's/HTTP://')
echo "HTTP $CODE"

if [[ "$CODE" == "200" ]] && echo "$HTTP" | head -1 | grep -q '^\[\]'; then
  echo ""
  echo "✕ API returned [] but /auth/me may show projects in DB."
  echo "  → Run: ./scripts/migrate-rls.sh"
  echo "  → If behind NPM/Caddy: ensure Authorization header is forwarded to the backend"
elif [[ "$CODE" == "401" || "$CODE" == "403" ]]; then
  echo ""
  echo "✕ JWT rejected by PostgREST — check JWT_SECRET matches in .env and restart postgrest"
fi
