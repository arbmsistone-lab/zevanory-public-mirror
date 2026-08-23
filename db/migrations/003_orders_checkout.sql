BEGIN;

CREATE TABLE IF NOT EXISTS orders (
  order_id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL,
  experiment_id text NOT NULL,
  offer_id text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency = 'BRL'),
  provider text NOT NULL CHECK (provider = 'asaas'),
  external_reference text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN (
    'created','checkout_creating','checkout_ready','checkout_uncertain',
    'paid','refunded','canceled','expired'
  )),
  provider_checkout_id text UNIQUE,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_session_idx
  ON orders (session_id, created_at);

ALTER TABLE financial_events
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(order_id);

CREATE INDEX IF NOT EXISTS financial_events_order_idx
  ON financial_events (order_id, received_at);

INSERT INTO schema_migrations (migration_id)
VALUES ('003_orders_checkout')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
