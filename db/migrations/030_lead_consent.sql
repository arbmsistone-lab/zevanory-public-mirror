BEGIN;

CREATE TABLE IF NOT EXISTS zevanory_leads (
  email text PRIMARY KEY,
  email_hash text NOT NULL,
  name text,
  source text NOT NULL DEFAULT 'material-gratuito',
  consent_version text NOT NULL,
  consent_text text,
  consent_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  token_hash text,
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  nurture_step integer NOT NULL DEFAULT 0,
  nurture_at timestamptz,
  subject_ref text
);

ALTER TABLE zevanory_leads ADD COLUMN IF NOT EXISTS subject_ref text;
ALTER TABLE zevanory_leads ADD COLUMN IF NOT EXISTS consent_text text;

CREATE TABLE IF NOT EXISTS zevanory_lead_events (
  id bigserial PRIMARY KEY,
  subject_ref text,
  event text NOT NULL,
  consent_version text,
  at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (migration_id)
VALUES ('030_lead_consent')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
