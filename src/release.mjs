export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0039-FINAL',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  commercialModel: 'no-inventory',
  structuralCompletion: 'zevanory-digital-products-release-ready',
  assurance: Object.freeze({
    quality_gate:'approved', audit_3x:'approved', security_10x:'approved',
    observability_10x:'approved', dr_10x:'approved', sales_machine_20x:'approved',
    command_center_20x:'approved', architecture_20x:'approved', autonomous_engine_20x:'approved',
    composable_10x5:'approved', enterprise_10x:'approved', activation_20x:'approved',
    single_screen_layout:'approved', worldclass_dashboard:'approved', visual_certification:'approved', offer_launch_20x:'approved', official_brand:'approved', rules_audit_20x:'approved', audit_30x:'approved', resilience:'approved',
    contract_smoke:'approved', supplychain_scan:'approved', final_20x:'approved', sales_lifecycle_v2:'approved_39x10_technical_release',
  }),
  recovery: Object.freeze({ mode:'transactional-rollback', tables:23, migrations:16, persistent_changes:false }),
  requiredRoutes: Object.freeze([
    '/', '/piloto', '/termos', '/privacidade', '/reembolso', '/afiliados',
    '/api/config', '/api/health', '/api/live', '/api/status', '/api/assurance', '/api/activation/readiness',
    '/api/events/public', '/api/events/operator', '/api/agent/status', '/api/agent/run',
    '/api/checkout/asaas', '/api/webhooks/asaas', '/api/checkout/mercadopago', '/api/webhooks/mercadopago', '/api/webhooks/resend', '/api/webhooks/meta', '/api/webhooks/mercadolivre', '/api/release',
  ]),
});
