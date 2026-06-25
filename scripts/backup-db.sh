#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a && source .env && set +a

BACKUP_DIR="${1:-./backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${BACKUP_DIR}/timelog-${STAMP}.sql.gz"

echo "→ Backup to ${FILE}"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-timelog}" "${POSTGRES_DB:-timelog}" | gzip > "$FILE"
echo "✓ Done ($(du -h "$FILE" | cut -f1))"
