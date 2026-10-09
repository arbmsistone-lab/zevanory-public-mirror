// Read-only financial/checkout projection into the shared activity outbox.
// Runs in its own Cloudflare scheduled invocation, never in checkout/payment
// webhooks. Finance requires a current GET-proven snapshot on the exact SHA.
import { emitActivity } from "./activity-ledger.mjs";
import { readFinancialProofSnapshot, LAUNCH_EPOCH_KV_KEY } from "./commercial-metrics-projection.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVITY_SYNC_LIMIT=3;
export async function syncProductionActivity(env,{sqlFactory,now=Date.now()}={}){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv?.get||!kv?.put||!env?.DATABASE_URL||!sqlFactory)return {ok:false,reason:"unavailable"};
  let epoch;
  try {epoch=JSON.parse(String(await kv.get(LAUNCH_EPOCH_KV_KEY)||"null"))?.at;} catch {}
  const startedAt=Date.parse(String(epoch||""));
  if(!Number.isFinite(startedAt)||startedAt>now)return {ok:true,idle:"no_launch_epoch",emitted:0};
  // Checkouts are non-financial. Finance events require a release-matched proof.
  const snapshot=await readFinancialProofSnapshot(env,{now});
  let rows;
  try {
    rows=await sqlFactory(env.DATABASE_URL).query(
      "select o.order_id::text as ref, o.status, o.amount::text as amount, o.created_at, "+
      "max(f.received_at) filter (where f.provider='mercadopago' "+
      "and f.normalized_event='payment_confirmed' "+
      "and f.provider_status in ('approved','paid')) as paid_event_at "+
      "from orders o left join financial_events f on f.order_id=o.order_id "+
      "where o.certification_pilot is false and o.created_at >= $1 "+
      "group by o.order_id,o.status,o.amount,o.created_at "+
      "order by o.created_at desc limit 3",[new Date(startedAt).toISOString()]);
  } catch {return {ok:false,reason:"database_read_unavailable"};}
  if(!Array.isArray(rows))return {ok:false,reason:"database_result_invalid"};
  let emitted=0,seen=0,finance=0;
  const measured=Date.parse(String(snapshot?.measured_at||""));
  for(const row of rows){
    if(!UUID.test(String(row?.ref||"")))continue;
    seen++;
    const checkout=await emitActivity(env,{
      type:"checkout_created",channel:"checkout",status:"created",ref:"checkout:"+row.ref
    },{now});
    if(checkout.emitted)emitted++;
    const paidEvent=Date.parse(String(row?.paid_event_at||""));
    if(row.status!=="paid"||!snapshot?.verified||!Number.isFinite(paidEvent)||
       !Number.isFinite(measured)||paidEvent>measured)continue;
    const amount=Math.round(Number(row.amount)*100);
    if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)continue;
    const payment=await emitActivity(env,{
      type:"payment_confirmed",channel:"finance",status:"confirmed",ref:"paid:"+row.ref,
      amount,financialProof:"provider-get-verified"
    },{now});
    if(payment.emitted){emitted++;finance++;}
  }
  return {ok:true,seen,emitted,finance,proof_accepted:Boolean(snapshot?.verified)};
}
