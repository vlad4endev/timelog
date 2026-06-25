-- Migration for existing databases: reports, archive fields

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS report_id TEXT;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

ALTER TABLE board_tasks ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS billing_reports (
  id           TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_time_entries_report_id ON time_entries(report_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_archived ON time_entries(archived);
CREATE INDEX IF NOT EXISTS idx_billing_reports_status ON billing_reports(status);
CREATE INDEX IF NOT EXISTS idx_billing_reports_created ON billing_reports(created_at DESC);
ALTER TABLE billing_reports ADD COLUMN IF NOT EXISTS title TEXT;
