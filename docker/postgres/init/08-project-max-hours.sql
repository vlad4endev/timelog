-- Per-project total hours limit (optional)

ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_hours NUMERIC;
