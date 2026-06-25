#!/usr/bin/env bash
# Apply RLS + JWT claim migrations to an existing TimeLog database.
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

run_sql() {
  local file="$1"
  echo "→ $(basename "$file")"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$file"
}

echo "→ Applying multi-user RLS migrations to database '$DB_NAME'..."

for sql in "$INIT_DIR"/10-rls-isolation.sql "$INIT_DIR"/11-jwt-login-claim.sql; do
  if [[ ! -f "$sql" ]]; then
    echo "✕ Migration file not found: $sql"
    exit 1
  fi
  run_sql "$sql"
done

echo "✓ Migration complete. Rebuild and restart: docker compose up -d --build"
