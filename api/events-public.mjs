import { neon } from '@neondatabase/serverless';
import { normalizePublicEvent } from '../src/publicEvent.mjs';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  if (!process.env.DATABASE_URL) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'telemetry_storage_unavailable', accepted: false }));
  }
  const event = normalizePublicEvent(req.body);
  if (!event) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'invalid_event', accepted: false }));
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(`
      INSERT INTO telemetry_events
        (event_id,event_name,session_id,experiment_id,offer_id,channel,source)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `, [event.event_id,event.event_name,event.session_id,event.experiment_id,event.offer_id,event.channel,event.source]);
    res.statusCode = 202;
    return res.end(JSON.stringify({ accepted: true, duplicate: rows.length === 0 }));
  } catch {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'telemetry_storage_error', accepted: false }));
  }
}
