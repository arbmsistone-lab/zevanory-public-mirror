BEGIN;

CREATE TABLE IF NOT EXISTS integration_outbox (
  event_id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 80),
  aggregate_id text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 160),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','retry','dead_letter','canceled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_outbox_dispatch_idx
  ON integration_outbox(status,available_at,created_at);

INSERT INTO schema_migrations (migration_id)
VALUES ('009_composable_infrastructure')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
