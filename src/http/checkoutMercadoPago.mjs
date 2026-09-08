import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { PROJECT } from '../config.mjs';
import { salesGate } from '../salesGate.mjs';
import { authorizeCertificationPilotCheckout, recordCertificationPilotCheckoutEvidence, certificationPilotAmountBrl } from '../certificationPilot.mjs';
import { preserveFinancialReconciliation, preserveCheckoutIntent } from '../financialReconciliationFabric.mjs';
import { normalizeCheckoutRequest,checkoutReplayDecision,externalReferenceForOrder,safePublicBaseUrl } from '../order.mjs';
import { buildMercadoPagoPreference,normalizeMercadoPagoPreference,MERCADOPAGO_API_BASE } from '../mercadopago.mjs';

export async function createMercadoPagoPreference(payload,accessToken,fetchImpl=fetch){
  const response=await fetchImpl(`${MERCADOPAGO_API_BASE}/checkout/preferences`,{
    method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${accessToken}`},body:JSON.stringify(payload),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(`mercadopago_preference_${response.status}`);
  return data;
}
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const input=normalizeCheckoutRequest(req.body); if(!input) return json(res,400,{error:'invalid_checkout_request'});
  const gate=salesGate();
  const pilotToken=String(req.headers?.['x-certification-pilot-token']||'').trim();
  if(!gate.enabled&&!pilotToken) return json(res,503,{error:'sales_globally_blocked',blockers:gate.blockers});
  if(process.env.CHECKOUT_ENABLED!=='true') return json(res,503,{error:'checkout_disabled'});
  const env=String(process.env.MERCADOPAGO_ENV||'').toLowerCase(); if(!['sandbox','production'].includes(env)) return json(res,503,{error:'checkout_environment_invalid'});
  const publicBase=safePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  if(!process.env.MERCADOPAGO_ACCESS_TOKEN||!publicBase) return json(res,503,{error:'checkout_provider_unavailable'});
  if(!process.env.DATABASE_URL){
    if(!gate.enabled)return json(res,503,{error:'checkout_storage_unavailable'});
    const preserved=await preserveCheckoutIntent({provider:'mercadopago',requestId:input.requestId,sessionId:input.sessionId,offerId:input.offer.id,amountBrl:input.offer.price_brl});
    return json(res,preserved.preserved?202:503,{accepted:preserved.preserved,preserved:preserved.preserved,pending_storage:preserved.pending_storage,provider_called:false,error:preserved.preserved?undefined:'checkout_storage_unavailable'});
  }
  const sql=neon(process.env.DATABASE_URL);
  let pilot=null;
  if(!gate.enabled){
    pilot=await authorizeCertificationPilotCheckout(sql,{token:pilotToken,sessionId:input.sessionId,requestId:input.requestId});
    if(!pilot.authorized) return json(res,503,{error:'sales_globally_blocked',blockers:gate.blockers,pilot_reason:pilot.reason});
  } const pilotSandbox=Boolean(pilot?.authorized)&&String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE||'').toLowerCase()==='sandbox'; const checkoutEnv=pilotSandbox?'sandbox':env; const providerToken=pilotSandbox?String(process.env.MERCADOPAGO_TEST_ACCESS_TOKEN||''):String(process.env.MERCADOPAGO_ACCESS_TOKEN||''); if(!providerToken)return json(res,503,{error:'checkout_provider_unavailable'}); const effectiveOffer=pilot?.authorized?Object.freeze({...input.offer,price_brl:certificationPilotAmountBrl(process.env)}):input.offer; const orderId=crypto.randomUUID(); const externalReference=externalReferenceForOrder(orderId);
  try{
    const inserted=await sql.query(`INSERT INTO orders (order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status,certification_pilot,certification_pilot_invite_id) VALUES ($1,$2,$3,$4,$5,$6,'BRL','mercadopago',$7,'created',$8,$9) ON CONFLICT (request_id) DO NOTHING RETURNING order_id`,[orderId,input.requestId,input.sessionId,PROJECT.experimentId,input.offer.id,effectiveOffer.price_brl,externalReference,Boolean(pilot?.authorized),pilot?.invite_id||null]);
    let order=inserted.length?{order_id:orderId,external_reference:externalReference,status:'created'}:(await sql.query(`SELECT order_id,session_id,offer_id,external_reference,status,checkout_url,provider FROM orders WHERE request_id=$1`,[input.requestId]))[0];
    if(!order) return json(res,503,{error:'order_lookup_failed'}); if(order.provider&&order.provider!=='mercadopago') return json(res,409,{error:'request_id_provider_conflict'});
    if(!inserted.length){const replay=checkoutReplayDecision(order,input.sessionId,input.offer.id);if(replay.action==='conflict')return json(res,409,{error:'request_id_conflict'});if(replay.action==='offer_conflict')return json(res,409,{error:'request_id_offer_conflict'});if(replay.action==='reuse')return json(res,200,{accepted:true,duplicate:true,order_id:order.order_id,checkout_url:replay.checkoutUrl});if(replay.action!=='create')return json(res,409,{error:replay.action==='in_progress'?'checkout_in_progress':'checkout_not_retryable'});}
    const claimed=await sql.query(`UPDATE orders SET status='checkout_creating',updated_at=now() WHERE order_id=$1 AND status='created' RETURNING order_id`,[order.order_id]); if(claimed.length!==1)return json(res,409,{error:'checkout_in_progress'});
    const notificationPath=pilotSandbox?'/api/webhooks?provider=mercadopago_test':'/api/webhooks/mercadopago'; const payload=buildMercadoPagoPreference(order.order_id,publicBase,effectiveOffer,{notificationPath}); if(!payload)return json(res,503,{error:'checkout_payload_unavailable'});
    let raw;try{raw=await createMercadoPagoPreference(payload,providerToken);}catch{
      try{await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);}catch{}
      const recovery=await preserveFinancialReconciliation({provider:'mercadopago',eventId:order.order_id,kind:'checkout_provider_uncertain',orderId:order.order_id,payload:{external_reference:order.external_reference,request_id:input.requestId,offer_id:input.offer.id,certification_pilot:Boolean(pilot?.authorized)}});
      return json(res,503,{error:'checkout_provider_uncertain',accepted:false,preserved:recovery.preserved,reconciliation_required:true});
    }
    const checkout=normalizeMercadoPagoPreference(raw,order.external_reference,checkoutEnv);
    if(!checkout){
      try{await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);}catch{}
      const recovery=await preserveFinancialReconciliation({provider:'mercadopago',eventId:order.order_id,kind:'checkout_response_invalid',orderId:order.order_id,payload:{external_reference:order.external_reference,raw_preference_id:String(raw?.id||''),certification_pilot:Boolean(pilot?.authorized)}});
      return json(res,503,{error:'checkout_response_invalid',accepted:false,preserved:recovery.preserved,reconciliation_required:true});
    }
    let persisted;try{persisted=await sql.query(`UPDATE orders SET status='checkout_ready',provider_checkout_id=$2,checkout_url=$3,updated_at=now() WHERE order_id=$1 AND status='checkout_creating' RETURNING order_id`,[order.order_id,checkout.id,checkout.link]);}catch{persisted=[];}
    if(persisted.length!==1){
      const recovery=await preserveFinancialReconciliation({provider:'mercadopago',eventId:checkout.id,kind:'checkout_provider_accepted_storage_unconfirmed',orderId:order.order_id,payload:{external_reference:order.external_reference,provider_checkout_id:checkout.id,checkout_url:checkout.link,certification_pilot:Boolean(pilot?.authorized)}});
      return json(res,503,{error:'checkout_persist_failed',accepted:false,preserved:recovery.preserved,reconciliation_required:true});
    }
    if(pilot?.authorized){try{await recordCertificationPilotCheckoutEvidence(sql,{orderId:order.order_id,sessionId:input.sessionId,provider:'mercadopago'});}catch{}}
    return json(res,201,{accepted:true,duplicate:false,order_id:order.order_id,checkout_url:checkout.link});
  }catch{return json(res,503,{error:'checkout_storage_error',accepted:false});}
}
