#!/usr/bin/env bash
# Reassign all rows from one user_login to another (e.g. default → vladislav4endev).
# Usage: ./scripts/migrate-user-data.sh <from_login> <to_login>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FROM="${1:-}"
TO="${2:-}"

if [[ -z "$FROM" || -z "$TO" ]]; then
  echo "Usage: $0 <from_login> <to_login>"
  echo "Example: $0 default vladislav4endev"
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

echo "→ Moving data user_login '$FROM' → '$TO' in database '$DB_NAME'..."

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<EOSQL
BEGIN;

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE user_login = '${FROM_ESC}' LIMIT 1) THEN
    RAISE EXCEPTION 'No projects found for user_login %', '${FROM_ESC}';
  END IF;
END
\$\$;

UPDATE projects         SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE board_tasks      SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE time_entries     SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE billing_reports  SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE payments         SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE schedule_overrides SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE schedule_blocks  SET user_login = '${TO_ESC}' WHERE user_login = '${FROM_ESC}';
UPDATE active_timer     SET id = '${TO_ESC}' WHERE id = '${FROM_ESC}';
UPDATE schedule_settings SET id = '${TO_ESC}' WHERE id = '${FROM_ESC}';

COMMIT;

SELECT 'projects' AS table_name, COUNT(*)::int AS rows FROM projects WHERE user_login = '${TO_ESC}'
UNION ALL
SELECT 'time_entries', COUNT(*)::int FROM time_entries WHERE user_login = '${TO_ESC}';
EOSQL

echo "✓ Done. User '$TO' should see data after re-login in the app."
