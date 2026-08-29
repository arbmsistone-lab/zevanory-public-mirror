const present=(v)=>Boolean(String(v||'').trim());

export function evaluateCommercialCompliance(input={}) {
  const blockers=[];
  if(!present(input.supplier_legal_name)) blockers.push('supplier_legal_name_missing');
  if(!present(input.supplier_tax_id)) blockers.push('supplier_tax_id_missing');
  if(!present(input.supplier_address)) blockers.push('supplier_address_missing');
  if(!present(input.support_channel)) blockers.push('support_channel_missing');
  if(input.terms_published!==true) blockers.push('terms_unpublished');
  if(input.privacy_published!==true) blockers.push('privacy_unpublished');
  if(input.refund_policy_published!==true) blockers.push('refund_policy_unpublished');
  if(input.service_delivery_policy_published!==true) blockers.push('service_delivery_policy_unpublished');
  if(input.affiliate_disclosure_published!==true) blockers.push('affiliate_disclosure_unpublished');
  return Object.freeze({
    ready:blockers.length===0,
    blockers:Object.freeze(blockers),
  });
}
