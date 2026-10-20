BEGIN;

CREATE TABLE IF NOT EXISTS agent_jobs (
  job_id uuid PRIMARY KEY,
  job_type text NOT NULL CHECK (job_type IN ('lead_review','follow_up_plan','offer_review','learning_review','knowledge_refresh')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','blocked','failed','canceled')),
  priority integer NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  lead_id uuid REFERENCES sales_leads(lead_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_jobs_queue_idx ON agent_jobs(status,priority DESC,available_at);
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id uuid PRIMARY KEY,
  job_id uuid REFERENCES agent_jobs(job_id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('deterministic','ai_assisted')),
  outcome text NOT NULL CHECK (outcome IN ('completed','blocked','failed')),
  input_hash text NOT NULL,
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id uuid PRIMARY KEY,
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 50000),
  source_ref text,
  trust_level text NOT NULL DEFAULT 'internal' CHECK (trust_level IN ('internal','official','verified','unverified')),
  active boolean NOT NULL DEFAULT true,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', coalesce(title,'') || ' ' || coalesce(content,''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(namespace,title)
);
CREATE INDEX IF NOT EXISTS knowledge_documents_search_idx ON knowledge_documents USING gin(search_vector);
CREATE TABLE IF NOT EXISTS agent_memory (
  memory_id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('lead','offer','experiment','global')),
  scope_ref text NOT NULL CHECK (length(scope_ref) BETWEEN 1 AND 160),
  memory_key text NOT NULL CHECK (length(memory_key) BETWEEN 1 AND 120),
  memory_value jsonb NOT NULL,
  confidence numeric(5,4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scope_type,scope_ref,memory_key)
);
CREATE INDEX IF NOT EXISTS agent_memory_scope_idx ON agent_memory(scope_type,scope_ref);

CREATE TABLE IF NOT EXISTS agent_tool_audit (
  audit_id uuid PRIMARY KEY,
  run_id uuid REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 100),
  risk_level text NOT NULL CHECK (risk_level IN ('read','write','commercial','financial','destructive')),
  allowed boolean NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tool_audit_run_idx ON agent_tool_audit(run_id,created_at);

INSERT INTO schema_migrations (migration_id)
VALUES ('008_autonomous_revenue_engine')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
