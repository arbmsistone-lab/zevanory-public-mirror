export const COMMERCIAL_MODEL = Object.freeze({
  inventory: 'none',
  own_offer_types: Object.freeze(['service','digital_product']),
  third_party_offer_types: Object.freeze(['affiliate_product']),
  service_fulfillment: 'digital_or_remote',
  affiliate_checkout: 'external_merchant',
  affiliate_revenue_truth: 'confirmed_commission',
  affiliate_gmv_is_revenue: false,
});

export function classifyOfferType(value) {
  const type=String(value||'').trim().toLowerCase();
  return [...COMMERCIAL_MODEL.own_offer_types,...COMMERCIAL_MODEL.third_party_offer_types].includes(type) ? type : '';
}

export function revenueRecognitionRule(offerType) {
  const type=classifyOfferType(offerType);
  if(['service','digital_product'].includes(type)) return Object.freeze({source:'authenticated_payment',provider:'asaas'});
  if(type==='affiliate_product') return Object.freeze({source:'confirmed_commission',provider:'affiliate_network'});
  return Object.freeze({source:'none',provider:'none'});
}

export function requiresInventory(offerType) {
  return classifyOfferType(offerType) ? false : null;
}
