BEGIN;

CREATE TABLE IF NOT EXISTS sales_leads (
  lead_id uuid PRIMARY KEY,
  session_id uuid UNIQUE,
  channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 40),
  stage text NOT NULL CHECK (stage IN ('new','contacted','qualified','offer_sent','checkout_started','paid','delivered','refunded','unqualified','lost')),
  contact_ref text,
  touchpoints integer NOT NULL DEFAULT 0 CHECK (touchpoints >= 0 AND touchpoints <= 50),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_contact_at timestamptz,
  next_action_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_leads_stage_next_idx ON sales_leads(stage,next_action_at);

CREATE TABLE IF NOT EXISTS sales_actions (
  action_id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES sales_leads(lead_id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('first_response','follow_up','qualify','offer','checkout','handoff','close','recycle')),
  channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 40),
  status text NOT NULL CHECK (status IN ('scheduled','completed','blocked','canceled')),
  due_at timestamptz,
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_actions_lead_due_idx ON sales_actions(lead_id,due_at);

CREATE TABLE IF NOT EXISTS unit_economics_snapshots (
  snapshot_id uuid PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end >= period_start),
  gross_revenue_brl numeric(14,2) NOT NULL DEFAULT 0,
  refunds_brl numeric(14,2) NOT NULL DEFAULT 0,
  payment_fees_brl numeric(14,2) NOT NULL DEFAULT 0,
  variable_costs_brl numeric(14,2) NOT NULL DEFAULT 0,
  acquisition_spend_brl numeric(14,2) NOT NULL DEFAULT 0,
  paid_orders integer NOT NULL DEFAULT 0 CHECK (paid_orders >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unit_economics_period_idx ON unit_economics_snapshots(period_start,period_end);
INSERT INTO schema_migrations (migration_id)
VALUES ('006_sales_machine')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
