BEGIN;

ALTER TABLE financial_events
  ADD COLUMN IF NOT EXISTS refunded_total numeric(12,2);

UPDATE financial_events
SET refunded_total = amount
WHERE normalized_event = 'refund_confirmed'
  AND refunded_total IS NULL;

DROP INDEX IF EXISTS financial_events_payment_state_idx;

CREATE UNIQUE INDEX IF NOT EXISTS financial_events_payment_confirmed_idx
  ON financial_events (provider, provider_payment_id)
  WHERE normalized_event = 'payment_confirmed';

CREATE UNIQUE INDEX IF NOT EXISTS financial_events_refund_snapshot_idx
  ON financial_events (provider, provider_payment_id, refunded_total)
  WHERE normalized_event = 'refund_confirmed';

ALTER TABLE financial_events
  DROP CONSTRAINT IF EXISTS financial_events_refunded_total_check;

ALTER TABLE financial_events
  ADD CONSTRAINT financial_events_refunded_total_check CHECK (
    (normalized_event = 'payment_confirmed' AND refunded_total IS NULL)
    OR
    (normalized_event = 'refund_confirmed' AND refunded_total > 0 AND refunded_total <= amount)
  );

INSERT INTO schema_migrations (migration_id)
VALUES ('004_partial_refund_snapshots')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
