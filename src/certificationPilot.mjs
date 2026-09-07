import crypto from 'node:crypto';
import { evaluateActivationReadiness } from './activationReadiness.mjs';
import { PROJECT, isUuid } from './config.mjs';
import { recordVerifiedLifecycleEvidence } from './lifecycleEvidenceRepository.mjs';

const yes=(value)=>String(value||'').toLowerCase()==='true';
const boundedInt=(value,fallback,min,max)=>{
  const parsed=Number.parseInt(String(value??''),10);
  return Number.isInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;
};

export function certificationPilotPolicy(env=process.env){
  const activation=evaluateActivationReadiness(env);
  const maxOrders=boundedInt(env.CERTIFICATION_PILOT_MAX_ORDERS,10,1,20);
  const ttlHours=boundedInt(env.CERTIFICATION_PILOT_INVITE_TTL_HOURS,72,1,168);
  const blockers=[];
  if(!yes(env.CERTIFICATION_PILOT_ENABLED)) blockers.push('certification_pilot_disabled');
  if(yes(env.SALE_GLOBALLY_ENABLED)) blockers.push('global_sales_must_remain_closed_during_certification_pilot');
  if(!yes(env.CHECKOUT_ENABLED)) blockers.push('checkout_disabled');
  if(!yes(env.FINANCIAL_EVENTS_ENABLED)) blockers.push('financial_events_disabled');
  if(!activation.ready) blockers.push(...activation.blockers);
  return Object.freeze({ready:blockers.length===0,max_orders:maxOrders,invite_ttl_hours:ttlHours,blockers:Object.freeze([...new Set(blockers)])});
}

export const hashCertificationPilotToken=(token)=>crypto.createHash('sha256').update(String(token||'')).digest('hex');
export function certificationPilotAmountBrl(env=process.env){
  const raw=Number(String(env.CERTIFICATION_PILOT_AMOUNT_BRL||'5').replace(',','.'));
  if(!Number.isFinite(raw)||raw<5||raw>50) throw new Error('certification_pilot_amount_invalid');
  return Math.round(raw*100)/100;
}
export async function createCertificationPilotInvite(sql,{createdBy,env=process.env,ttlHours}={}){
  const policy=certificationPilotPolicy(env);
  if(!policy.ready) throw new Error(`certification_pilot_not_ready:${policy.blockers.join(',')}`);
  const creator=String(createdBy||'').trim();
  if(!creator) throw new Error('certification_pilot_creator_required');
  const ttl=boundedInt(ttlHours,policy.invite_ttl_hours,1,168);
  const token=crypto.randomBytes(32).toString('base64url');
  const tokenSha256=hashCertificationPilotToken(token);
  const inviteId=crypto.randomUUID();
  const rows=await sql.query(`insert into certification_pilot_invites
    (invite_id,token_sha256,status,expires_at,created_by)
    values($1,$2,'active',now()+($3::text||' hours')::interval,$4)
    returning invite_id,expires_at`,[inviteId,tokenSha256,String(ttl),creator]);
  if(rows.length!==1) throw new Error('certification_pilot_invite_persist_failed');
  return Object.freeze({invite_id:rows[0].invite_id,token,expires_at:rows[0].expires_at,max_orders:1});
}

export async function authorizeCertificationPilotCheckout(sql,{token,sessionId,requestId,env=process.env}={}){
  const policy=certificationPilotPolicy(env);
  if(!policy.ready) return Object.freeze({authorized:false,reason:'pilot_policy_blocked',blockers:policy.blockers});
  if(!isUuid(sessionId)||!isUuid(requestId)) return Object.freeze({authorized:false,reason:'pilot_request_invalid'});
  const raw=String(token||'').trim();
  if(raw.length<32||raw.length>128) return Object.freeze({authorized:false,reason:'pilot_token_invalid'});
  const tokenSha256=hashCertificationPilotToken(raw);
  const existing=await sql.query(`select o.order_id,o.certification_pilot_invite_id from orders o
    join certification_pilot_invites i on i.invite_id=o.certification_pilot_invite_id
    where o.request_id=$1 and o.session_id=$2 and o.certification_pilot=true
      and i.token_sha256=$3 and i.status='active' and i.expires_at>now() limit 1`,[requestId,sessionId,tokenSha256]);
  if(existing.length===1) return Object.freeze({authorized:true,replay:true,invite_id:existing[0].certification_pilot_invite_id});
  const capacity=await sql.query(`select count(*)::int count from orders where certification_pilot=true`);
  if(Number(capacity?.[0]?.count||0)>=policy.max_orders) return Object.freeze({authorized:false,reason:'pilot_capacity_reached'});
  const claimed=await sql.query(`update certification_pilot_invites set
    bound_session_id=coalesce(bound_session_id,$2),request_id=coalesce(request_id,$3),claimed_at=coalesce(claimed_at,now())
    where token_sha256=$1 and status='active' and expires_at>now()
      and (bound_session_id is null or bound_session_id=$2)
      and (request_id is null or request_id=$3)
    returning invite_id`,[tokenSha256,sessionId,requestId]);
  if(claimed.length!==1) return Object.freeze({authorized:false,reason:'pilot_invite_unavailable'});
  return Object.freeze({authorized:true,replay:false,invite_id:claimed[0].invite_id});
}

