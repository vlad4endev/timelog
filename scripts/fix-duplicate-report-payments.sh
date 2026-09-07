#!/usr/bin/env bash
# Clean up the duplicate payments left behind by the savePayment() bug, where
# editing a report-booked payment dropped its report_id and the next page load
# booked a second payment for the same report — inflating "Получено оплат".
#
# The pair is identified by: a paid report that has BOTH a payment linked to it
# (the machine-booked copy) AND an unlinked payment for the same project created
# at the exact same instant (the user's edited original — savePayment preserves
# created_at, so the two always share it to the millisecond).
#
# The user's copy is kept and re-linked; the machine copy is deleted. Re-linking
# is not optional: backfillPaidReportPayments() runs on every page load, so a
# delete-only cleanup would simply book the duplicate again on the next reload.
#
#   ./scripts/fix-duplicate-report-payments.sh            # dry run (default)
#   ./scripts/fix-duplicate-report-payments.sh --apply    # actually write
#   ./scripts/fix-duplicate-report-payments.sh --self-test # verify the SQL, rolls back
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
set -a && source .env 2>/dev/null || true && set +a

DB_USER="${POSTGRES_USER:-timelog}"
DB_NAME="${POSTGRES_DB:-timelog}"

MODE="dry"
case "${1:-}" in
  --apply)     MODE="apply" ;;
  --self-test) MODE="test" ;;
  ""|--dry-run) MODE="dry" ;;
  *) echo "Usage: $0 [--apply|--dry-run|--self-test]"; exit 2 ;;
esac

# TIMELOG_PSQL lets the test suite point this at a throwaway local cluster
# instead of the docker stack; unset (the normal case) it goes through compose.
if [[ -n "${TIMELOG_PSQL:-}" ]]; then
  psql_run() { $TIMELOG_PSQL -v ON_ERROR_STOP=1 -d "$DB_NAME" "$@"; }
