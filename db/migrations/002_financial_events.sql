BEGIN;

CREATE TABLE IF NOT EXISTS financial_events (
  provider_event_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'asaas'),
  provider_payment_id text NOT NULL,
  normalized_event text NOT NULL CHECK (normalized_event IN ('payment_confirmed','refund_confirmed')),
  provider_event_name text NOT NULL,
  provider_status text NOT NULL,
  external_reference text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_events_payment_state_idx
  ON financial_events (provider, provider_payment_id, normalized_event);

INSERT INTO schema_migrations (migration_id)
VALUES ('002_financial_events')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
