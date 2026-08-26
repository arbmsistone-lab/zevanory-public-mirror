import { MARKET_PARAMETERS } from './marketParameters.mjs';

export const SALES_STAGES = Object.freeze([
  'new','contacted','qualified','offer_sent','checkout_started','paid','delivered','refunded','unqualified','lost',
]);

const transitions = Object.freeze({
  new: Object.freeze(['contacted','unqualified','lost']),
  contacted: Object.freeze(['qualified','unqualified','lost']),
  qualified: Object.freeze(['offer_sent','lost']),
  offer_sent: Object.freeze(['checkout_started','lost']),
  checkout_started: Object.freeze(['paid','lost']),
  paid: Object.freeze(['delivered','refunded']),
  delivered: Object.freeze(['refunded']),
  refunded: Object.freeze([]),
  unqualified: Object.freeze([]),
  lost: Object.freeze([]),
});

export function canTransitionSalesStage(from, to) {
  return Boolean(transitions[String(from)]?.includes(String(to)));
}
export function buildFollowUpPlan({ stage='new', touchpoints=0, lastContactAt=null }={}) {
  const count=Math.max(0,Number(touchpoints)||0);
  if (['paid','delivered','refunded','unqualified','lost'].includes(stage)) return Object.freeze({ action:'none', due_at:null, reason:'terminal_stage' });
  if (count >= MARKET_PARAMETERS.prospecting.internal_max_touchpoints) return Object.freeze({ action:'close_or_recycle', due_at:null, reason:'touchpoint_limit' });
  const base=lastContactAt ? new Date(lastContactAt) : new Date();
  if (Number.isNaN(base.getTime())) throw new Error('invalid_last_contact_at');
  const delayMinutes=stage==='new'
    ? MARKET_PARAMETERS.lead_response.operating_target_minutes
    : MARKET_PARAMETERS.warm_follow_up.first_follow_up_max_hours*60;
  const due=new Date(base.getTime()+delayMinutes*60_000).toISOString();
  return Object.freeze({
    action: stage==='new' ? 'first_response' : 'follow_up',
    due_at: due,
    touchpoint_number: count+1,
    benchmark: stage==='new' ? 'speed_to_lead' : 'warm_follow_up',
  });
}

export function salesStageRank(stage) {
  const index=SALES_STAGES.indexOf(String(stage));
  return index < 0 ? null : index;
}
