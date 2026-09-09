import { randomUUID, createHash } from 'node:crypto';
import { attachProviderAcceptance } from './providerConfirmation.mjs';
import { classifyDeliveryFailure } from './providerDelivery.mjs';
import { executeUniversallySafely } from './universalExecutionFabric.mjs';

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
  const rows = await sql.query(`update integration_outbox set status='processing',locked_at=now(),attempts=attempts+1
    where event_id=(select event_id from integration_outbox where status in ('pending','retry') and available_at<=now()
      order by available_at asc,created_at asc for update skip locked limit 1) returning *`);
  return rows[0]||null;
}

export async function claimChannelOutboxEvent(sql){
  const rows = await sql.query(`update integration_outbox set status='processing',locked_at=now(),attempts=attempts+1
    where event_id=(select event_id from integration_outbox where status in ('pending','retry') and available_at<=now() and destination like 'channel:%'
      order by available_at asc,created_at asc for update skip locked limit 1) returning *`);
  return rows[0]||null;
}

export function nextRetryDelayMs(attempts){
  const n=Math.max(1,Math.min(20,Number(attempts)||1));
  return Math.min(3600000,1000*(2**Math.min(n-1,12)));
}

async function preserveForRetry(sql,event,reason,delay=nextRetryDelayMs(event?.attempts)){
  const attempts=Number(event?.attempts)||1;
  if(attempts>=20){
    const terminalReason='retry_limit_exhausted';
    const detail=terminalReason+':'+String(reason||'provider_unavailable').slice(0,460);
    await sql.query("update integration_outbox set status='dead_letter',last_error=$2 where event_id=$1",[event.event_id,detail]);
    return Object.freeze({ok:false,processed:true,preserved:true,event_id:event.event_id,status:'dead_letter',retry_in_ms:null,reason:terminalReason,...metadata(event.headers||{})});
  }
  await sql.query(`update integration_outbox set status='retry',last_error=$2,
    available_at=now()+($3::text||' milliseconds')::interval where event_id=$1`,
    [event.event_id,String(reason||'provider_unavailable').slice(0,500),delay]);
  return Object.freeze({ok:false,processed:true,preserved:true,event_id:event.event_id,status:'retry',retry_in_ms:delay,reason:String(reason||'provider_unavailable').slice(0,500),...metadata(event.headers||{})});
}

async function executeAdapter(event,adapter,sql){
  const frozen=Object.freeze({...event,payload:event.payload||{},headers:event.headers||{}});
  if(typeof adapter==='function') return adapter(frozen,{sql});
  if(Array.isArray(adapter)){
    const routed=await executeUniversallySafely({operation:frozen,providers:adapter,requirements:{capabilities:[String(event.destination)],zeroCost:true}});
    if(!routed.ok){const error=new Error(routed.reason);error.routed=routed;error.ambiguous=Boolean(routed.reconciliation_required);throw error;}
    return Object.freeze({...routed.result,execution_provider:routed.provider,execution_attempts:routed.attempts});
  }
  throw new Error('adapter_missing');
}
async function dispatchClaimedEvent(sql,event,adapters={}){
  if(!event) return Object.freeze({ok:true,processed:false,reason:'outbox_empty'});
  const adapter=adapters[event.destination];
  const meta=metadata(event.headers||{});
  if(!adapter) return preserveForRetry(sql,event,'adapter_unavailable');
  try{
    const result=await executeAdapter(event,adapter,sql);
    const persisted=await attachProviderAcceptance(sql,{eventId:event.event_id,result});
    if(!persisted){
      await sql.query("update integration_outbox set status='dead_letter',last_error='provider_acceptance_persistence_uncertain' where event_id=$1",[event.event_id]);
      return Object.freeze({ok:false,processed:true,event_id:event.event_id,status:'dead_letter',reason:'provider_acceptance_persistence_uncertain',result,...meta});
    }
    return Object.freeze({ok:true,processed:true,event_id:event.event_id,status:'delivered',result,...meta});
  }catch(error){
    if(error?.ambiguous||error?.routed?.reconciliation_required){
      await sql.query("update integration_outbox set status='dead_letter',last_error='provider_delivery_uncertain_manual_reconciliation' where event_id=$1",[event.event_id]);
      return Object.freeze({ok:false,processed:true,preserved:true,event_id:event.event_id,status:'dead_letter',retry_in_ms:null,reason:'provider_delivery_uncertain_manual_reconciliation',...meta});
    }
    const attempts=Number(event.attempts)||1;const delay=nextRetryDelayMs(attempts);
    if(error?.retryable||error?.routed?.retryable) return preserveForRetry(sql,event,error.code||error.routed?.reason||error.message,delay);
    if(error?.routed?.reason==='no_qualified_provider_available') return preserveForRetry(sql,event,error.routed.reason,delay);
    const classification=classifyDeliveryFailure(error,event.destination);
    if(classification.status==='retry') return preserveForRetry(sql,event,classification.reason,delay);
    await sql.query("update integration_outbox set status='dead_letter',last_error=$2 where event_id=$1",[event.event_id,String(classification.reason||'delivery_failed').slice(0,500)]);
    return Object.freeze({ok:false,processed:true,preserved:true,event_id:event.event_id,status:'dead_letter',reason:classification.reason,...meta});
  }
}

export async function dispatchOutboxOnce(sql,adapters={}){
  return dispatchClaimedEvent(sql,await claimOutboxEvent(sql),adapters);
}

export async function dispatchChannelOutboxOnce(sql,adapters={}){
  return dispatchClaimedEvent(sql,await claimChannelOutboxEvent(sql),adapters);
}
