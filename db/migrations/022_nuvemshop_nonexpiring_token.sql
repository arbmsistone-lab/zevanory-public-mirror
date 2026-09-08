BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE provider_oauth_credentials ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE provider_oauth_credentials ADD CONSTRAINT provider_oauth_expiry_required
  CHECK (provider = 'nuvemshop' OR expires_at IS NOT NULL);
UPDATE provider_oauth_credentials SET expires_at = NULL WHERE provider = 'nuvemshop';
COMMENT ON COLUMN provider_oauth_credentials.expires_at IS 'NULL for Nuvemshop tokens: revoked by replacement or app uninstall; not proof of token validity.';
INSERT INTO schema_migrations(migration_id) VALUES('022_nuvemshop_nonexpiring_token') ON CONFLICT(migration_id) DO NOTHING;
COMMIT;
