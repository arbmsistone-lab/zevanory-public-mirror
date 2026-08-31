import { neon } from '@neondatabase/serverless';
import { MERCADOPAGO_API_BASE,normalizeMercadoPagoWebhook,verifyMercadoPagoSignature,normalizeMercadoPagoFinancialEvent } from '../mercadopago.mjs';
import { parseExternalReference } from '../asaas.mjs';

export async function fetchMercadoPagoPayment(paymentId,accessToken,fetchImpl=fetch){
  const response=await fetchImpl(`${MERCADOPAGO_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${accessToken}`}});
  if(!response.ok) throw new Error(`mercadopago_lookup_${response.status}`);
  return response.json();
}
const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const webhook=normalizeMercadoPagoWebhook(req.parsedBody??req.body,req.url); if(!webhook)return json(res,400,{error:'unsupported_webhook',accepted:false});
  const requestId=String(req.headers?.['x-request-id']||''); const signature=String(req.headers?.['x-signature']||'');
  if(!verifyMercadoPagoSignature({signature,requestId,dataId:webhook.paymentId,secret:process.env.MERCADOPAGO_WEBHOOK_SECRET})) return json(res,401,{error:'webhook_auth_failed',accepted:false});
  if(process.env.FINANCIAL_EVENTS_ENABLED!=='true') return json(res,503,{error:'financial_events_disabled',accepted:false});
  if(String(process.env.PAYMENT_PROVIDER||'').toLowerCase()!=='mercadopago') return json(res,503,{error:'financial_provider_not_selected',accepted:false});
  if(!process.env.DATABASE_URL||!process.env.MERCADOPAGO_ACCESS_TOKEN) return json(res,503,{error:'financial_provider_unavailable',accepted:false});
  try{
    const payment=await fetchMercadoPagoPayment(webhook.paymentId,process.env.MERCADOPAGO_ACCESS_TOKEN); const orderId=parseExternalReference(payment.external_reference);
    const sql=neon(process.env.DATABASE_URL); const orders=await sql.query(`SELECT order_id,amount,status,external_reference,provider_checkout_id,provider FROM orders WHERE order_id::text=$1`,[orderId||'']);
    if(orders.length===0)return json(res,200,{accepted:true,ignored:true,reason:'unlinked_payment'}); if(orders.length!==1||orders[0].provider!=='mercadopago')return json(res,409,{error:'payment_reconciliation_failed',accepted:false});
    const event=normalizeMercadoPagoFinancialEvent(payment,orders[0]); if(!event)return json(res,200,{accepted:true,ignored:true,reason:'non_final_payment'});
    const externalReference=String(orders[0].external_reference); const providerEventId=`mp:${webhook.paymentId}:${String(payment.status||'')}:${String(payment.transaction_amount_refunded||0)}`;
    const rows=await sql.query(`WITH target AS (SELECT order_id,amount,status FROM orders WHERE order_id=$8 AND provider='mercadopago' AND external_reference=$6 AND amount=$7 AND (($3='payment_confirmed' AND status IN ('checkout_ready','checkout_uncertain','paid')) OR ($3='refund_confirmed' AND status IN ('paid','partially_refunded','refunded')))), inserted AS (INSERT INTO financial_events (provider_event_id,provider,provider_payment_id,normalized_event,provider_event_name,provider_status,external_reference,amount,order_id,refunded_total) SELECT $1,'mercadopago',$2,$3,$4,$5,$6,$7,order_id,$9 FROM target ON CONFLICT DO NOTHING RETURNING order_id,normalized_event,refunded_total), updated AS (UPDATE orders o SET status=CASE WHEN i.normalized_event='payment_confirmed' THEN 'paid' WHEN i.refunded_total>=o.amount THEN 'refunded' ELSE 'partially_refunded' END,updated_at=now() FROM inserted i WHERE o.order_id=i.order_id RETURNING o.order_id,o.status) SELECT (SELECT count(*)::int FROM target) target_count,(SELECT count(*)::int FROM inserted) inserted_count,(SELECT status FROM updated LIMIT 1) order_status,(SELECT status FROM orders WHERE order_id=$8) current_status`,[providerEventId,webhook.paymentId,event.normalized,'payment.updated',String(payment.status||''),externalReference,Number(payment.transaction_amount),String(orders[0].order_id),event.refundedTotal]);
    const outcome=rows[0]||{}; if(Number(outcome.target_count)!==1)return json(res,409,{error:'order_state_invalid',accepted:false}); if(Number(outcome.inserted_count)===1&&!outcome.order_status)return json(res,503,{error:'order_state_update_failed',accepted:false});
    return json(res,200,{accepted:true,duplicate:Number(outcome.inserted_count)===0,event:event.normalized,order_id:String(orders[0].order_id),order_status:outcome.order_status||outcome.current_status,refunded_total:event.refundedTotal});
  }catch{return json(res,503,{error:'financial_reconciliation_unavailable',accepted:false});}
}