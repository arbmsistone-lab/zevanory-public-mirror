import { ARBM_SIST_OFFER } from './offerCatalog.mjs';

export function digitalFulfillmentReadiness(input={}) {
  const paid=String(input.order_status||'').toLowerCase()==='paid';
  const providerConfirmed=input.payment_confirmed===true;
  const artifactConfigured=Boolean(String(input.secure_artifact_ref||'').trim());
  const blockers=[];
  if(!paid) blockers.push('order_not_paid');
  if(!providerConfirmed) blockers.push('payment_not_reconciled');
  if(!artifactConfigured) blockers.push('secure_artifact_not_configured');
  return Object.freeze({
    ready:blockers.length===0,
    product:ARBM_SIST_OFFER.product,
    version:ARBM_SIST_OFFER.version,
    artifact_name:ARBM_SIST_OFFER.artifact_name,
    artifact_sha256:ARBM_SIST_OFFER.artifact_sha256,
    delivery_mode:ARBM_SIST_OFFER.delivery_mode,
    public_download:false,
    blockers:Object.freeze(blockers),
  });
}
