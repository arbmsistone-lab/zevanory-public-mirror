import { ARBM_CONTADOR_SALOES_OFFER } from './arbmContadorSaloesOffer.mjs';

export const ARBM_CONTADOR_SUBSCRIPTION_PLANS=Object.freeze({
  monthly:Object.freeze({id:'monthly',label:'Mensal',amount_brl:59.90,frequency:1,frequency_type:'months'}),
  annual:Object.freeze({id:'annual',label:'Anual',amount_brl:599.00,frequency:12,frequency_type:'months'}),
});

export function resolveArbmContadorSubscriptionPlan(id){
  return ARBM_CONTADOR_SUBSCRIPTION_PLANS[String(id||'').trim().toLowerCase()]||null;
}

export function buildMercadoPagoSubscriptionPlanPayload(planId,baseUrl='https://zevanory.api.br'){
  const plan=resolveArbmContadorSubscriptionPlan(planId); if(!plan) return null;
  let origin; try{origin=new URL(baseUrl).origin;}catch{return null;}
  if(!['https://zevanory.api.br','https://edge.zevanory.api.br'].includes(origin)) return null;
  return Object.freeze({
    reason:`${ARBM_CONTADOR_SALOES_OFFER.product} - ${plan.label}`,
    auto_recurring:Object.freeze({frequency:plan.frequency,frequency_type:plan.frequency_type,transaction_amount:plan.amount_brl,currency_id:'BRL'}),
    back_url:`${origin}/arbm-contador-saloes?subscription=return`,
    external_reference:`ZEVANORY:${ARBM_CONTADOR_SALOES_OFFER.id}:${plan.id}`,
  });
}

export function validateMercadoPagoSubscriptionPlanResponse(value,planId){
  const plan=resolveArbmContadorSubscriptionPlan(planId); if(!plan||!value||typeof value!=='object') return null;
  const recurring=value.auto_recurring||{}; let init;
  try{init=new URL(String(value.init_point||''));}catch{return null;}
  const host=init.hostname.toLowerCase();
  const validHost=host==='mercadopago.com.br'||host.endsWith('.mercadopago.com.br');
  const ok=String(value.id||'').length>=8&&String(value.status||'')==='active'&&validHost&&init.protocol==='https:'&&
    Number(recurring.frequency)===plan.frequency&&String(recurring.frequency_type||'')===plan.frequency_type&&
    Number(recurring.transaction_amount)===plan.amount_brl&&String(recurring.currency_id||'')==='BRL';
  if(!ok) return null;
  return Object.freeze({provider:'mercadopago',plan_id:plan.id,provider_plan_id:String(value.id),checkout_url:init.toString(),amount_brl:plan.amount_brl});
}
