BEGIN;

CREATE TABLE IF NOT EXISTS provider_oauth_credentials (
  provider text PRIMARY KEY,
  account_id text NOT NULL,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  token_type text NOT NULL DEFAULT 'Bearer',
  scope text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider = 'mercado_livre')
);

CREATE INDEX IF NOT EXISTS provider_oauth_credentials_expires_idx
  ON provider_oauth_credentials(expires_at);

INSERT INTO schema_migrations (migration_id)
VALUES ('017_mercadolivre_oauth')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
