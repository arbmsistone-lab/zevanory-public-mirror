import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { PROJECT } from '../../src/config.mjs';
import { asaasBaseUrl } from '../../src/asaas.mjs';
import { salesGate } from '../../src/salesGate.mjs';
import {
  normalizeCheckoutRequest,
  checkoutReplayDecision,
  externalReferenceForOrder,
  safePublicBaseUrl,
  buildAsaasCheckoutPayload,
  validAsaasCheckoutResponse,
} from '../../src/order.mjs';

export async function createAsaasCheckout(payload, apiKey, fetchImpl=fetch) {
  const response=await fetchImpl(`${asaasBaseUrl('sandbox')}/checkouts`,{
    method:'POST',
    headers:{accept:'application/json','content-type':'application/json',access_token:apiKey},
    body:JSON.stringify(payload),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(`asaas_checkout_${response.status}`);
  return data;
}

function json(res,status,body) {
  res.statusCode=status;
  return res.end(JSON.stringify(body));
}

export default async function handler(req,res) {
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const gate=salesGate();
  if(!gate.enabled) return json(res,503,{error:'sales_globally_blocked',blockers:gate.blockers});
  if(process.env.CHECKOUT_ENABLED!=='true') return json(res,503,{error:'checkout_disabled'});
  if(String(process.env.ASAAS_ENV||'').toLowerCase()!=='sandbox') return json(res,503,{error:'checkout_sandbox_only'});
  const publicBase=safePublicBaseUrl(process.env.PUBLIC_BASE_URL);
  if(!process.env.DATABASE_URL||!process.env.ASAAS_API_KEY||!publicBase) {
    return json(res,503,{error:'checkout_provider_unavailable'});
  }
  const input=normalizeCheckoutRequest(req.body);
  if(!input) return json(res,400,{error:'invalid_checkout_request'});
  const sql=neon(process.env.DATABASE_URL);
  const orderId=crypto.randomUUID();
  const externalReference=externalReferenceForOrder(orderId);
  try {
    const inserted=await sql.query(`
      INSERT INTO orders
        (order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status)
      VALUES ($1,$2,$3,$4,$5,$6,'BRL','asaas',$7,'created')
      ON CONFLICT (request_id) DO NOTHING
      RETURNING order_id
    `,[orderId,input.requestId,input.sessionId,PROJECT.experimentId,PROJECT.offerId,PROJECT.experimentalPriceBrl,externalReference]);
    let order;
    if(inserted.length) {
      order={order_id:orderId,external_reference:externalReference,status:'created'};
    } else {
      const existing=await sql.query(`
        SELECT order_id,session_id,external_reference,status,checkout_url
        FROM orders WHERE request_id=$1
      `,[input.requestId]);
      if(existing.length!==1) return json(res,503,{error:'order_lookup_failed'});
      order=existing[0];
      const replay=checkoutReplayDecision(order,input.sessionId);
      if(replay.action==='conflict') return json(res,409,{error:'request_id_conflict'});
      if(replay.action==='reuse') {
        return json(res,200,{accepted:true,duplicate:true,order_id:order.order_id,checkout_url:replay.checkoutUrl});
      }
      if(replay.action==='in_progress') return json(res,409,{error:'checkout_in_progress'});
      if(replay.action!=='create') {
        return json(res,409,{error:'checkout_not_retryable',status:replay.status||order.status});
      }
    }
    const claimed=await sql.query(`
      UPDATE orders SET status='checkout_creating',updated_at=now()
      WHERE order_id=$1 AND status='created'
      RETURNING order_id,external_reference
    `,[order.order_id]);
    if(claimed.length!==1) return json(res,409,{error:'checkout_in_progress'});
    const payload=buildAsaasCheckoutPayload(order.order_id,publicBase);
    if(!payload) return json(res,503,{error:'checkout_payload_unavailable'});
    let checkout;
    try {
      checkout=await createAsaasCheckout(payload,process.env.ASAAS_API_KEY);
    } catch {
      await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);
      return json(res,503,{error:'checkout_provider_uncertain',accepted:false});
    }
    if(!validAsaasCheckoutResponse(checkout,order.external_reference)) {
      await sql.query(`UPDATE orders SET status='checkout_uncertain',updated_at=now() WHERE order_id=$1`,[order.order_id]);
      return json(res,503,{error:'checkout_response_invalid',accepted:false});
    }
    const persisted=await sql.query(`
      UPDATE orders SET status='checkout_ready',provider_checkout_id=$2,checkout_url=$3,updated_at=now()
      WHERE order_id=$1 AND status='checkout_creating'
      RETURNING order_id
    `,[order.order_id,String(checkout.id),String(checkout.link)]);
    if(persisted.length!==1) return json(res,503,{error:'checkout_persist_failed',accepted:false});
    return json(res,201,{accepted:true,duplicate:false,order_id:order.order_id,checkout_url:checkout.link});
  } catch {
    return json(res,503,{error:'checkout_storage_error',accepted:false});
  }
}
