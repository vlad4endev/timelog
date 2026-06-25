-- TimeLog schema (PostgREST / Supabase-compatible REST API)

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  client      TEXT,
  rate        NUMERIC DEFAULT 0,
  color       TEXT DEFAULT '#6c63ff',
  status      TEXT DEFAULT 'active',
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS board_tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'todo',
  position    INTEGER NOT NULL DEFAULT 0,
  priority    TEXT DEFAULT 'medium',
  archived    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task       TEXT NOT NULL,
  date       DATE NOT NULL,
  hours      NUMERIC NOT NULL,
  start_time TEXT,
  end_time   TEXT,
  notes      TEXT,
  task_id    TEXT REFERENCES board_tasks(id) ON DELETE SET NULL,
  report_id  TEXT,
  archived   BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_reports (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  entry_ids    TEXT[] NOT NULL DEFAULT '{}',
  text         TEXT NOT NULL,
  total_hours  NUMERIC NOT NULL DEFAULT 0,
  total_amount NUMERIC NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'unpaid',
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  amount      NUMERIC NOT NULL,
  date        DATE NOT NULL,
  period_from DATE,
  period_to   DATE,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_tasks_project_status ON board_tasks(project_id, status, position);
CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_project_id ON payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date DESC);
CREATE INDEX IF NOT EXISTS idx_time_entries_report_id ON time_entries(report_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_archived ON time_entries(archived);
CREATE INDEX IF NOT EXISTS idx_billing_reports_status ON billing_reports(status);
CREATE INDEX IF NOT EXISTS idx_billing_reports_created ON billing_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS active_timer (
  id          TEXT PRIMARY KEY DEFAULT 'current',
  running     BOOLEAN NOT NULL DEFAULT FALSE,
  start_time  BIGINT,
  project_id  TEXT,
  task        TEXT,
  task_id     TEXT,
  paused      BOOLEAN DEFAULT FALSE,
  paused_ms   BIGINT DEFAULT 0,
  pause_start BIGINT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
