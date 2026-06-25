#!/usr/bin/env bash
# Show how many rows each user_login owns in the TimeLog database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"

if ! docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
  echo "✕ Postgres is not running. Start stack first: docker compose up -d"
  exit 1
fi

echo "=== app_users (registered logins) ==="
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT login, updated_at FROM app_users ORDER BY login;"

echo ""
echo "=== projects by user_login ==="
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT COALESCE(user_login, '(null)') AS user_login, COUNT(*)::int AS projects
   FROM projects GROUP BY user_login ORDER BY projects DESC, user_login;"

echo ""
echo "=== time_entries by user_login ==="
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT COALESCE(user_login, '(null)') AS user_login, COUNT(*)::int AS entries
   FROM time_entries GROUP BY user_login ORDER BY entries DESC, user_login;"

echo ""
echo "=== totals ==="
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT
     (SELECT COUNT(*)::int FROM projects) AS projects_total,
     (SELECT COUNT(*)::int FROM time_entries) AS entries_total,
     (SELECT COUNT(*)::int FROM app_users) AS registered_users;"

echo ""
echo "Migrate example (when you see the source login above):"
echo "  ./scripts/migrate-user-data.sh <from_login> vladislav4endev"
echo "  ./scripts/migrate-user-data.sh null vladislav4endev   # rows with user_login IS NULL"
