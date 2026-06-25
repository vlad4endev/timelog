-- App password hash (shared across devices via PostgREST)

CREATE TABLE IF NOT EXISTS app_auth (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  pw_hash    TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
