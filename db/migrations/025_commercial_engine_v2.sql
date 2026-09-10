BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tenant_memberships (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 3 AND 240),
  role text NOT NULL CHECK (role IN ('owner','admin','operator','analyst','billing')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,actor_ref)
);
CREATE TABLE IF NOT EXISTS customer_identities (
  identity_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customer_lifecycle_profiles(customer_id) ON DELETE SET NULL,
  identity_hash text NOT NULL CHECK (length(identity_hash)=64),
  identity_type text NOT NULL CHECK (identity_type IN ('email','phone','external')),
  verified boolean NOT NULL DEFAULT false,
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,identity_type,identity_hash)
);
CREATE TABLE IF NOT EXISTS customer_feature_snapshots (
  snapshot_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customer_lifecycle_profiles(customer_id) ON DELETE CASCADE,
  features jsonb NOT NULL,
  segment text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_feature_snapshots_idx ON customer_feature_snapshots(tenant_id,customer_id,observed_at DESC);
CREATE TABLE IF NOT EXISTS decision_experiments (
  experiment_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS decision_assignments (
  assignment_id uuid PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES decision_experiments(experiment_id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  subject_ref text NOT NULL,
  arm text,
  mode text NOT NULL CHECK (mode IN ('holdout','explore','exploit')),
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id,tenant_id,subject_ref)
);
CREATE TABLE IF NOT EXISTS journey_instances (
  journey_id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  subject_ref text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','suppressed')),
  preferred_channel text,
  touches_24h integer NOT NULL DEFAULT 0 CHECK (touches_24h >= 0),
  touches_7d integer NOT NULL DEFAULT 0 CHECK (touches_7d >= 0),
  last_touch_at timestamptz,
  next_action_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,subject_ref)
);
CREATE INDEX IF NOT EXISTS journey_instances_due_idx ON journey_instances(tenant_id,status,next_action_at);

INSERT INTO tenants(tenant_id,display_name,status)
VALUES ('zevanory','ZEVANORY','active')
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO schema_migrations (migration_id)
VALUES ('025_commercial_engine_v2')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
