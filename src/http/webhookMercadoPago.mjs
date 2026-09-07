import { neon } from '@neondatabase/serverless';
import { MERCADOPAGO_API_BASE,normalizeMercadoPagoWebhook,verifyMercadoPagoSignature,normalizeMercadoPagoFinancialEvent } from '../mercadopago.mjs';
import { parseExternalReference } from '../asaas.mjs';
import { queueOutcomeLearningReview } from '../outcomeLearning.mjs';
import { recordVerifiedLifecycleEvidence } from '../lifecycleEvidenceRepository.mjs';

export async function fetchMercadoPagoPayment(paymentId,accessToken,fetchImpl=fetch){
  const response=await fetchImpl(`${MERCADOPAGO_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${accessToken}`}});
  if(!response.ok) throw new Error(`mercadopago_lookup_${response.status}`);
  return response.json();
}
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};

export async function handleMercadoPagoWebhook(req,res,{accessToken,webhookSecret,certificationOnly=false,source='mercadopago'}={}){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const webhook=normalizeMercadoPagoWebhook(req.parsedBody??req.body,req.url); if(!webhook)return json(res,400,{error:'unsupported_webhook',accepted:false});
  const requestId=String(req.headers?.['x-request-id']||''); const signature=String(req.headers?.['x-signature']||'');
  if(!verifyMercadoPagoSignature({signature,requestId,dataId:webhook.paymentId,secret:webhookSecret})) return json(res,401,{error:'webhook_auth_failed',accepted:false});
  if(process.env.FINANCIAL_EVENTS_ENABLED!=='true') return json(res,503,{error:'financial_events_disabled',accepted:false});
  if(String(process.env.PAYMENT_PROVIDER||'').toLowerCase()!=='mercadopago') return json(res,503,{error:'financial_provider_not_selected',accepted:false});
  if(!process.env.DATABASE_URL||!accessToken) return json(res,503,{error:'financial_provider_unavailable',accepted:false});
  try{
    const payment=await fetchMercadoPagoPayment(webhook.paymentId,accessToken); const orderId=parseExternalReference(payment.external_reference);
    const sql=neon(process.env.DATABASE_URL); const orders=await sql.query(`SELECT order_id,amount,status,external_reference,provider_checkout_id,provider,certification_pilot FROM orders WHERE order_id::text=$1`,[orderId||'']);    if(orders.length===0)return json(res,200,{accepted:true,ignored:true,reason:'unlinked_payment'});
    if(orders.length!==1||orders[0].provider!=='mercadopago')return json(res,409,{error:'payment_reconciliation_failed',accepted:false});
    if(certificationOnly&&orders[0].certification_pilot!==true)return json(res,409,{error:'certification_payment_required',accepted:false});
    const event=normalizeMercadoPagoFinancialEvent(payment,orders[0]); if(!event)return json(res,200,{accepted:true,ignored:true,reason:'non_final_payment'});
    const externalReference=String(orders[0].external_reference); const prefix=certificationOnly?'mp-test':'mp'; const providerEventId=`${prefix}:${webhook.paymentId}:${String(payment.status||'')}:${String(payment.transaction_amount_refunded||0)}`;
    const rows=await sql.query(`WITH target AS (SELECT order_id,amount,status FROM orders WHERE order_id=$8 AND provider='mercadopago' AND external_reference=$6 AND amount=$7 AND (($3='payment_confirmed' AND status IN ('checkout_ready','checkout_uncertain','paid')) OR ($3='refund_confirmed' AND status IN ('paid','partially_refunded','refunded')))), inserted AS (INSERT INTO financial_events (provider_event_id,provider,provider_payment_id,normalized_event,provider_event_name,provider_status,external_reference,amount,order_id,refunded_total) SELECT $1,'mercadopago',$2,$3,$4,$5,$6,$7,order_id,$9 FROM target ON CONFLICT DO NOTHING RETURNING order_id,normalized_event,refunded_total), updated AS (UPDATE orders o SET status=CASE WHEN i.normalized_event='payment_confirmed' THEN 'paid' WHEN i.refunded_total>=o.amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() FROM inserted i WHERE o.order_id=i.order_id RETURNING o.order_id,o.status) SELECT (SELECT count(*)::int FROM target) target_count,(SELECT count(*)::int FROM inserted) inserted_count,(SELECT status FROM updated LIMIT 1) order_status,(SELECT status FROM orders WHERE order_id=$8) current_status`,[providerEventId,webhook.paymentId,event.normalized,'payment.updated',String(payment.status||''),externalReference,Number(payment.transaction_amount),String(orders[0].order_id),event.refundedTotal]);
    const outcome=rows[0]||{}; if(Number(outcome.target_count)!==1)return json(res,409,{error:'order_state_invalid',accepted:false}); if(Number(outcome.inserted_count)===1&&!outcome.order_status)return json(res,503,{error:'order_state_update_failed',accepted:false});
    if(Number(outcome.inserted_count)===1){
      if(!certificationOnly){try{await queueOutcomeLearningReview(sql,{idempotencyKey:`learning:financial:${providerEventId}`,source:`financial:${event.normalized}`});}catch{}}
      if(event.normalized==='payment_confirmed'){
        try{await recordVerifiedLifecycleEvidence(sql,{dimension:'payment',source_class:'provider_webhook',source,subject_ref:String(orders[0].order_id),idempotency_key:`payment-evidence:${source}:${providerEventId}`,metadata:{provider:'mercadopago',certification_pilot:certificationOnly,sandbox:certificationOnly}});}catch{}
        try{await recordVerifiedLifecycleEvidence(sql,{dimension:'reconciliation',source_class:'provider_webhook',source,subject_ref:String(orders[0].order_id),idempotency_key:`reconciliation-evidence:${source}:${providerEventId}`,metadata:{provider:'mercadopago',certification_pilot:certificationOnly,sandbox:certificationOnly}});}catch{}
      }
    }
    return json(res,200,{accepted:true,duplicate:Number(outcome.inserted_count)===0,event:event.normalized,order_id:String(orders[0].order_id),order_status:outcome.order_status||outcome.current_status,refunded_total:event.refundedTotal,certification_pilot:certificationOnly});
  }catch{return json(res,503,{error:'financial_reconciliation_unavailable',accepted:false});}
}

export default async function handler(req,res){
  return handleMercadoPagoWebhook(req,res,{accessToken:process.env.MERCADOPAGO_ACCESS_TOKEN,webhookSecret:process.env.MERCADOPAGO_WEBHOOK_SECRET,certificationOnly:false,source:'mercadopago'});
}
