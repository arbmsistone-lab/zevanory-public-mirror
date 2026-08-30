import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { PROJECT } from '../config.mjs';
import { salesGate } from '../salesGate.mjs';
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
  const gate=salesGate(); if(!gate.enabled) return json(res,503,{error:'sales_globally_blocked',blockers:gate.blockers});
  if(process.env.CHECKOUT_ENABLED!=='true') return json(res,503,{error:'checkout_disabled'});
  if(String(process.env.PAYMENT_PROVIDER||'').toLowerCase()!=='mercadopago') return json(res,503,{error:'checkout_provider_not_selected'});
  const env=String(process.env.MERCADOPAGO_ENV||'').toLowerCase(); if(!['sandbox','production'].includes(env)) return json(res,503,{error:'checkout_environment_invalid'});
  const publicBase=safePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  if(!process.env.DATABASE_URL||!process.env.MERCADOPAGO_ACCESS_TOKEN||!publicBase) return json(res,503,{error:'checkout_provider_unavailable'});
  const input=normalizeCheckoutRequest(req.body); if(!input) return json(res,400,{error:'invalid_checkout_request'});
  const sql=neon(process.env.DATABASE_URL); const orderId=crypto.randomUUID(); const externalReference=externalReferenceForOrder(orderId);
  try{
    const inserted=await sql.query(`INSERT INTO orders (order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status) VALUES ($1,$2,$3,$4,$5,$6,'BRL','mercadopago',$7,'created') ON CONFLICT (request_id) DO NOTHING RETURNING order_id`,[orderId,input.requestId,input.sessionId,PROJECT.experimentId,PROJECT.offerId,PROJECT.experimentalPriceBrl,externalReference]);
    let order=inserted.length?{order_id:orderId,external_reference:externalReference,status:'created'}:(await sql.query(`SELECT order_id,session_id,external_reference,status,checkout_url,provider FROM orders WHERE request_id=$1`,[input.requestId]))[0];
    if(!order) return json(res,503,{error:'order_lookup_failed'}); if(order.provider&&order.provider!=='mercadopago') return json(res,409,{error:'request_id_provider_conflict'});
    if(!inserted.length){const replay=checkoutReplayDecision(order,input.sessionId);if(replay.action==='conflict')return json(res,409,{error:'request_id_conflict'});if(replay.action==='reuse')return json(res,200,{accepted:true,duplicate:true,order_id:order.order_id,checkout_url:replay.checkoutUrl});if(replay.action!=='create')return json(res,409,{error:replay.action==='in_progress'?'checkout_in_progress':'checkout_not_retryable'});}
    const claimed=await sql.query(`UPDATE orders SET status='checkout_creating',updated_at=now() WHERE order_id=$1 AND status='created' RETURNING order_id`,[order.order_id]); if(claimed.length!==1)return json(res,409,{error:'checkout_in_progress'});
    const payload=buildMercadoPagoPreference(order.order_id,publicBase); if(!payload)return json(res,503,{error:'checkout_payload_unavailable'});
    let raw; try{raw=await createMercadoPagoPreference(payload,process.env.MERCADOPAGO_ACCESS_TOKEN);}catch{await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);return json(res,503,{error:'checkout_provider_uncertain',accepted:false});}
    const checkout=normalizeMercadoPagoPreference(raw,order.external_reference,env); if(!checkout){await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);return json(res,503,{error:'checkout_response_invalid',accepted:false});}
    const persisted=await sql.query(`UPDATE orders SET status='checkout_ready',provider_checkout_id=$2,checkout_url=$3,updated_at=now() WHERE order_id=$1 AND status='checkout_creating' RETURNING order_id`,[order.order_id,checkout.id,checkout.link]); if(persisted.length!==1)return json(res,503,{error:'checkout_persist_failed',accepted:false});
    return json(res,201,{accepted:true,duplicate:false,order_id:order.order_id,checkout_url:checkout.link});
  }catch{return json(res,503,{error:'checkout_storage_error',accepted:false});}
}