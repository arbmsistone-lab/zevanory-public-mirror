export const ARBM_CONTADOR_SALOES_OFFER = Object.freeze({
  id: 'ARBM-CONTADOR-SALOES',
  product: 'ARBM Contador para Salões',
  commercial_name: 'ARBM Contador para Salões - by ZEVANORY',
  brand: 'ZEVANORY',
  endorsed_by: 'ARBM',
  brand_signature: 'by ARBM',
  portfolio_role: 'vertical_business_software',
  target_segment: 'saloes_de_beleza_e_profissionais_de_beleza',
  primary: false,
  sellable: false,
  checkout_enabled: false,
  artifact_materialized: false,
  status: 'commercial_integration_ready_technical_artifact_and_pricing_gated_not_published',
  offer_type: 'saas_subscription',
  delivery_mode: 'managed_service_activation',
  price_status: 'pending_product_specific_commercial_gate',
  pricing: Object.freeze({
    monthly_brl: null,
    annual_brl: null,
    implementation_brl: null,
  }),
  certified_features: Object.freeze([]),
  intended_scope: Object.freeze(['agenda','clientes','financeiro','comissoes','estoque','relatorios']),
  positioning: 'Software vertical da família ARBM para organizar a operação de salões de beleza com escopo final sujeito à certificação técnica do produto.',
  commercial_contract: Object.freeze({
    license: 'subscription_per_company_tenant_non_transferable',
    provisioning: 'activation_only_after_product_gate_payment_and_onboarding_inputs',
    support_channel: 'suporte@zevanory.api.br',
    privacy_channel: 'contato@zevanory.api.br',
    customer_data_export_supported: true,
    cancellation_terms_path: '/reembolso',
    privacy_terms_path: '/privacidade',
  }),
  release_requirements: Object.freeze({
    technical_source_identified: false,
    canonical_version_identified: false,
    artifact_hash_certified: false,
    product_specific_pricing_approved: false,
    e2e_provisioning_certified: false,
    support_runbook_certified: false,
  }),
  commercial_release_gate: 'ARBM_CONTADOR_SALOES_COMMERCIAL_RELEASE_APPROVED',
  sales_gate: 'ZEVANORY_COMMERCIAL_SALES_LOCKED',
});

export function arbmContadorSaloesReleaseReady(offer=ARBM_CONTADOR_SALOES_OFFER){
  return offer.sellable===true && offer.checkout_enabled===true && offer.artifact_materialized===true &&
    Object.values(offer.release_requirements).every(Boolean);
}
