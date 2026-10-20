BEGIN;

CREATE TABLE IF NOT EXISTS certification_pilot_interest (
  interest_id uuid PRIMARY KEY,
  name text,
  email text NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'pilot_optin',
  status text NOT NULL DEFAULT 'waitlisted' CHECK (status IN ('waitlisted','invited','declined','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(email) BETWEEN 5 AND 254),
  CHECK (name IS NULL OR char_length(name) <= 120),
  CHECK (char_length(consent_version) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX IF NOT EXISTS certification_pilot_interest_email_uq ON certification_pilot_interest (lower(email));

INSERT INTO schema_migrations (migration_id)
VALUES ('029_certification_pilot_interest')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
