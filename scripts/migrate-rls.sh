#!/usr/bin/env bash
# Apply RLS migration to an existing TimeLog database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SQL_FILE="$ROOT/docker/postgres/init/10-rls-isolation.sql"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "✕ Migration file not found: $SQL_FILE"
  exit 1
fi

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"

echo "→ Applying multi-user RLS migration to database '$DB_NAME'..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SQL_FILE"
echo "✓ Migration complete. Rebuild and restart: docker compose up -d --build"
