import { randomUUID, createHash } from 'node:crypto';

const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const metadata=(headers={})=>({run_id:headers?.run_id||null,trace_id:headers?.trace_id||null});

export function buildOutboxEvent({aggregateType,aggregateId,eventType,destination,payload={},headers={},idempotencyKey,traceId=null,runId=null}={}){
  if(!aggregateType||!aggregateId||!eventType||!destination) throw new Error('outbox_event_invalid');
  const safeHeaders={...headers};
  if(traceId) safeHeaders.trace_id=String(traceId);
  if(runId) safeHeaders.run_id=String(runId);
  return Object.freeze({
    event_id:randomUUID(),aggregate_type:String(aggregateType),aggregate_id:String(aggregateId),
    event_type:String(eventType),destination:String(destination),payload,headers:Object.freeze(safeHeaders),
    idempotency_key:String(idempotencyKey||digest({aggregateType,aggregateId,eventType,destination,payload})),
  });
}

export async function enqueueOutbox(sql,event){
  const e=buildOutboxEvent(event);
  const rows=await sql.query(`insert into integration_outbox(event_id,aggregate_type,aggregate_id,event_type,destination,payload,headers,idempotency_key)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
    on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
    returning event_id,status,destination,headers`,[e.event_id,e.aggregate_type,e.aggregate_id,e.event_type,e.destination,JSON.stringify(e.payload),JSON.stringify(e.headers),e.idempotency_key]);
  const row=rows[0]||{};
  return Object.freeze({...row,...metadata(row.headers)});
}
export async function claimOutboxEvent(sql){
  const rows=await sql.query(`update integration_outbox set status='processing',locked_at=now(),attempts=attempts+1
    where event_id=(select event_id from integration_outbox where status in ('pending','retry') and available_at<=now()
    order by available_at asc,created_at asc for update skip locked limit 1) returning *`);
  return rows[0]||null;
}

export async function claimChannelOutboxEvent(sql){
  const rows=await sql.query(`update integration_outbox set status='processing',locked_at=now(),attempts=attempts+1
    where event_id=(select event_id from integration_outbox where status in ('pending','retry') and available_at<=now() and destination like 'channel:%'
    order by available_at asc,created_at asc for update skip locked limit 1) returning *`);
  return rows[0]||null;
}

export function nextRetryDelayMs(attempts){
  const n=Math.max(1,Math.min(20,Number(attempts)||1));
  return Math.min(3600000,1000*(2**Math.min(n-1,12)));
}

async function dispatchClaimedEvent(sql,event,adapters={}){
  if(!event) return Object.freeze({ok:true,processed:false,reason:'outbox_empty'});
  const adapter=adapters[event.destination];
  const meta=metadata(event.headers||{});
  if(typeof adapter!=='function'){
    await sql.query("update integration_outbox set status='dead_letter',last_error='adapter_missing' where event_id=$1",[event.event_id]);
    return Object.freeze({ok:false,processed:true,event_id:event.event_id,status:'dead_letter',reason:'adapter_missing',...meta});
  }
  try{
    const result=await adapter(Object.freeze({...event,payload:event.payload||{},headers:event.headers||{}}));
    await sql.query("update integration_outbox set status='delivered',delivered_at=now(),last_error=null where event_id=$1",[event.event_id]);
    return Object.freeze({ok:true,processed:true,event_id:event.event_id,status:'delivered',result,...meta});
  }catch(error){
    const attempts=Number(event.attempts)||1;const terminal=attempts>=20;const delay=nextRetryDelayMs(attempts);
    await sql.query(`update integration_outbox set status=$2,last_error=$3,
      available_at=case when $2='retry' then now()+($4::text||' milliseconds')::interval else available_at end where event_id=$1`,
      [event.event_id,terminal?'dead_letter':'retry',String(error?.message||'delivery_failed').slice(0,500),delay]);
    return Object.freeze({ok:false,processed:true,event_id:event.event_id,status:terminal?'dead_letter':'retry',retry_in_ms:terminal?null:delay,...meta});
  }
}

export async function dispatchOutboxOnce(sql,adapters={}){
  return dispatchClaimedEvent(sql,await claimOutboxEvent(sql),adapters);
}

export async function dispatchChannelOutboxOnce(sql,adapters={}){
  return dispatchClaimedEvent(sql,await claimChannelOutboxEvent(sql),adapters);
}
