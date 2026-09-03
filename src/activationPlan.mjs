import { evaluateActivationReadiness } from './activationReadiness.mjs';
import { salesGate } from './salesGate.mjs';

const requirement=(category,envKeys,inputClass='external')=>Object.freeze({category,env_keys:Object.freeze(envKeys),input_class:inputClass});
export const ACTIVATION_REQUIREMENTS=Object.freeze({
  supplier_legal_name_missing:requirement('legal',['SUPPLIER_LEGAL_NAME']),
  supplier_tax_id_missing:requirement('legal',['SUPPLIER_TAX_ID']),
  supplier_address_missing:requirement('legal',['SUPPLIER_ADDRESS']),
  support_channel_missing:requirement('operations',['SUPPORT_CHANNEL']),
  offer_selection_not_approved:requirement('commercial',['OFFER_SELECTION_APPROVED'],'decision'),
  active_offer_type_invalid:requirement('commercial',['ACTIVE_OFFER_TYPE'],'decision'),
  service_delivery_mode_missing:requirement('commercial',['SERVICE_DELIVERY_MODE'],'decision'),
  arbm_sist_code_signing_not_ready:requirement('artifact',['ARBM_SIST_CODE_SIGNING_READY'],'external'),
  arbm_sist_public_release_not_approved:requirement('artifact',['ARBM_SIST_PUBLIC_RELEASE_APPROVED'],'decision'),
  payment_provider_not_selected:requirement('payments',['PAYMENT_PROVIDER'],'decision'),
  payment_merchant_identity_unverified:requirement('payments',['PAYMENT_MERCHANT_IDENTITY_VERIFIED'],'external'),
  asaas_production_not_configured:requirement('payments',['ASAAS_ENV'],'configuration'),
  asaas_credentials_missing:requirement('payments',['ASAAS_API_KEY','ASAAS_WEBHOOK_TOKEN'],'secret'),
  mercadopago_production_not_configured:requirement('payments',['MERCADOPAGO_ENV'],'configuration'),
  mercadopago_credentials_missing:requirement('payments',['MERCADOPAGO_ACCESS_TOKEN','MERCADOPAGO_WEBHOOK_SECRET'],'secret'),
  affiliate_provider_missing:requirement('affiliate',['AFFILIATE_PROVIDER'],'external'),
  affiliate_tracking_unready:requirement('affiliate',['AFFILIATE_TRACKING_READY'],'external'),
  affiliate_terms_unreviewed:requirement('affiliate',['AFFILIATE_TERMS_REVIEWED'],'decision'),
  affiliate_webhook_url_invalid:requirement('affiliate',['AFFILIATE_WEBHOOK_URL'],'configuration'),
  affiliate_webhook_token_missing:requirement('affiliate',['AFFILIATE_WEBHOOK_TOKEN'],'secret'),
  affiliate_terms_version_missing:requirement('affiliate',['AFFILIATE_TERMS_VERSION'],'decision'),
  affiliate_attribution_window_invalid:requirement('affiliate',['AFFILIATE_ATTRIBUTION_WINDOW_DAYS'],'decision'),
  affiliate_commission_bps_invalid:requirement('affiliate',['AFFILIATE_COMMISSION_BPS'],'decision'),
  affiliate_payout_delay_invalid:requirement('affiliate',['AFFILIATE_PAYOUT_DELAY_DAYS'],'decision'),
  affiliate_self_referral_policy_invalid:requirement('affiliate',['AFFILIATE_SELF_REFERRAL_POLICY'],'decision'),
  affiliate_refund_reversal_unready:requirement('affiliate',['AFFILIATE_REFUND_REVERSAL_READY'],'external'),
  affiliate_chargeback_reversal_unready:requirement('affiliate',['AFFILIATE_CHARGEBACK_REVERSAL_READY'],'external'),
  affiliate_idempotency_unready:requirement('affiliate',['AFFILIATE_IDEMPOTENCY_READY'],'external'),
  affiliate_provider_confirmation_unready:requirement('affiliate',['AFFILIATE_PROVIDER_CONFIRMATION_READY'],'external'),
  affiliate_disclosure_url_invalid:requirement('affiliate',['AFFILIATE_DISCLOSURE_URL'],'decision'),
  affiliate_privacy_url_invalid:requirement('affiliate',['AFFILIATE_PRIVACY_URL'],'decision'),
});
const enabled=(value)=>String(value||'').toLowerCase()==='true';
export const CUTOVER_ORDER=Object.freeze(['verify_external_inputs','certify_sales_lifecycle_39x10','verify_lifecycle_audit_10x','verify_production_parity','approve_lifecycle_release','PRE_SALE_GATES_APPROVED=true','enable_required_channel_flags','verify_fail_closed_before_global_unlock','SALE_GLOBALLY_ENABLED=true','verify_live_transaction_and_reconciliation']);
export const ROLLBACK_ORDER=Object.freeze(['SALE_GLOBALLY_ENABLED=false','CHECKOUT_ENABLED=false','WHATSAPP_SALES_ENABLED=false','FINANCIAL_EVENTS_ENABLED=false','PRE_SALE_GATES_APPROVED=false','verify_fail_closed']);
export function buildActivationPlan(env=process.env){
  const readiness=evaluateActivationReadiness(env); const gate=salesGate(env);
  const missing=readiness.blockers.map(code=>Object.freeze({code,...(ACTIVATION_REQUIREMENTS[code]||requirement('unknown',[]))}));
  const phase=gate.enabled?'live':!readiness.ready?'waiting_external_inputs':!gate.lifecycle_approved?'lifecycle_certification_blocked':'ready_to_unlock';
  return Object.freeze({phase,inputs_ready:readiness.ready,commercial_enabled:gate.enabled,offer_type:readiness.offer_type,inventory_required:false,missing:Object.freeze(missing),external_inputs_remaining:missing.length,lifecycle:gate.lifecycle,gates:Object.freeze({global_sales:enabled(env.SALE_GLOBALLY_ENABLED),pre_sale:enabled(env.PRE_SALE_GATES_APPROVED),checkout:enabled(env.CHECKOUT_ENABLED),whatsapp:enabled(env.WHATSAPP_SALES_ENABLED),financial:enabled(env.FINANCIAL_EVENTS_ENABLED)}),cutover_order:CUTOVER_ORDER,rollback_order:ROLLBACK_ORDER});
}