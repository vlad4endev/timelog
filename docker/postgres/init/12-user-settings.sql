-- Per-user app settings (OpenRouter API key, billing prefs, AI prompt, etc.)

CREATE TABLE IF NOT EXISTS user_settings (
  id         TEXT PRIMARY KEY,
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_settings_user_isolation ON user_settings;
CREATE POLICY user_settings_user_isolation ON user_settings
  FOR ALL TO timelog_user
  USING (id = app_jwt_login())
  WITH CHECK (id = app_jwt_login());
