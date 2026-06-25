#!/usr/bin/env bash
# Reassign all rows from one user_login to another (e.g. default → vladislav4endev).
# Use "null" as from_login to move rows where user_login IS NULL.
# Usage: ./scripts/migrate-user-data.sh <from_login> <to_login>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FROM="${1:-}"
TO="${2:-}"

if [[ -z "$FROM" || -z "$TO" ]]; then
  echo "Usage: $0 <from_login> <to_login>"
  echo "Example: $0 default vladislav4endev"
  echo "         $0 null vladislav4endev"
  exit 1
fi

if [[ "$FROM" == "$TO" ]]; then
  echo "✕ from and to login must differ"
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

FROM_ESC="${FROM//\'/\'\'}"
TO_ESC="${TO//\'/\'\'}"

if [[ "$FROM" == "null" ]]; then
  FROM_LABEL="(null user_login)"
  WHERE_CLAUSE="user_login IS NULL"
  TIMER_SQL=""
else
  FROM_LABEL="'$FROM'"
  WHERE_CLAUSE="user_login = '${FROM_ESC}'"
  TIMER_SQL="
UPDATE active_timer SET id = '${TO_ESC}' WHERE id = '${FROM_ESC}';
UPDATE schedule_settings SET id = '${TO_ESC}' WHERE id = '${FROM_ESC}';"
fi

echo "→ Moving data ${FROM_LABEL} → '$TO' in database '$DB_NAME'..."

echo "=== projects by user_login (before) ==="
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT COALESCE(user_login, '(null)') AS user_login, COUNT(*)::int AS projects
   FROM projects GROUP BY user_login ORDER BY projects DESC, user_login;"

COUNT=$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT COUNT(*)::int FROM projects WHERE ${WHERE_CLAUSE};")

if [[ "${COUNT:-0}" -eq 0 ]]; then
  echo ""
  echo "✕ No projects found for ${FROM_LABEL} (count=0)."
  echo "  Run ./scripts/list-user-data.sh for a full report."
  echo ""
  echo "  If the database is empty, data may only exist in the browser:"
  echo "  1. Deploy latest code: ./scripts/deploy.sh update"
  echo "  2. Open the app in the browser where you used TimeLog before"
  echo "  3. Log in as vladislav4endev (password min. 8 characters)"
  echo "  4. Settings → ↻ Synchronize"
  exit 1
fi

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<EOSQL
BEGIN;

UPDATE projects         SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE board_tasks      SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE time_entries     SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE billing_reports  SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE payments         SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE schedule_overrides SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
UPDATE schedule_blocks  SET user_login = '${TO_ESC}' WHERE ${WHERE_CLAUSE};
${TIMER_SQL}

COMMIT;

SELECT 'projects' AS table_name, COUNT(*)::int AS rows FROM projects WHERE user_login = '${TO_ESC}'
UNION ALL
SELECT 'time_entries', COUNT(*)::int FROM time_entries WHERE user_login = '${TO_ESC}';
EOSQL

echo "✓ Done. User '$TO' should see data after re-login in the app."