export function certificationPilotStatus(env=process.env){
  const policy=certificationPilotPolicy(env);
  return Object.freeze({enabled:yes(env.CERTIFICATION_PILOT_ENABLED),ready:policy.ready,max_orders:policy.max_orders,blockers:policy.blockers});
}

export async function revokeCertificationPilotInvite(sql,{inviteId,revokedBy}={}){
  if(!isUuid(inviteId)) throw new Error('certification_pilot_invite_id_invalid');
  const actor=String(revokedBy||'').trim();
  if(!actor) throw new Error('certification_pilot_revoker_required');
  const rows=await sql.query(`update certification_pilot_invites set status='revoked'
    where invite_id=$1 and status='active' returning invite_id,status`,[inviteId]);
  if(rows.length===1) return Object.freeze({revoked:true,invite_id:rows[0].invite_id,status:rows[0].status});
  const existing=await sql.query(`select invite_id,status from certification_pilot_invites where invite_id=$1 limit 1`,[inviteId]);
  if(existing[0]?.status==='revoked') return Object.freeze({revoked:true,invite_id:inviteId,status:'revoked',idempotent:true});
  throw new Error('certification_pilot_invite_not_found');
}

export async function recordCertificationPilotCheckoutEvidence(sql,{orderId,sessionId,provider}={}){
  if(!isUuid(orderId)||!isUuid(sessionId)) return Object.freeze({recorded:false,reason:'pilot_checkout_identity_invalid'});
  const providerName=String(provider||'').toLowerCase();
  if(!['asaas','mercadopago'].includes(providerName)) return Object.freeze({recorded:false,reason:'pilot_checkout_provider_invalid'});
  const verified=await sql.query(`select o.order_id from orders o
    join certification_pilot_invites i on i.invite_id=o.certification_pilot_invite_id
    where o.order_id=$1 and o.session_id=$2 and o.provider=$3 and o.certification_pilot=true
      and o.status='checkout_ready' and i.status='active' and i.expires_at>now() limit 1`,[orderId,sessionId,providerName]);
  if(verified.length!==1) return Object.freeze({recorded:false,reason:'pilot_checkout_not_verified'});
  await sql.query(`insert into sales_leads(lead_id,session_id,channel,stage,touchpoints,updated_at)
    values($1,$2,'certification_pilot','checkout_started',0,now())
    on conflict(session_id) do update set
      stage=case when sales_leads.stage in ('new','contacted','qualified','offer_sent') then 'checkout_started' else sales_leads.stage end,
      channel=case when sales_leads.stage in ('new','contacted','qualified','offer_sent','checkout_started') then 'certification_pilot' else sales_leads.channel end,
      updated_at=now()`,[crypto.randomUUID(),sessionId]);  const proof=await recordVerifiedLifecycleEvidence(sql,{
    dimension:'checkout',source_class:'canonical_database',source:'certification-pilot-checkout',
    subject_ref:orderId,idempotency_key:`certification-pilot-checkout:${orderId}`,
    metadata:{provider:providerName,offer_id:PROJECT.offerId,experiment_id:PROJECT.experimentId},
  });
  return Object.freeze({recorded:true,evidence_inserted:proof.inserted===true,evidence_sha256:proof.evidence_sha256});
}
