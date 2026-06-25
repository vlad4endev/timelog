#!/usr/bin/env bash
# Apply SQL migrations to an existing database (init scripts only run on first boot).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"
INIT_DIR="$ROOT/docker/postgres/init"

if ! docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
  echo "✕ Postgres is not running. Start stack first: docker compose up -d"
  exit 1
fi

run_sql() {
  local file="$1"
  echo "→ $(basename "$file")"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$file"
}

# Optional: pass specific file(s), otherwise run numbered migrations 03+ only
if [[ $# -gt 0 ]]; then
  for f in "$@"; do
    [[ -f "$f" ]] || { echo "✕ Not found: $f"; exit 1; }
    run_sql "$f"
  done
else
  shopt -s nullglob
  files=("$INIT_DIR"/[0-9][0-9]-*.sql)
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "✕ No migration files in $INIT_DIR"
    exit 1
  fi
  for f in "${files[@]}"; do
    # Skip 01-schema.sql on existing DB (full schema); 02 is shell roles script
  base=$(basename "$f")
    if [[ "$base" == "01-schema.sql" ]]; then
      echo "⊘ skip $base (use only on fresh DB)"
      continue
    fi
    run_sql "$f"
  done
fi

echo "✓ Migrations applied"
