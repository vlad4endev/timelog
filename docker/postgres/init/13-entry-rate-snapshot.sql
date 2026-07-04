-- Freeze the project's hourly rate on each time entry at creation time,
-- so a later rate change doesn't retroactively rewrite past earnings.

ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS rate NUMERIC;
