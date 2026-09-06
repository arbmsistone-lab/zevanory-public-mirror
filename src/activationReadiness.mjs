import { classifyOfferType } from './commercialModel.mjs';
import { evaluateCommercialCompliance } from './complianceReadiness.mjs';
import { paymentProviderReadiness } from './paymentProviders.mjs';
import { PROJECT } from './config.mjs';
import { evaluateAffiliateProgramReadiness } from './affiliateProgram.mjs';

const yes=(v)=>String(v||'').toLowerCase()==='true';

export function evaluateActivationReadiness(env=process.env) {
  const offerType=classifyOfferType(env.ACTIVE_OFFER_TYPE);
  const delegatedCompliance=String(env.COMPLIANCE_RUNTIME_MODE||'').trim().toLowerCase()==='delegated';
  let supplierIdentityVerified=false;
  if(delegatedCompliance){
    try{
      const origin=new URL(String(env.COMPLIANCE_RUNTIME_ORIGIN||''));
      supplierIdentityVerified=origin.protocol==='https:'&&origin.hostname==='zevanory.api.br'&&yes(env.COMPLIANCE_RUNTIME_ORIGIN_VERIFIED)&&String(env.COMPLIANCE_RUNTIME_ORIGIN_RELEASE_ID||'')==='ZEVANORY-EG0039-FINAL';
    }catch{}
  }
  const compliance=evaluateCommercialCompliance({
    supplier_identity_verified:supplierIdentityVerified,
    supplier_legal_name:env.SUPPLIER_LEGAL_NAME,
    supplier_tax_id:env.SUPPLIER_TAX_ID,
    supplier_address:env.SUPPLIER_ADDRESS,
    support_channel:env.SUPPORT_CHANNEL,
    terms_published:true,privacy_published:true,refund_policy_published:true,
    service_delivery_policy_published:true,affiliate_disclosure_published:true,
  });
  const blockers=[...compliance.blockers];
  if(delegatedCompliance&&!supplierIdentityVerified) blockers.push('compliance_runtime_origin_unverified');
  if(!yes(env.OFFER_SELECTION_APPROVED)) blockers.push('offer_selection_not_approved');
  if(!offerType) blockers.push('active_offer_type_invalid');
  if(offerType==='digital_product') {
    if(PROJECT.offerId==='OFFER-0001'){
      const publicDistributionReady=yes(env.ARBM_SIST_CODE_SIGNING_READY)&&yes(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED);
      const privatePilotReady=yes(env.ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED)&&yes(env.ARBM_SIST_SECURE_ARTIFACT_READY);
      if(!publicDistributionReady&&!privatePilotReady){
        if(!yes(env.ARBM_SIST_CODE_SIGNING_READY)) blockers.push('arbm_sist_code_signing_not_ready');
        if(!yes(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED)) blockers.push('arbm_sist_public_release_not_approved');
        if(!yes(env.ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED)) blockers.push('arbm_sist_private_pilot_delivery_not_approved');
        if(!yes(env.ARBM_SIST_SECURE_ARTIFACT_READY)) blockers.push('arbm_sist_secure_artifact_not_ready');
      }
    } else {
      if(!yes(env.ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED)) blockers.push('zevanory_product_handoff_v21_not_verified');
      if(!yes(env.ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY)) blockers.push('zevanory_secure_artifact_delivery_not_ready');
    }
  }
  if(['service','digital_product'].includes(offerType)) {
    if(!['digital','remote'].includes(String(env.SERVICE_DELIVERY_MODE||'').toLowerCase())) blockers.push('service_delivery_mode_missing');
    if(!yes(env.PAYMENT_MERCHANT_IDENTITY_VERIFIED)) blockers.push('payment_merchant_identity_unverified');
    blockers.push(...paymentProviderReadiness(env,{production:true}).blockers);
  }
  if(offerType==='affiliate_product') blockers.push(...evaluateAffiliateProgramReadiness(env).blockers);
  return Object.freeze({ready:blockers.length===0,offer_type:offerType||null,inventory_required:false,compliance_ready:compliance.ready,blockers:Object.freeze([...new Set(blockers)])});
}
