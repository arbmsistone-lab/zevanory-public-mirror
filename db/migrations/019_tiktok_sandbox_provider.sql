BEGIN;

ALTER TABLE provider_oauth_credentials
  DROP CONSTRAINT IF EXISTS provider_oauth_credentials_provider_check;

ALTER TABLE provider_oauth_credentials
  ADD CONSTRAINT provider_oauth_credentials_provider_check
  CHECK (provider IN ('mercado_livre','tiktok','tiktok_sandbox'));

INSERT INTO schema_migrations (migration_id)
VALUES ('019_tiktok_sandbox_provider')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
