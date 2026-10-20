BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS nuvemshop_oauth_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS nuvemshop_pending_credentials (
  session_hash text PRIMARY KEY REFERENCES nuvemshop_oauth_sessions(session_hash),
  account_id text NOT NULL CHECK (account_id ~ '^[1-9][0-9]{0,19}$'),
  access_token_enc text NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nuvemshop_connections (
  store_id text PRIMARY KEY CHECK (store_id ~ '^[1-9][0-9]{0,19}$'),
  storefront_host text NOT NULL,
  merchant_email_enc text NOT NULL,
  status text NOT NULL CHECK (status IN ('connected','suspended','uninstalled','authorization_required')),
  read_only_api_verified_at timestamptz NOT NULL,
  webhooks_registered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nuvemshop_webhook_receipts (
  delivery_key text PRIMARY KEY CHECK (delivery_key ~ '^[a-f0-9]{64}$'),
  store_ref text NOT NULL CHECK (store_ref ~ '^[a-f0-9]{64}$'),
  event text NOT NULL,
  outcome jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nuvemshop_webhook_receipts_store_idx ON nuvemshop_webhook_receipts(store_ref);
COMMENT ON TABLE nuvemshop_webhook_receipts IS 'HMAC pseudonymous audit/dedup only. Never persist raw webhooks, customer identifiers, email, phone, orders, or authentication tokens.';
INSERT INTO schema_migrations(migration_id) VALUES('027_nuvemshop_integration_security') ON CONFLICT(migration_id) DO NOTHING;
COMMIT;
