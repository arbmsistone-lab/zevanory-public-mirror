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
  sellable: true,
  checkout_enabled: true,
  artifact_materialized: true,
  status: 'commercial_release_ready_global_sales_locked_not_published',
  version: '1.0',
  offer_type: 'saas_subscription',
  delivery_mode: 'managed_service_activation',
  checkout_path: '/api/subscriptions/arbm-contador',
  billing_provider: 'mercadopago_subscriptions',
  source: Object.freeze({
    repository: 'arbmsistone-lab/arbm-mei',
    release: 'COMMERCIAL_RELEASE_1_0',
    package_version: '0.1.0',
    git_sha: '20705d1620f640cee1b2a0aac97986d312c3e808',
    production_worker: 'https://arbm-mei-api.zevanory.workers.dev',
    cloudflare_version_id: '6fa21b6b-d636-4726-a6fb-dd9d74605f6f',
  }),
  price_status: 'product_specific_pricing_approved_global_sales_locked',
  pricing: Object.freeze({monthly_brl:59.90,annual_brl:599.00,implementation_brl:0.00}),
  certified_features: Object.freeze([
    'agenda_e_gestao_de_atendimentos','gestao_de_clientes','receitas_recebiveis_despesas_e_resultado_liquido',
    'ledger_financeiro_imutavel_com_estornos','radar_de_faturamento_mei_com_regra_oficial_versionada',
    'lembretes_de_obrigacoes_mei_e_relatorio_mensal','assistente_ia_operacional_com_guardrails_fiscais',
    'recuperacao_de_conta_exportacao_de_dados_e_encerramento','termos_privacidade_e_aceite_versionado',
  ]),
  excluded_from_v1: Object.freeze([
    'comissoes','estoque','nfse_automatica_ou_credenciais_governamentais','open_finance_ou_iniciacao_pix',
    'automacao_whatsapp','representacao_contabil_juridica',
  ]),
  positioning: 'Gestão essencial para salões e profissionais de beleza, com agenda, clientes, financeiro e controles MEI assistidos por IA sem prometer automações fiscais reguladas.',
  commercial_contract: Object.freeze({
    license:'subscription_per_company_tenant_non_transferable',
    provisioning:'activation_only_after_product_gate_payment_and_onboarding_inputs',
    support_channel:'suporte@zevanory.api.br',privacy_channel:'contato@zevanory.api.br',
    customer_data_export_supported:true,cancellation_terms_path:'/reembolso',privacy_terms_path:'/privacidade',
  }),
  release_requirements: Object.freeze({
    technical_source_identified:true,canonical_version_identified:true,artifact_hash_certified:true,
    product_specific_pricing_approved:true,e2e_provisioning_certified:true,support_runbook_certified:true,
    recurring_billing_contract_certified:true,
  }),
  commercial_release_gate:'ARBM_CONTADOR_SALOES_COMMERCIAL_RELEASE_APPROVED',
  sales_gate:'ZEVANORY_COMMERCIAL_SALES_LOCKED',
});

export function arbmContadorSaloesReleaseReady(env=process.env,offer=ARBM_CONTADOR_SALOES_OFFER){
  const runtimeReady=String(env.ARBM_CONTADOR_SUBSCRIPTIONS_ENABLED||'').toLowerCase()==='true'&&
    Boolean(String(env.ARBM_CONTADOR_MP_MONTHLY_PLAN_ID||'').trim())&&Boolean(String(env.ARBM_CONTADOR_MP_ANNUAL_PLAN_ID||'').trim());
  return offer.sellable===true&&offer.checkout_enabled===true&&offer.artifact_materialized===true&&
    Object.values(offer.release_requirements).every(Boolean)&&runtimeReady;
}
