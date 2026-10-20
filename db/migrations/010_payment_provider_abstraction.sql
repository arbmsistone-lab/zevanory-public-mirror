BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_check CHECK (provider IN ('asaas','mercadopago'));

ALTER TABLE financial_events DROP CONSTRAINT IF EXISTS financial_events_provider_check;
ALTER TABLE financial_events ADD CONSTRAINT financial_events_provider_check CHECK (provider IN ('asaas','mercadopago'));

INSERT INTO schema_migrations (migration_id)
VALUES ('010_payment_provider_abstraction')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;