import { salesGate } from '../salesGate.mjs';
import { readJsonRequestBody } from '../security.mjs';
import { arbmContadorSaloesReleaseReady } from '../arbmContadorSaloesOffer.mjs';
import { resolveArbmContadorSubscriptionPlan, validateMercadoPagoSubscriptionPlanResponse } from '../arbmContadorSubscription.mjs';

const json=(res,status,body)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');return res.end(JSON.stringify(body));};
const providerPlanId=(plan,env)=>plan?.id==='monthly'?String(env.ARBM_CONTADOR_MP_MONTHLY_PLAN_ID||'').trim():plan?.id==='annual'?String(env.ARBM_CONTADOR_MP_ANNUAL_PLAN_ID||'').trim():'';

export default async function handler(req,res){
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const gate=salesGate();
  if(!gate.enabled) return json(res,503,{error:'sales_globally_blocked',blockers:gate.blockers});
  if(process.env.CHECKOUT_ENABLED!=='true'||process.env.ARBM_CONTADOR_SUBSCRIPTIONS_ENABLED!=='true') return json(res,503,{error:'subscription_checkout_disabled'});
  if(!arbmContadorSaloesReleaseReady(process.env)) return json(res,503,{error:'product_release_not_ready'});
  const input=await readJsonRequestBody(req); const plan=resolveArbmContadorSubscriptionPlan(input?.plan_id);
  if(!plan) return json(res,400,{error:'invalid_subscription_plan'});
  const remotePlanId=providerPlanId(plan,process.env);
  if(!process.env.MERCADOPAGO_ACCESS_TOKEN||!remotePlanId) return json(res,503,{error:'subscription_provider_unavailable'});
  let response;
  try{response=await fetch(`https://api.mercadopago.com/preapproval_plan/${encodeURIComponent(remotePlanId)}`,{headers:{authorization:`Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`}});}catch{return json(res,503,{error:'subscription_provider_unavailable'});}
  const data=await response.json().catch(()=>null);
  if(!response.ok) return json(res,503,{error:'subscription_provider_unavailable'});
  const verified=validateMercadoPagoSubscriptionPlanResponse(data,plan.id);
  if(!verified||verified.provider_plan_id!==remotePlanId) return json(res,503,{error:'subscription_plan_verification_failed'});
  return json(res,200,{ok:true,offer_id:'ARBM-CONTADOR-SALOES',plan_id:verified.plan_id,amount_brl:verified.amount_brl,checkout_url:verified.checkout_url});
}
