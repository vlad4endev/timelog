-- Link a payment back to the report that generated it (when a report is
-- marked paid), so un-marking a report as paid can find and remove exactly
-- the payment it created — not just the ones matching its note text.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS report_id TEXT;
CREATE INDEX IF NOT EXISTS idx_payments_report_id ON payments(report_id);
