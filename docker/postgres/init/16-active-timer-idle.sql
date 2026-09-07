-- Idle time detected during the running session (the user was away from the
-- machine). Kept next to paused_ms so a timer resumed on another device
-- carries its idle counter with it instead of losing the deduction.

ALTER TABLE active_timer ADD COLUMN IF NOT EXISTS idle_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE active_timer ADD COLUMN IF NOT EXISTS idle_since BIGINT;
