BEGIN;

ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_job_type_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_job_type_check
  CHECK (job_type IN ('lead_review','follow_up_plan','offer_review','learning_review','knowledge_refresh','customer_lifecycle_review','attribution_review','product_support'));


ALTER TABLE agent_tool_audit DROP CONSTRAINT IF EXISTS agent_tool_audit_risk_level_check;
ALTER TABLE agent_tool_audit ADD CONSTRAINT agent_tool_audit_risk_level_check
  CHECK (risk_level IN ('read','write','support','commercial','financial','destructive','external'));

CREATE TABLE IF NOT EXISTS product_support_cases (
  case_id uuid PRIMARY KEY,
  lead_id uuid REFERENCES sales_leads(lead_id) ON DELETE SET NULL,
  product_code text NOT NULL CHECK (length(product_code) BETWEEN 1 AND 120),
  product_version text,
  module text,
  symptom text NOT NULL CHECK (length(symptom) BETWEEN 1 AND 5000),
  error_code text,
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','diagnosing','waiting_customer','escalated','resolved','closed')),
  resolution_summary text,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_support_cases_status_idx ON product_support_cases(status,severity,updated_at DESC);
INSERT INTO schema_migrations (migration_id)
VALUES ('028_elite_product_support')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
