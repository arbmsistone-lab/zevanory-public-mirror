BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE provider_oauth_credentials
  DROP CONSTRAINT IF EXISTS provider_oauth_credentials_provider_check;
ALTER TABLE provider_oauth_credentials
  ADD CONSTRAINT provider_oauth_credentials_provider_check
  CHECK (provider IN ('mercado_livre','tiktok','tiktok_sandbox','linkedin','nuvemshop','youtube_identity'));
INSERT INTO schema_migrations(migration_id)
VALUES('023_youtube_identity_oauth')
ON CONFLICT(migration_id) DO NOTHING;
COMMIT;