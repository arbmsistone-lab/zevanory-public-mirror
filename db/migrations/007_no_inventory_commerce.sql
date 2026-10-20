BEGIN;

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  commission_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  provider_commission_id text NOT NULL,
  offer_ref text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','confirmed','reversed','paid')),
  commission_brl numeric(14,2) NOT NULL CHECK (commission_brl >= 0),
  occurred_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_commission_id)
);

CREATE INDEX IF NOT EXISTS affiliate_commissions_status_idx
  ON affiliate_commissions(status,occurred_at);

CREATE TABLE IF NOT EXISTS service_fulfillment (
  fulfillment_id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending','scheduled','in_progress','delivered','canceled')),
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('digital','remote')),
  scheduled_at timestamptz,
  delivered_at timestamptz,
  evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (migration_id)
VALUES ('007_no_inventory_commerce')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;