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

CREATE TABLE IF NOT EXISTS time_entries (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task       TEXT NOT NULL,
  date       DATE NOT NULL,
  hours      NUMERIC NOT NULL,
  start_time TEXT,
  end_time   TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
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

CREATE INDEX IF NOT EXISTS idx_time_entries_project_id ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_project_id ON payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date DESC);
