const present=(value)=>Boolean(String(value||'').trim());
const yes=(value)=>String(value||'').trim().toLowerCase()==='true';
const positiveInt=(value,{min=1,max=100000}={})=>{if(!String(value??'').trim())return false;const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max;};
const https=(value)=>{try{return new URL(String(value||'')).protocol==='https:';}catch{return false;}};

export const AFFILIATE_POLICY_REQUIREMENTS=Object.freeze({
  provider:'AFFILIATE_PROVIDER', webhook_url:'AFFILIATE_WEBHOOK_URL', webhook_token:'AFFILIATE_WEBHOOK_TOKEN',
  tracking_ready:'AFFILIATE_TRACKING_READY', terms_reviewed:'AFFILIATE_TERMS_REVIEWED', terms_version:'AFFILIATE_TERMS_VERSION',
  attribution_window_days:'AFFILIATE_ATTRIBUTION_WINDOW_DAYS', commission_bps:'AFFILIATE_COMMISSION_BPS', payout_delay_days:'AFFILIATE_PAYOUT_DELAY_DAYS',
  self_referral_policy:'AFFILIATE_SELF_REFERRAL_POLICY', refund_reversal_ready:'AFFILIATE_REFUND_REVERSAL_READY',
  chargeback_reversal_ready:'AFFILIATE_CHARGEBACK_REVERSAL_READY', idempotency_ready:'AFFILIATE_IDEMPOTENCY_READY',
  disclosure_url:'AFFILIATE_DISCLOSURE_URL', privacy_url:'AFFILIATE_PRIVACY_URL', provider_confirmation_ready:'AFFILIATE_PROVIDER_CONFIRMATION_READY',
});

export const AFFILIATE_COMMISSION_STATES=Object.freeze(['pending','confirmed','reversed','paid']);
export const AFFILIATE_REVENUE_TRUTH='confirmed_commission_only';

export function evaluateAffiliateProgramReadiness(env=process.env){
  const blockers=[];
  if(!present(env.AFFILIATE_PROVIDER)) blockers.push('affiliate_provider_missing');
  if(!https(env.AFFILIATE_WEBHOOK_URL)) blockers.push('affiliate_webhook_url_invalid');
  if(!present(env.AFFILIATE_WEBHOOK_TOKEN)) blockers.push('affiliate_webhook_token_missing');
  if(!yes(env.AFFILIATE_TRACKING_READY)) blockers.push('affiliate_tracking_unready');
  if(!yes(env.AFFILIATE_TERMS_REVIEWED)) blockers.push('affiliate_terms_unreviewed');
  if(!present(env.AFFILIATE_TERMS_VERSION)) blockers.push('affiliate_terms_version_missing');
  if(!positiveInt(env.AFFILIATE_ATTRIBUTION_WINDOW_DAYS,{max:3650})) blockers.push('affiliate_attribution_window_invalid');
  if(!positiveInt(env.AFFILIATE_COMMISSION_BPS,{max:10000})) blockers.push('affiliate_commission_bps_invalid');
  if(!positiveInt(env.AFFILIATE_PAYOUT_DELAY_DAYS,{min:0,max:3650})) blockers.push('affiliate_payout_delay_invalid');
  if(!['blocked','manual_review'].includes(String(env.AFFILIATE_SELF_REFERRAL_POLICY||'').toLowerCase())) blockers.push('affiliate_self_referral_policy_invalid');
  if(!yes(env.AFFILIATE_REFUND_REVERSAL_READY)) blockers.push('affiliate_refund_reversal_unready');
  if(!yes(env.AFFILIATE_CHARGEBACK_REVERSAL_READY)) blockers.push('affiliate_chargeback_reversal_unready');
  if(!yes(env.AFFILIATE_IDEMPOTENCY_READY)) blockers.push('affiliate_idempotency_unready');
  if(!yes(env.AFFILIATE_PROVIDER_CONFIRMATION_READY)) blockers.push('affiliate_provider_confirmation_unready');
  if(!https(env.AFFILIATE_DISCLOSURE_URL)) blockers.push('affiliate_disclosure_url_invalid');
  if(!https(env.AFFILIATE_PRIVACY_URL)) blockers.push('affiliate_privacy_url_invalid');
  return Object.freeze({ready:blockers.length===0,revenue_truth:AFFILIATE_REVENUE_TRUTH,commission_states:AFFILIATE_COMMISSION_STATES,blockers:Object.freeze(blockers)});
}