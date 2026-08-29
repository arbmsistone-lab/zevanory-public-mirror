import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { OPERATOR_EVENTS, sanitizeText } from '../src/telemetry.mjs';
import { PROJECT, isUuid } from '../src/config.mjs';
import { safeBearerEqual } from '../src/security.mjs';
import { salesStageRank } from '../src/salesPipeline.mjs';

const stageFor=Object.freeze({lead_qualified:'qualified',offer_sent:'offer_sent',checkout_started:'checkout_started'});

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const token=String(process.env.OPERATOR_TOKEN||''); const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(token,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'operator_auth_required'}));}
  if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'operational_storage_unavailable'}));}
  const body=req.body && typeof req.body==='object'?req.body:{};
  const name=sanitizeText(body.name,60); const eventId=String(body.event_id||'').toLowerCase(); const sessionId=String(body.session_id||'').toLowerCase(); const channel=sanitizeText(body.channel,40);
  if(!OPERATOR_EVENTS.has(name)||!isUuid(eventId)||!isUuid(sessionId)||!channel){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_event'}));}
  try{
    const sql=neon(process.env.DATABASE_URL); const stage=stageFor[name];
    const existing=await sql.query('select stage from sales_leads where session_id=$1 limit 1',[sessionId]);
    const current=existing[0]?.stage||null;
    if(current!==null && salesStageRank(stage)<salesStageRank(current)){res.statusCode=409;return res.end(JSON.stringify({error:'invalid_sales_transition'}));}
    const rows=await sql.query(`
      with inserted_event as (
        insert into telemetry_events(event_id,event_name,session_id,experiment_id,offer_id,channel,source)
        values($1,$2,$3,$4,$5,$6,'operator') on conflict(event_id) do nothing returning event_id
      ), lead_upsert as (
        insert into sales_leads(lead_id,session_id,channel,stage,touchpoints,updated_at)
        select $7,$3,$6,$8,0,now() where exists(select 1 from inserted_event)
        on conflict(session_id) do update set stage=$8,channel=excluded.channel,updated_at=now()
        returning lead_id
      )
      insert into agent_jobs(job_id,job_type,status,priority,lead_id,idempotency_key,payload,available_at)
      select $9,'lead_review','queued',90,lead_id,$10,$11::jsonb,now() from lead_upsert
      on conflict(idempotency_key) do nothing returning job_id
    `,[eventId,name,sessionId,PROJECT.experimentId,PROJECT.offerId,channel,randomUUID(),stage,randomUUID(),`operator-event:${eventId}`,JSON.stringify({source:'operator_event',event_name:name})]);
    res.statusCode=202; return res.end(JSON.stringify({accepted:true,agent_job_queued:rows.length>0}));
  }catch{res.statusCode=503;return res.end(JSON.stringify({error:'operator_event_storage_error'}));}
}
