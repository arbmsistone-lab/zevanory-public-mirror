BEGIN;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check CHECK (status IN (
    'created','checkout_creating','checkout_ready','checkout_uncertain',
    'paid','partially_refunded','refunded','canceled','expired'
  ));

INSERT INTO schema_migrations (migration_id)
VALUES ('005_order_financial_states')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
