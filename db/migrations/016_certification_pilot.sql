BEGIN;

CREATE TABLE IF NOT EXISTS certification_pilot_invites (
  invite_id uuid PRIMARY KEY,
  token_sha256 char(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  bound_session_id uuid,
  request_id uuid UNIQUE,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS certification_pilot boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS certification_pilot_invite_id uuid REFERENCES certification_pilot_invites(invite_id);
CREATE INDEX IF NOT EXISTS orders_certification_pilot_idx ON orders(certification_pilot,created_at);

INSERT INTO schema_migrations (migration_id)
VALUES ('016_certification_pilot')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
