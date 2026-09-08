const WHATSAPP_RANK=Object.freeze({sent:10,delivered:20,read:30,failed:40,deleted:50});
const RESEND_RANK=Object.freeze({sent:10,delivery_delayed:15,delivered:20,opened:30,clicked:40,bounced:50,complained:60,failed:70,suppressed:80});

const clean=(value,max=500)=>String(value||'').trim().slice(0,max);
const finiteMillis=(value)=>{const n=Number(value);return Number.isFinite(n)&&n>0?Math.floor(n):null;};
const isoMillis=(value)=>{const n=Date.parse(String(value||''));return Number.isFinite(n)?n:null;};

export function confirmationOutcome(status){
  const value=clean(status,40).toLowerCase();
  if(['delivered','read','opened','clicked','deleted'].includes(value))return 'confirmed';
  if(['failed','bounced','complained','suppressed'].includes(value))return 'failed';
  return 'pending';
}

export function normalizeWhatsappStatusPayload(payload={}){
  if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return [];
  const output=[];
  for(const entry of payload.entry){for(const change of entry?.changes||[]){
    if(change?.field!=='messages'||!Array.isArray(change?.value?.statuses))continue;
    for(const item of change.value.statuses){
      const status=clean(item?.status,40).toLowerCase(),messageId=clean(item?.id,300);
      const occurredAtMs=finiteMillis(Number(item?.timestamp)*1000),rank=WHATSAPP_RANK[status];
      if(!messageId||!occurredAtMs||!rank)continue;
      output.push(Object.freeze({provider:'meta_whatsapp',destination:'channel:whatsapp',provider_message_id:messageId,status,rank,occurred_at_ms:occurredAtMs,provider_event_id:`meta:${messageId}:${status}:${item.timestamp}`}));
    }
  }}
  return Object.freeze(output);
}
export function normalizeResendDeliveryEvent(event={}){
  const type=clean(event?.type,80).toLowerCase();
  const status=type.startsWith('email.')?type.slice(6).replace(/\./g,'_'):'';
  const messageId=clean(event?.data?.email_id||event?.data?.id,300),rank=RESEND_RANK[status];
  const occurredAtMs=isoMillis(event?.created_at||event?.createdAt||event?.data?.created_at)||Date.now();
  if(!messageId||!rank)return null;
  return Object.freeze({provider:'resend',destination:'channel:email',provider_message_id:messageId,status,rank,occurred_at_ms:occurredAtMs,provider_event_id:clean(event?.id,300)||`resend:${messageId}:${status}:${occurredAtMs}`});
}

export async function attachProviderAcceptance(sql,{eventId,result}={}){
  const providerMessageId=clean(result?.provider_message_id||result?.provider_post_id||result?.provider_media_id,300);
  if(!eventId||!providerMessageId)return false;
  const provider=clean(result?.provider,80),acceptedAt=new Date().toISOString();
  const rows=await sql.query(`update integration_outbox set headers=coalesce(headers,'{}'::jsonb)||$2::jsonb,status='delivered',delivered_at=now(),last_error=null
    where event_id=$1 and status='processing' returning event_id`,[eventId,JSON.stringify({provider_acceptance:{provider,provider_message_id:providerMessageId,accepted_at:acceptedAt}})]);
  return rows.length===1;
}

export async function applyProviderConfirmation(sql,confirmation={}){
  const messageId=clean(confirmation.provider_message_id,300),destination=clean(confirmation.destination,120),status=clean(confirmation.status,40),provider=clean(confirmation.provider,80);
  const rank=Number(confirmation.rank)||0,occurredAtMs=Number(confirmation.occurred_at_ms)||0,eventId=clean(confirmation.provider_event_id,300);
  if(!messageId||!destination||!status||!provider||!rank||!occurredAtMs||!eventId)throw new Error('provider_confirmation_invalid');
  const confirmationRecord={provider,provider_event_id:eventId,provider_message_id:messageId,status,rank,occurred_at_ms:occurredAtMs,outcome:confirmationOutcome(status),confirmed_at:new Date().toISOString()};
  const state=confirmationRecord.outcome==='confirmed'?'executed':confirmationRecord.outcome==='failed'?'failed':'executed';
  const actionUpdate={state,updated_at:new Date().toISOString(),evidence:{provider_confirmation:confirmationRecord}};
  const rows=await sql.query(`with updated_outbox as (
      update integration_outbox set headers=jsonb_set(coalesce(headers,'{}'::jsonb),'{provider_confirmation}',$4::jsonb,true)
      where event_id=(select event_id from integration_outbox where destination=$1 and headers->'provider_acceptance'->>'provider_message_id'=$2 order by created_at desc limit 1)
        and (coalesce((headers->'provider_confirmation'->>'occurred_at_ms')::bigint,0)<$3 or (coalesce((headers->'provider_confirmation'->>'occurred_at_ms')::bigint,0)=$3 and coalesce((headers->'provider_confirmation'->>'rank')::int,0)<$5))
      returning event_id,run_id,headers
    ), updated_job as (
      update agent_jobs j set payload=jsonb_set(j.payload,'{live_action_plan}',(j.payload->'live_action_plan') || ($6::jsonb || jsonb_build_object('evidence',coalesce(j.payload->'live_action_plan'->'evidence','{}'::jsonb) || jsonb_build_object('event_id',u.event_id))),true)
      from updated_outbox u where u.run_id is not null and j.payload->'live_action_plan'->>'run_id'=u.run_id::text returning j.job_id
    )
    select u.event_id,u.run_id,u.headers,(select count(*)::int from updated_job) updated_jobs from updated_outbox u`,[destination,messageId,occurredAtMs,JSON.stringify(confirmationRecord),rank,JSON.stringify(actionUpdate)]);
  const event=rows[0]||null;
  return Object.freeze({updated:rows.length===1,event});
}
