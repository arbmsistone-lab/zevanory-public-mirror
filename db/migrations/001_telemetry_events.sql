BEGIN;

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id uuid PRIMARY KEY,
  event_name text NOT NULL CHECK (event_name IN (
    'page_view','cta_whatsapp','lead_qualified','offer_sent',
    'checkout_started','payment_confirmed','refund_confirmed'
  )),
  session_id uuid NOT NULL,
  experiment_id text NOT NULL,
  offer_id text NOT NULL,
  channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 40),
  source text NOT NULL DEFAULT 'web',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telemetry_events_session_idx
  ON telemetry_events (session_id, occurred_at);
CREATE INDEX IF NOT EXISTS telemetry_events_experiment_idx
  ON telemetry_events (experiment_id, event_name, occurred_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (migration_id)
VALUES ('001_telemetry_events')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
