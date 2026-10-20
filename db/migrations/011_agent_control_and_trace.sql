BEGIN;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_outcome_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_outcome_check
  CHECK (outcome IN ('running','awaiting_approval','completed','blocked','failed'));
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trace_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS span_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(14,6) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);

ALTER TABLE integration_outbox ADD COLUMN IF NOT EXISTS trace_id uuid;
ALTER TABLE integration_outbox ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS agent_control_state (
  control_id text PRIMARY KEY CHECK (control_id='global'),
  paused boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT 'safe_default',
  changed_by text NOT NULL DEFAULT 'system',
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agent_control_state(control_id,paused,reason,changed_by)
VALUES ('global',true,'migration_safe_default','system') ON CONFLICT(control_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS agent_approvals (
  approval_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agent_jobs(job_id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  trace_id uuid,
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 100),
  risk_level text NOT NULL CHECK (risk_level IN ('commercial','financial','destructive')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  request_reason text NOT NULL CHECK (length(request_reason) BETWEEN 1 AND 500),
  decision_reason text,
  decided_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_approvals_pending_idx ON agent_approvals(status,requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS agent_approvals_one_pending_idx ON agent_approvals(job_id,tool_name) WHERE status='pending';

INSERT INTO schema_migrations (migration_id)
VALUES ('011_agent_control_and_trace')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
