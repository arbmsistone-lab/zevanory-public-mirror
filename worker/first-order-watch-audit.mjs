// Order 17: signed, aggregate-only watcher. Database credentials stay inside the Worker.
import {verifySignedAuditProbe} from "./signed-audit-probe.mjs";
export const FIRST_ORDER_WATCH_SQL = `
WITH real_orders AS (
 SELECT order_id,status,updated_at FROM orders
 WHERE certification_pilot IS FALSE AND created_at >= $1::timestamptz
   AND provider='mercadopago'
), payment_events AS (
 SELECT order_id,MIN(received_at) confirmed_at FROM financial_events
 WHERE provider='mercadopago' AND normalized_event='payment_confirmed'
   AND provider_status IN ('approved','paid') AND received_at >= $1::timestamptz
 GROUP BY order_id
), delivery AS (
 SELECT o.status order_status,o.updated_at,p.confirmed_at,f.status fulfillment_status,f.delivered_at
 FROM real_orders o LEFT JOIN payment_events p ON p.order_id=o.order_id
 LEFT JOIN service_fulfillment f ON f.order_id=o.order_id
)
SELECT COUNT(*)::int checkouts,
 COUNT(*) FILTER (WHERE order_status='paid')::int paid,
 COUNT(*) FILTER (WHERE order_status='paid' AND fulfillment_status='delivered'
   AND delivered_at IS NOT NULL)::int delivered,
 COUNT(*) FILTER (WHERE order_status='paid'
   AND (fulfillment_status IS DISTINCT FROM 'delivered' OR delivered_at IS NULL)
   AND COALESCE(confirmed_at,updated_at) <= now()-interval '15 minutes')::int overdue_paid,
 COUNT(*) FILTER (WHERE order_status='paid'
   AND fulfillment_status IN ('failed','error','blocked','canceled'))::int fulfillment_failed
FROM delivery
`;
const START="2026-10-09T20:19:12Z";
const allowed=["checkouts","paid","delivered","overdue_paid","fulfillment_failed"];
const response=(status,obj)=>new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});
export async function handleFirstOrderWatchReadOnly(request,env,{sqlFactory}={}){
 if(request.method!=="GET"||new URL(request.url).pathname!=="/api/internal/watch/paid-delivery")
   return response(405,{error:"method_not_allowed"});
 // Independently enforce HMAC even if the global optional signature guard is bypassed.
 if(!(await verifySignedAuditProbe(request,env)))return response(401,{error:"signed_get_required"});
 if(!env?.DATABASE_URL||typeof sqlFactory!=="function")return response(503,{error:"aggregate_unavailable"});
 try{
   const records=await sqlFactory(env.DATABASE_URL).query(FIRST_ORDER_WATCH_SQL,[START]);
   const row=records?.[0];
   if(!row)return response(503,{error:"aggregate_unavailable"});
   const counts={};
   for(const key of allowed){
     const value=Number(row[key]);
     if(!Number.isSafeInteger(value)||value<0)return response(503,{error:"aggregate_invalid"});
     counts[key]=value;
   }
   if(counts.delivered>counts.paid||counts.overdue_paid>counts.paid||counts.fulfillment_failed>counts.paid)
      return response(503,{error:"aggregate_inconsistent"});
   return response(200,{schema:"zevanory.first-order-watch.v1",counts});
 }catch{return response(503,{error:"aggregate_query_failed"});}
}
