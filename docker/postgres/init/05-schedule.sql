-- Work schedule planning (weekly template, day overrides, hourly blocks)

CREATE TABLE IF NOT EXISTS schedule_settings (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  week_template JSONB NOT NULL DEFAULT '{"mon":8,"tue":8,"wed":8,"thu":8,"fri":8,"sat":0,"sun":0}',
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schedule_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS schedule_overrides (
  date       DATE PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'off',
  hours      NUMERIC,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id         TEXT PRIMARY KEY,
  date       DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  title      TEXT,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schedule_blocks_date ON schedule_blocks(date);
