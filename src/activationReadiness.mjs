import { classifyOfferType } from './commercialModel.mjs';
import { evaluateCommercialCompliance } from './complianceReadiness.mjs';
import { paymentProviderReadiness } from './paymentProviders.mjs';
import { evaluateAffiliateProgramReadiness } from './affiliateProgram.mjs';

const yes=(v)=>String(v||'').toLowerCase()==='true';

export function evaluateActivationReadiness(env=process.env) {
  const offerType=classifyOfferType(env.ACTIVE_OFFER_TYPE);
  const compliance=evaluateCommercialCompliance({
    supplier_legal_name:env.SUPPLIER_LEGAL_NAME,
    supplier_tax_id:env.SUPPLIER_TAX_ID,
    supplier_address:env.SUPPLIER_ADDRESS,
    support_channel:env.SUPPORT_CHANNEL,
    terms_published:true,privacy_published:true,refund_policy_published:true,
    service_delivery_policy_published:true,affiliate_disclosure_published:true,
  });
  const blockers=[...compliance.blockers];
  if(!yes(env.OFFER_SELECTION_APPROVED)) blockers.push('offer_selection_not_approved');
  if(!offerType) blockers.push('active_offer_type_invalid');
  if(offerType==='digital_product') {
    if(!yes(env.ARBM_SIST_CODE_SIGNING_READY)) blockers.push('arbm_sist_code_signing_not_ready');
    if(!yes(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED)) blockers.push('arbm_sist_public_release_not_approved');
  }
  if(['service','digital_product'].includes(offerType)) {
    if(!['digital','remote'].includes(String(env.SERVICE_DELIVERY_MODE||'').toLowerCase())) blockers.push('service_delivery_mode_missing');
    if(!yes(env.PAYMENT_MERCHANT_IDENTITY_VERIFIED)) blockers.push('payment_merchant_identity_unverified');
    blockers.push(...paymentProviderReadiness(env,{production:true}).blockers);
  }
  if(offerType==='affiliate_product') blockers.push(...evaluateAffiliateProgramReadiness(env).blockers);
  return Object.freeze({ready:blockers.length===0,offer_type:offerType||null,inventory_required:false,compliance_ready:compliance.ready,blockers:Object.freeze([...new Set(blockers)])});
}