else
  if ! docker compose ps postgres --status running -q 2>/dev/null | grep -q .; then
    echo "✕ Postgres is not running. Start stack first: docker compose up -d"
    exit 1
  fi
  psql_run() { docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
fi

# Materialised as a TEMP TABLE, never a view: the UPDATE below sets report_id on
# the kept row, which would immediately drop it out of a live view's
# "report_id IS NULL" predicate and leave the DELETE with nothing to delete.
read -r -d '' FIND_PAIRS <<'SQL' || true
CREATE TEMP TABLE dup_pairs AS
SELECT
  r.id                               AS report_id,
  COALESCE(NULLIF(r.title, ''), '(без названия)') AS report_title,
  COALESCE(r.user_login, '(null)')   AS who,
  COALESCE(pr.name, '(без проекта)') AS project,
  a.id                               AS auto_payment_id,
  a.amount                           AS auto_amount,
  COALESCE(a.note, '')               AS auto_note,
  u.id                               AS kept_payment_id,
  u.amount                           AS kept_amount,
  COALESCE(u.note, '')               AS kept_note,
  u.date                             AS kept_date
FROM billing_reports r
JOIN payments a
  ON  a.report_id  = r.id
  AND a.user_login IS NOT DISTINCT FROM r.user_login
JOIN payments u
  ON  u.report_id IS NULL
  AND u.user_login  IS NOT DISTINCT FROM r.user_login
  AND u.project_id  IS NOT DISTINCT FROM a.project_id
  AND u.created_at  =  a.created_at
  AND u.id         <> a.id
LEFT JOIN projects pr ON pr.id = a.project_id
WHERE r.status = 'paid';
SQL

# Money is involved: if any payment turns up in more than one pair the match is
# ambiguous and a human has to look, so refuse the whole batch rather than guess.
read -r -d '' GUARD <<'SQL' || true
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM (
    SELECT kept_payment_id FROM dup_pairs GROUP BY 1 HAVING COUNT(*) > 1
    UNION ALL
    SELECT auto_payment_id FROM dup_pairs GROUP BY 1 HAVING COUNT(*) > 1
  ) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'Ambiguous matches (% payment(s) in more than one pair) — aborting, inspect manually', n;
  END IF;
END $$;
SQL

if [[ "$MODE" == "test" ]]; then
  echo "→ Self-test (all writes rolled back)..."
  psql_run -q <<SQL
BEGIN;
CREATE TEMP TABLE _res(label text, ok boolean);
INSERT INTO projects (id, name, rate, user_login) VALUES ('_t_p1', '_t Альфа', 1000, '_t_user');
INSERT INTO billing_reports (id, user_login, period_from, period_to, project_id, entry_ids, text, status, paid_at, total_amount, created_at)
  VALUES ('_t_r1', '_t_user', '2026-01-01', '2026-01-31', '_t_p1', '{}', '', 'paid', '2026-02-01T10:00:00Z', 10000, '2026-01-31T00:00:00Z');
-- the user's edited original: report_id lost, note changed, same created_at
INSERT INTO payments (id, user_login, project_id, amount, date, note, report_id, created_at)
  VALUES ('_t_kept', '_t_user', '_t_p1', 10000, '2026-02-01', 'на карту', NULL, '2026-02-01T10:00:00Z');
-- the machine copy booked by the next page load
INSERT INTO payments (id, user_login, project_id, amount, date, note, report_id, created_at)
  VALUES ('_t_auto', '_t_user', '_t_p1', 10000, '2026-02-01', 'Оплата по отчёту', '_t_r1', '2026-02-01T10:00:00Z');
-- an unrelated manual payment that must survive untouched
INSERT INTO payments (id, user_login, project_id, amount, date, note, report_id, created_at)
  VALUES ('_t_other', '_t_user', '_t_p1', 500, '2026-03-01', 'аванс', NULL, '2026-03-01T09:00:00Z');

$FIND_PAIRS
$GUARD
INSERT INTO _res VALUES ('находит ровно одну пару', (SELECT COUNT(*) FROM dup_pairs WHERE report_id='_t_r1') = 1);

UPDATE payments p SET report_id = d.report_id, updated_at = NOW()
  FROM dup_pairs d WHERE p.id = d.kept_payment_id;
DELETE FROM payments WHERE id IN (SELECT auto_payment_id FROM dup_pairs);

INSERT INTO _res VALUES ('машинная копия удалена',        NOT EXISTS (SELECT 1 FROM payments WHERE id='_t_auto'));
INSERT INTO _res VALUES ('правка пользователя сохранена', (SELECT note FROM payments WHERE id='_t_kept') = 'на карту');
INSERT INTO _res VALUES ('связь с отчётом восстановлена', (SELECT report_id FROM payments WHERE id='_t_kept') = '_t_r1');
INSERT INTO _res VALUES ('посторонний платёж не тронут',  (SELECT report_id IS NULL AND amount = 500 FROM payments WHERE id='_t_other'));
INSERT INTO _res VALUES ('сумма по отчёту больше не двоится',
  (SELECT COALESCE(SUM(amount),0) FROM payments WHERE report_id='_t_r1') = 10000);
-- повторный прогон ничего не находит (иначе чистка зациклится)
DROP TABLE dup_pairs;
$FIND_PAIRS
INSERT INTO _res VALUES ('повторный прогон — пар нет', (SELECT COUNT(*) FROM dup_pairs) = 0);

\\pset tuples_only on
SELECT CASE WHEN ok THEN '  ok   ' ELSE '  FAIL ' END || label FROM _res;
\\pset tuples_only off
DO \$\$ DECLARE bad int; BEGIN
  SELECT COUNT(*) INTO bad FROM _res WHERE NOT ok;
  IF bad > 0 THEN RAISE EXCEPTION '% self-test check(s) failed', bad; END IF;
END \$\$;
ROLLBACK;
SQL
  echo "✓ Self-test passed (nothing was written)."
  exit 0
fi

echo "→ Scanning database '$DB_NAME' for duplicate report payments..."
psql_run <<SQL
$FIND_PAIRS
\\pset border 2
SELECT who AS "Пользователь", report_title AS "Отчёт", project AS "Проект",
       kept_date AS "Дата",
       kept_amount || ' (' || kept_note || ')' AS "ОСТАВИТЬ — правка пользователя",
       auto_amount || ' (' || auto_note || ')' AS "УДАЛИТЬ — копия от бага"
FROM dup_pairs ORDER BY who, kept_date;
SELECT COUNT(*)::int AS "Найдено дублей", COALESCE(SUM(auto_amount), 0) AS "Лишних денег в «Получено оплат»" FROM dup_pairs;
SQL

if [[ "$MODE" == "dry" ]]; then
  echo ""
  echo "Это пробный прогон — ничего не изменено."
  echo "Сделайте бэкап (./scripts/backup-db.sh), затем примените:"
  echo "  ./scripts/fix-duplicate-report-payments.sh --apply"
  exit 0
fi

echo ""
read -r -p "Удалить показанные дубли? Введите yes для подтверждения: " reply
[[ "$reply" == "yes" ]] || { echo "Отменено."; exit 1; }

psql_run <<SQL
BEGIN;
$FIND_PAIRS
$GUARD
UPDATE payments p SET report_id = d.report_id, updated_at = NOW()
  FROM dup_pairs d WHERE p.id = d.kept_payment_id;
DELETE FROM payments WHERE id IN (SELECT auto_payment_id FROM dup_pairs);
SELECT COUNT(*)::int AS "Удалено дублей" FROM dup_pairs;
COMMIT;
SQL

echo "✓ Готово."
echo ""
echo "ВАЖНО: на каждом устройстве перезагрузите приложение, чтобы оно подтянуло"
echo "чистые данные с сервера. Пока этого не сделано, локальная копия там ещё"
echo "содержит дубль, и ручная кнопка «выгрузить всё» вернёт его обратно."
