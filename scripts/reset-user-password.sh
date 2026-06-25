#!/usr/bin/env bash
# Set a new server password for an existing app_users login.
# Usage: ./scripts/reset-user-password.sh <login> <new_password>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOGIN="${1:-}"
PASS="${2:-}"

if [[ -z "$LOGIN" || -z "$PASS" ]]; then
  echo "Usage: $0 <login> <new_password>"
  echo "Example: $0 vladislav4endev 'MySecurePass123'"
  echo "Password must be at least 8 characters."
  exit 1
fi

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"

if ! docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
  echo "✕ Postgres is not running. Start stack first: docker compose up -d"
  exit 1
fi

LOGIN_LC="$(printf '%s' "$LOGIN" | tr '[:upper:]' '[:lower:]')"
LOGIN_ESC="${LOGIN_LC//\'/\'\'}"

EXISTS="$(docker compose exec -T postgres psql -t -A -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT 1 FROM app_users WHERE login = '${LOGIN_ESC}' LIMIT 1;" 2>/dev/null || true)"
if [[ "$EXISTS" != "1" ]]; then
  echo "✕ User '${LOGIN_LC}' not found in app_users"
  exit 1
fi

echo "→ Hashing new password..."
HASH="$(node "$ROOT/scripts/reset-user-password.mjs" "$PASS")"
HASH_ESC="${HASH//\'/\'\'}"

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<EOSQL
UPDATE app_users
SET pw_hash = '${HASH_ESC}', updated_at = NOW()
WHERE login = '${LOGIN_ESC}';
EOSQL

echo "✓ Password updated for '${LOGIN_LC}'."
echo "  Log in at the app with this login and the new password (min. 8 characters)."
