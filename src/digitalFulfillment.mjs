import { ARBM_SIST_OFFER, getZevanoryProduct } from './offerCatalog.mjs';
import { resolveZevanoryArtifact } from './zevanoryArtifactRegistry.mjs';

export function digitalFulfillmentReadiness(input={}) {
  const requested=String(input.offer_id||input.sku||'').trim().toUpperCase();
  const zevanoryProduct=requested?getZevanoryProduct(requested):null;
  const zevanoryArtifact=zevanoryProduct?resolveZevanoryArtifact(requested):null;
  const isLegacy=!requested||requested===ARBM_SIST_OFFER.id;
  const supported=Boolean(zevanoryProduct&&zevanoryArtifact)||isLegacy;
  const product=zevanoryProduct||(isLegacy?ARBM_SIST_OFFER:null);
  const artifact=zevanoryArtifact||(isLegacy?{
    filename:ARBM_SIST_OFFER.artifact_name,
    sha256:ARBM_SIST_OFFER.artifact_sha256,
  }:null);
  const paid=String(input.order_status||'').toLowerCase()==='paid';
  const providerConfirmed=input.payment_confirmed===true;
  const artifactConfigured=Boolean(String(input.secure_artifact_ref||'').trim());
  const blockers=[];
  if(!supported) blockers.push('offer_not_supported');
  if(!paid) blockers.push('order_not_paid');
  if(!providerConfirmed) blockers.push('payment_not_reconciled');
  if(!artifactConfigured) blockers.push('secure_artifact_not_configured');
  return Object.freeze({
    ready:blockers.length===0,offer_id:zevanoryProduct?.sku||product?.id||requested||null,
    product:product?.product||null,version:product?.version||null,
    artifact_name:artifact?.filename||null,artifact_sha256:artifact?.sha256||null,
    delivery_mode:product?.delivery_mode||null,public_download:false,blockers:Object.freeze(blockers),
  });
}
