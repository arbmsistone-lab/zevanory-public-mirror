import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalizePublicEvent } from '../src/publicEvent.mjs';
import { readJsonRequestBody, validatePublicApiRequest } from '../src/security.mjs';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error:'method_not_allowed' })); }
  const requestSafety = validatePublicApiRequest(req);
  if (!requestSafety.ok) { res.statusCode=requestSafety.status; return res.end(JSON.stringify({ error:requestSafety.error, accepted:false })); }
  if (!process.env.DATABASE_URL) { res.statusCode=503; return res.end(JSON.stringify({ error:'telemetry_storage_unavailable', accepted:false })); }
  const event=normalizePublicEvent(await readJsonRequestBody(req));
  if(!event){ res.statusCode=400; return res.end(JSON.stringify({ error:'invalid_event', accepted:false })); }
  try {
    const sql=neon(process.env.DATABASE_URL);
    const rate=await sql.query("select count(*)::int as count from telemetry_events where session_id=$1 and received_at>now()-interval '1 minute'",[event.session_id]);
    if(Number(rate[0]?.count||0)>= 60){res.statusCode=429;return res.end(JSON.stringify({ error: 'rate_limited', accepted: false }));}
    const rows=await sql.query(`
      with inserted_event as (
        insert into telemetry_events(event_id,event_name,session_id,experiment_id,offer_id,channel,source)
        values($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (event_id) DO NOTHING
        returning event_id
      ), lead_upsert as (
        insert into sales_leads(lead_id,session_id,channel,stage,touchpoints,updated_at)
        select $8,$3,$6,'new',0,now() where $2='cta_whatsapp' and exists(select 1 from inserted_event)
        on conflict(session_id) do update set channel=excluded.channel,updated_at=now()
        returning lead_id
      )
      insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at)
      select $9,'lead_review','queued',80,lead_id,$10,$11::jsonb,now() from lead_upsert
      on conflict(idempotency_key) do nothing
      returning job_id
    `,[event.event_id,event.event_name,event.session_id,event.experiment_id,event.offer_id,event.channel,event.source,randomUUID(),randomUUID(),`public-cta:${event.session_id}`,JSON.stringify({source:'public_event',event_name:event.event_name})]);
    const duplicate=rows.length===0 && event.event_name==='cta_whatsapp';
    res.statusCode=202;
    return res.end(JSON.stringify({accepted:true,duplicate,agent_job_queued:rows.length>0}));
  } catch {
    res.statusCode=503;
    return res.end(JSON.stringify({error:'telemetry_storage_error',accepted:false}));
  }
}
