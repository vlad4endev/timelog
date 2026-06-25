-- Active timer state for background sync across devices/sessions

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
