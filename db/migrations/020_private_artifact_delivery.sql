BEGIN;

CREATE TABLE IF NOT EXISTS artifact_download_tokens (
  token_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(order_id),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_key text NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[0-9A-F]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  issued_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS artifact_download_tokens_order_idx
  ON artifact_download_tokens(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS artifact_download_tokens_active_idx
  ON artifact_download_tokens(expires_at)
  WHERE used_at IS NULL;

INSERT INTO schema_migrations (migration_id)
VALUES ('020_private_artifact_delivery')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
