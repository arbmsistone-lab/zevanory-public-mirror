import { ZEVANORY_PRODUCTS, getZevanoryProduct } from './offerCatalog.mjs';

const PREFIX='zevanory/v1.1/';
export const ZEVANORY_ARTIFACTS=Object.freeze(Object.fromEntries(
  ZEVANORY_PRODUCTS.map(product=>[product.sku,Object.freeze({
    offerId:product.sku,
    offer_id:product.sku,
    product:product.product,
    version:product.version,
    key:`${PREFIX}${product.artifact_name}`,
    filename:product.artifact_name,
    sha256:String(product.artifact_sha256).toUpperCase(),
    contentType:'application/zip',
  })])
));
export function resolveZevanoryArtifact(offerId){
  const product=getZevanoryProduct(offerId);
  return product?ZEVANORY_ARTIFACTS[product.sku]:null;
}
export function resolveZevanoryArtifactByKey(key){
  const normalized=String(key||'').trim();
  return Object.values(ZEVANORY_ARTIFACTS).find(item=>item.key===normalized)||null;
}
