import { neon } from '@neondatabase/serverless';
import { buildSystemHealth } from '../src/systemHealth.mjs';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  let databaseReachable = false;
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      const rows = await sql.query('select 1::int as ok');
      databaseReachable = rows[0]?.ok === 1;
    } catch {
      databaseReachable = false;
    }
  }

  const health = buildSystemHealth({ databaseReachable });
  res.statusCode = health.ready ? 200 : 503;
  return res.end(JSON.stringify(health));
}
