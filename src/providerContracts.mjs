export const PROVIDER_CONTRACTS=Object.freeze({
  asaas:Object.freeze({
    auth_header:'access_token',
    payment_lookup_method:'GET',
    success_statuses:Object.freeze([200]),
    required_payment_fields:Object.freeze(['id','status']),
  }),
  meta_whatsapp:Object.freeze({
    transport:'adapter',
    commercial_gate:'WHATSAPP_SALES_ENABLED',
    provider_specific_logic_outside_core:true,
  }),
  affiliate:Object.freeze({
    revenue_truth:'confirmed_commission_only',
    provider_specific_logic_outside_core:true,
  }),
  gemini:Object.freeze({
    optional:true,
    deterministic_fallback_required:true,
    structured_output_required:true,
  }),
});

export function validateProviderContracts(contracts=PROVIDER_CONTRACTS){
  const errors=[];
  if(contracts.asaas.auth_header!=='access_token') errors.push('asaas_auth_contract');
  if(contracts.asaas.payment_lookup_method!=='GET') errors.push('asaas_lookup_contract');
  if(!contracts.meta_whatsapp.provider_specific_logic_outside_core) errors.push('meta_adapter_contract');
  if(contracts.affiliate.revenue_truth!=='confirmed_commission_only') errors.push('affiliate_truth_contract');
  if(!contracts.gemini.optional||!contracts.gemini.deterministic_fallback_required) errors.push('ai_fallback_contract');
  return Object.freeze({valid:errors.length===0,errors:Object.freeze(errors)});
}
