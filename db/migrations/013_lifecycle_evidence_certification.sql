BEGIN;

CREATE TABLE IF NOT EXISTS lifecycle_evidence_events (
  evidence_id uuid PRIMARY KEY,
  dimension text NOT NULL CHECK (dimension IN (
    'market','icp','acquisition','capture','identity','enrichment','scoring','prioritization',
    'first_response','discovery','qualification','nurturing','objection','offer','negotiation',
    'checkout','abandonment_recovery','payment','reconciliation','fulfillment','onboarding','support',
    'adoption','satisfaction','retention','repurchase','upsell','cross_sell','referral','win_back',
    'churn','ltv','attribution','unit_economics','experiment','learning','forecast','next_best_action','scale'
  )),
  proof_kind text NOT NULL CHECK (proof_kind IN ('observed_production','verified_probe','human_validation')),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
  subject_ref text,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 240),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lifecycle_evidence_dimension_idx
  ON lifecycle_evidence_events(dimension,occurred_at DESC);

INSERT INTO schema_migrations (migration_id)
VALUES ('013_lifecycle_evidence_certification')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
