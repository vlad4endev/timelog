-- Per-user accounts (login + password) and data isolation

CREATE TABLE IF NOT EXISTS app_users (
  login      TEXT PRIMARY KEY,
  pw_hash    TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrate single-user app_auth → app_users
INSERT INTO app_users (login, pw_hash, updated_at)
SELECT 'default', pw_hash, updated_at
FROM app_auth
WHERE id = 'default' AND pw_hash IS NOT NULL
ON CONFLICT (login) DO NOTHING;

ALTER TABLE projects         ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE board_tasks      ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE time_entries     ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE billing_reports  ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE payments         ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE schedule_overrides ADD COLUMN IF NOT EXISTS user_login TEXT;
ALTER TABLE schedule_blocks  ADD COLUMN IF NOT EXISTS user_login TEXT;

UPDATE projects         SET user_login = 'default' WHERE user_login IS NULL;
UPDATE board_tasks      SET user_login = 'default' WHERE user_login IS NULL;
UPDATE time_entries     SET user_login = 'default' WHERE user_login IS NULL;
UPDATE billing_reports  SET user_login = 'default' WHERE user_login IS NULL;
UPDATE payments         SET user_login = 'default' WHERE user_login IS NULL;
UPDATE schedule_overrides SET user_login = 'default' WHERE user_login IS NULL;
UPDATE schedule_blocks  SET user_login = 'default' WHERE user_login IS NULL;

-- schedule_overrides: composite primary key per user
DO $$ BEGIN
  ALTER TABLE schedule_overrides DROP CONSTRAINT schedule_overrides_pkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE schedule_overrides ALTER COLUMN user_login SET DEFAULT 'default';
ALTER TABLE schedule_overrides ALTER COLUMN user_login SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE schedule_overrides ADD PRIMARY KEY (user_login, date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_user_login ON projects(user_login);
CREATE INDEX IF NOT EXISTS idx_time_entries_user_login ON time_entries(user_login);
CREATE INDEX IF NOT EXISTS idx_board_tasks_user_login ON board_tasks(user_login);
CREATE INDEX IF NOT EXISTS idx_billing_reports_user_login ON billing_reports(user_login);
CREATE INDEX IF NOT EXISTS idx_payments_user_login ON payments(user_login);
CREATE INDEX IF NOT EXISTS idx_schedule_blocks_user_login ON schedule_blocks(user_login);
