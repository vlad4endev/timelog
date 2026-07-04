#!/usr/bin/env bash
# Add the report_id link column to payments on an existing TimeLog database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

INIT_DIR="$ROOT/docker/postgres/init"

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"

if ! docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
  echo "✕ Postgres is not running. Start stack first: docker compose up -d"
  exit 1
fi

SQL="$INIT_DIR/15-payment-report-link.sql"
if [[ ! -f "$SQL" ]]; then
  echo "✕ Migration file not found: $SQL"
  exit 1
fi

echo "→ Applying payment↔report link migration to database '$DB_NAME'..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SQL"

echo "✓ Migration complete. Restarting PostgREST to refresh its schema cache..."
docker compose restart postgrest

echo "✓ Done."
