import { randomUUID } from 'node:crypto';
import { CUSTOMER_LIFECYCLE_STAGES } from './customerLifecycleEngine.mjs';
import { recordVerifiedLifecycleEvidence } from './lifecycleEvidenceRepository.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventDimension=Object.freeze({onboarding_completed:'onboarding',support_opened:'support',support_resolved:'support',adoption_updated:'adoption',satisfaction_recorded:'satisfaction',retention_intervention:'retention',repurchase:'repurchase',upsell:'upsell',cross_sell:'cross_sell',referral:'referral',win_back:'win_back',churn:'churn'});
const eventStage=Object.freeze({
  onboarding_started:'onboarding',onboarding_completed:'adoption',support_opened:'support',support_resolved:'adoption',
  adoption_updated:'adoption',satisfaction_recorded:'satisfaction',retention_intervention:'retention',repurchase:'repurchase',
  upsell:'upsell',cross_sell:'cross_sell',referral:'referral',win_back:'win_back',churn:'churned',
});
const validUuid=(value)=>uuid.test(String(value||''));
const bounded=(value)=>value===null||value===undefined?null:Math.max(0,Math.min(1,Number(value)||0));

export async function ensureCustomerProfile(sql,input={}){
  if(!validUuid(input.customer_id)) throw new Error('customer_id_invalid');
  if(input.lead_id && !validUuid(input.lead_id)) throw new Error('lead_id_invalid');
  const stage=CUSTOMER_LIFECYCLE_STAGES.includes(input.stage)?input.stage:'onboarding';
  const rows=await sql.query(`insert into customer_lifecycle_profiles
    (customer_id,lead_id,stage,purchase_count,adoption_score,satisfaction_score,support_risk,last_activity_at)
    values($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict(customer_id) do update set lead_id=coalesce(excluded.lead_id,customer_lifecycle_profiles.lead_id),updated_at=now()
    returning customer_id,lead_id,stage,purchase_count,adoption_score,satisfaction_score,support_risk,onboarding_completed_at,last_activity_at,churned_at`,
    [input.customer_id,input.lead_id||null,stage,Math.max(0,Math.trunc(Number(input.purchase_count)||0)),bounded(input.adoption_score),bounded(input.satisfaction_score),bounded(input.support_risk),input.last_activity_at||null]);
  return rows[0]||null;
}
export async function recordCustomerLifecycleEvent(sql,input={}){
  if(!validUuid(input.customer_id)) throw new Error('customer_id_invalid');
  if(input.order_id && !validUuid(input.order_id)) throw new Error('order_id_invalid');
  const eventType=String(input.event_type||''); const stage=eventStage[eventType];
  if(!stage) throw new Error('lifecycle_event_invalid');
  const key=String(input.idempotency_key||'').trim(); if(key.length<8||key.length>240) throw new Error('idempotency_key_invalid');
  const source=String(input.source||'system').trim().slice(0,80); if(!source) throw new Error('lifecycle_source_invalid');
  const eventId=validUuid(input.event_id)?String(input.event_id):randomUUID();
  const rows=await sql.query(`with ins as (
    insert into customer_lifecycle_events(event_id,customer_id,order_id,event_type,source,idempotency_key,metadata,occurred_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,coalesce($8::timestamptz,now()))
    on conflict(idempotency_key) do nothing returning customer_id,event_type,occurred_at
  ) update customer_lifecycle_profiles p set stage=$9,
    purchase_count=p.purchase_count+case when $4='repurchase' then 1 else 0 end,
    onboarding_completed_at=case when $4='onboarding_completed' then coalesce((select occurred_at from ins),now()) else p.onboarding_completed_at end,
    churned_at=case when $4='churn' then coalesce((select occurred_at from ins),now()) else p.churned_at end,
    last_activity_at=coalesce((select occurred_at from ins),p.last_activity_at),updated_at=now()
    where p.customer_id=$2 and exists(select 1 from ins)
    returning p.customer_id,p.stage,p.purchase_count,p.last_activity_at,p.churned_at`,
    [eventId,input.customer_id,input.order_id||null,eventType,source,key,JSON.stringify(input.metadata||{}),input.occurred_at||null,stage]);
  const inserted=rows.length===1;
  if(inserted&&eventDimension[eventType]){try{await recordVerifiedLifecycleEvidence(sql,{dimension:eventDimension[eventType],source_class:'canonical_database',source:'customer_lifecycle_events',subject_ref:input.customer_id,idempotency_key:`lifecycle-evidence:${eventType}:${eventId}`,metadata:{event_type:eventType}});}catch{}}
  return Object.freeze({inserted,profile:rows[0]||null,event_id:eventId,event_type:eventType});
}
export async function recordAttributionTouchpoint(sql,input={}){
  if(input.session_id && !validUuid(input.session_id)) throw new Error('session_id_invalid');
  if(input.lead_id && !validUuid(input.lead_id)) throw new Error('lead_id_invalid');
  if(input.order_id && !validUuid(input.order_id)) throw new Error('order_id_invalid');
  const channel=String(input.channel||'').trim().toLowerCase(); if(channel.length<1||channel.length>40) throw new Error('channel_invalid');
  const key=String(input.idempotency_key||'').trim(); if(key.length<8||key.length>240) throw new Error('idempotency_key_invalid');
  const id=validUuid(input.touchpoint_id)?String(input.touchpoint_id):randomUUID();
  const rows=await sql.query(`insert into attribution_touchpoints
    (touchpoint_id,session_id,lead_id,order_id,channel,source_ref,campaign_ref,idempotency_key,metadata,occurred_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,coalesce($10::timestamptz,now()))
    on conflict(idempotency_key) do nothing returning touchpoint_id,channel,occurred_at`,
    [id,input.session_id||null,input.lead_id||null,input.order_id||null,channel,String(input.source_ref||'').slice(0,240)||null,String(input.campaign_ref||'').slice(0,240)||null,key,JSON.stringify(input.metadata||{}),input.occurred_at||null]);
  const inserted=rows.length===1;
  if(inserted){try{await recordVerifiedLifecycleEvidence(sql,{dimension:'attribution',source_class:'canonical_database',source:'attribution_touchpoints',subject_ref:input.order_id||input.session_id||id,idempotency_key:`attribution-evidence:${id}`,metadata:{channel}});}catch{}}
  return Object.freeze({inserted,touchpoint:rows[0]||null,touchpoint_id:id});
}

export async function loadAttributionTouchpoints(sql,{order_id=null,session_id=null}={}){
  if(order_id&& !validUuid(order_id)) throw new Error('order_id_invalid');
  if(session_id&& !validUuid(session_id)) throw new Error('session_id_invalid');
  if(!order_id&&!session_id) throw new Error('attribution_scope_required');
  return sql.query(`select touchpoint_id as id,channel,occurred_at from attribution_touchpoints
    where ($1::uuid is not null and order_id=$1) or ($2::uuid is not null and session_id=$2)
    order by occurred_at asc,touchpoint_id asc`,[order_id,session_id]);
}
