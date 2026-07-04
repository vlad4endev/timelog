-- Track last-modified time for projects and payments so cross-device sync
-- can resolve conflicts by recency instead of always falling back to
-- created_at (which never changes after the row is first created).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE payments SET updated_at = created_at WHERE updated_at IS NULL;
