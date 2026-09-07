-- Closes the gaps the earlier migrations left open. Idempotent — safe to
-- re-run against an existing volume (see scripts/migrate-db.sh).

-- ─── 1. anon's DEFAULT PRIVILEGES outlived the REVOKE ────────────────────
-- 02-roles.sh ran `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT,
-- UPDATE, DELETE ON TABLES TO anon`, and 10-rls-isolation.sql then revoked
-- anon's access to every table that existed *at that moment*. Default
-- privileges are not a one-off grant: they re-apply to every table created
-- afterwards. user_settings (12-) was created after the revoke and came back
-- fully writable by anon — the role PostgREST uses for UNAUTHENTICATED
-- requests. It survived only because it has its own RLS policy; the next
-- table added without one would be world-writable over /rest/v1/.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
-- PostgREST still needs to reach the schema to answer at all; RLS + no
-- policy for anon is what actually keeps the rows invisible.
GRANT USAGE ON SCHEMA public TO anon;

-- ─── 2. app_users: FORCE RLS with zero policies is a loaded gun ──────────
-- FORCE makes RLS apply to the table OWNER too. app_users has RLS enabled
-- and no policy at all, so the auth service reads it only because
-- POSTGRES_USER is a SUPERUSER in the postgres image (superusers bypass RLS
-- unconditionally). Point DATABASE_URL at any non-superuser owner and every
-- login starts failing as "invalid credentials" — zero rows, no error.
-- ENABLE alone already blocks anon (no policy = no rows); dropping FORCE
-- just stops the owner path from being silently load-bearing on superuser.
ALTER TABLE app_users NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  ALTER TABLE app_auth NO FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ─── 3. Indexes that match how sync/pull actually reads ─────────────────
-- Every pull is `WHERE user_login = $1 ORDER BY <col>`. The single-column
-- user_login indexes from 07- satisfied the filter but left Postgres sorting
-- the whole result each time; these cover both halves.
CREATE INDEX IF NOT EXISTS idx_projects_user_created
  ON projects(user_login, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_created
  ON time_entries(user_login, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_user_created
  ON payments(user_login, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_reports_user_created
  ON billing_reports(user_login, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_tasks_user_position
  ON board_tasks(user_login, position ASC);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_user_date
  ON schedule_blocks(user_login, date ASC);
-- The per-project/date reads the UI does inside one user's data.
CREATE INDEX IF NOT EXISTS idx_time_entries_user_date
  ON time_entries(user_login, date DESC);

-- ─── 4. Orphaned rows are invisible, not absent ─────────────────────────
-- A NULL user_login belongs to nobody: RLS hides it, sync/pull never returns
-- it, and it sits there forever holding a primary key that a real row can
-- then collide with. Adopt any strays into the legacy account and make the
-- column mandatory so it can't happen again.
UPDATE projects        SET user_login = 'default' WHERE user_login IS NULL;
UPDATE board_tasks     SET user_login = 'default' WHERE user_login IS NULL;
UPDATE time_entries    SET user_login = 'default' WHERE user_login IS NULL;
UPDATE billing_reports SET user_login = 'default' WHERE user_login IS NULL;
UPDATE payments        SET user_login = 'default' WHERE user_login IS NULL;
UPDATE schedule_blocks SET user_login = 'default' WHERE user_login IS NULL;

ALTER TABLE projects        ALTER COLUMN user_login SET NOT NULL;
ALTER TABLE board_tasks     ALTER COLUMN user_login SET NOT NULL;
ALTER TABLE time_entries    ALTER COLUMN user_login SET NOT NULL;
ALTER TABLE billing_reports ALTER COLUMN user_login SET NOT NULL;
ALTER TABLE payments        ALTER COLUMN user_login SET NOT NULL;
ALTER TABLE schedule_blocks ALTER COLUMN user_login SET NOT NULL;

-- ─── 5. Nothing may hold a transaction or a lock indefinitely ───────────
-- A wedged statement on the API role used to pin a connection (and its row
-- locks) until someone noticed. These are per-role, so they apply however
-- the role connects.
ALTER ROLE timelog_user  SET statement_timeout = '20s';
ALTER ROLE timelog_user  SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE anon          SET statement_timeout = '10s';
ALTER ROLE authenticator SET statement_timeout = '20s';
ALTER ROLE authenticator SET idle_in_transaction_session_timeout = '30s';
