export const PROVIDER_CONTRACTS=Object.freeze({
  asaas:Object.freeze({auth_header:'access_token',payment_lookup_method:'GET',success_statuses:Object.freeze([200]),required_payment_fields:Object.freeze(['id','status'])}),
  mercadopago:Object.freeze({auth_header:'authorization_bearer',payment_lookup_method:'GET',webhook_signature:'hmac_sha256',success_statuses:Object.freeze([200]),required_payment_fields:Object.freeze(['id','status','external_reference','transaction_amount'])}),
  meta_whatsapp:Object.freeze({transport:'adapter',commercial_gate:'WHATSAPP_SALES_ENABLED',provider_specific_logic_outside_core:true}),
  affiliate:Object.freeze({revenue_truth:'confirmed_commission_only',provider_specific_logic_outside_core:true,reversal_required:true,idempotency_required:true}),
  nuvemshop:Object.freeze({auth:'oauth2_authorization_code',api_version:'v1',product_create:'POST /products',webhooks_required:true,provider_truth_required:true}),
  mercado_livre:Object.freeze({auth:'oauth2_authorization_code',auth_header:'authorization_bearer',product_create:'POST /items',notifications_required:true,resource_lookup_after_notification:true,separate_ml_mp_app_required_since:'2026-08-30'}),
  gemini:Object.freeze({optional:true,deterministic_fallback_required:true,structured_output_required:true}),
});

export function validateProviderContracts(contracts=PROVIDER_CONTRACTS){
  const errors=[];
  if(contracts.asaas.auth_header!=='access_token') errors.push('asaas_auth_contract');
  if(contracts.asaas.payment_lookup_method!=='GET') errors.push('asaas_lookup_contract');
  if(contracts.mercadopago.auth_header!=='authorization_bearer') errors.push('mercadopago_auth_contract');
  if(contracts.mercadopago.payment_lookup_method!=='GET'||contracts.mercadopago.webhook_signature!=='hmac_sha256') errors.push('mercadopago_truth_contract');
  if(!contracts.meta_whatsapp.provider_specific_logic_outside_core) errors.push('meta_adapter_contract');
  if(contracts.affiliate.revenue_truth!=='confirmed_commission_only'||!contracts.affiliate.reversal_required||!contracts.affiliate.idempotency_required) errors.push('affiliate_truth_contract');
  if(contracts.nuvemshop.auth!=='oauth2_authorization_code'||!contracts.nuvemshop.webhooks_required||!contracts.nuvemshop.provider_truth_required) errors.push('nuvemshop_contract');
  if(contracts.mercado_livre.auth!=='oauth2_authorization_code'||!contracts.mercado_livre.notifications_required||!contracts.mercado_livre.resource_lookup_after_notification) errors.push('mercado_livre_contract');
  if(!contracts.gemini.optional||!contracts.gemini.deterministic_fallback_required) errors.push('ai_fallback_contract');
  return Object.freeze({valid:errors.length===0,errors:Object.freeze(errors)});
}