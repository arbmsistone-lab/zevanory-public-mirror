import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  if (req.method !== 'POST') {
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const expected=process.env.ZEVANORY_MIGRATION_TOKEN;
  const provided=String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!expected || provided !== expected) {
    res.statusCode=401;
    return res.end(JSON.stringify({error:'unauthorized'}));
  }
  if (!process.env.DATABASE_URL) {
    res.statusCode=503;
    return res.end(JSON.stringify({error:'database_unavailable'}));
  }
  const sql=neon(process.env.DATABASE_URL);
  try {
    await sql(`CREATE TABLE IF NOT EXISTS telemetry_events (
      event_id uuid PRIMARY KEY,
      event_name text NOT NULL CHECK (event_name IN ('page_view','cta_whatsapp','lead_qualified','offer_sent','checkout_started','payment_confirmed','refund_confirmed')),
      session_id uuid NOT NULL,
      experiment_id text NOT NULL,
      offer_id text NOT NULL,
      channel text NOT NULL CHECK (length(channel) BETWEEN 1 AND 40),
      source text NOT NULL DEFAULT 'web',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      received_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql(`CREATE INDEX IF NOT EXISTS telemetry_events_session_idx ON telemetry_events (session_id, occurred_at)`);
    await sql(`CREATE INDEX IF NOT EXISTS telemetry_events_experiment_idx ON telemetry_events (experiment_id, event_name, occurred_at)`);
    await sql(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql(`INSERT INTO schema_migrations (migration_id) VALUES ('001_telemetry_events') ON CONFLICT (migration_id) DO NOTHING`);
    const rows=await sql(`SELECT migration_id FROM schema_migrations WHERE migration_id='001_telemetry_events'`);
    res.statusCode=200;
    return res.end(JSON.stringify({migrated:rows.length===1}));
  } catch {
    res.statusCode=500;
    return res.end(JSON.stringify({error:'migration_failed'}));
  }
}
