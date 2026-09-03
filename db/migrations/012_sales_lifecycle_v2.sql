BEGIN;

CREATE TABLE IF NOT EXISTS customer_lifecycle_profiles (
  customer_id uuid PRIMARY KEY,
  lead_id uuid UNIQUE REFERENCES sales_leads(lead_id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'onboarding' CHECK (stage IN (
    'onboarding','support','adoption','satisfaction','retention','repurchase',
    'upsell','cross_sell','referral','win_back','churned'
  )),
  purchase_count integer NOT NULL DEFAULT 0 CHECK (purchase_count >= 0),
  adoption_score numeric(5,4) CHECK (adoption_score IS NULL OR adoption_score BETWEEN 0 AND 1),
  satisfaction_score numeric(5,4) CHECK (satisfaction_score IS NULL OR satisfaction_score BETWEEN 0 AND 1),
  support_risk numeric(5,4) CHECK (support_risk IS NULL OR support_risk BETWEEN 0 AND 1),
  onboarding_completed_at timestamptz,
  last_activity_at timestamptz,
  churned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_lifecycle_stage_idx ON customer_lifecycle_profiles(stage,updated_at);
CREATE TABLE IF NOT EXISTS customer_lifecycle_events (
  event_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customer_lifecycle_profiles(customer_id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(order_id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'onboarding_started','onboarding_completed','support_opened','support_resolved',
    'adoption_updated','satisfaction_recorded','retention_intervention','repurchase',
    'upsell','cross_sell','referral','win_back','churn'
  )),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 80),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_lifecycle_events_customer_idx ON customer_lifecycle_events(customer_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS attribution_touchpoints (
  touchpoint_id uuid PRIMARY KEY,
  session_id uuid,
  lead_id uuid REFERENCES sales_leads(lead_id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(order_id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 40),
  source_ref text,
  campaign_ref text,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attribution_touchpoints_session_idx ON attribution_touchpoints(session_id,occurred_at);
CREATE INDEX IF NOT EXISTS attribution_touchpoints_order_idx ON attribution_touchpoints(order_id,occurred_at);

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_scope_type_check;
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_scope_type_check
  CHECK (scope_type IN ('lead','customer','offer','experiment','global'));

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_job_type_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_job_type_check
  CHECK (job_type IN ('lead_review','follow_up_plan','offer_review','learning_review','knowledge_refresh','customer_lifecycle_review','attribution_review'));

INSERT INTO schema_migrations (migration_id)
VALUES ('012_sales_lifecycle_v2')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
