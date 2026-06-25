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

echo "→ Moving data user_login '$FROM' → '$TO' in database '$DB_NAME'..."

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" \
  -v from_login="$FROM" -v to_login="$TO" <<'EOSQL'
BEGIN;

DO $migrate$
DECLARE
  t text;
  n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM projects WHERE user_login = :'from_login';
  IF n = 0 THEN
    RAISE EXCEPTION 'No projects found for user_login %', :'from_login';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'projects', 'board_tasks', 'time_entries', 'billing_reports',
    'payments', 'schedule_overrides', 'schedule_blocks'
  ] LOOP
    EXECUTE format('UPDATE %I SET user_login = $1 WHERE user_login = $2', t)
      USING :'to_login', :'from_login';
  END LOOP;

  UPDATE active_timer SET id = :'to_login' WHERE id = :'from_login';
  UPDATE schedule_settings SET id = :'to_login' WHERE id = :'from_login';
END
$migrate$;

COMMIT;

SELECT 'projects' AS table_name, COUNT(*)::int AS rows FROM projects WHERE user_login = :'to_login'
UNION ALL
SELECT 'time_entries', COUNT(*)::int FROM time_entries WHERE user_login = :'to_login';
EOSQL

echo "✓ Done. Restart web if needed: docker compose up -d --build"
