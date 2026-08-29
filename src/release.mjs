export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0037-FINAL',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  commercialModel: 'no-inventory',
  structuralCompletion: 'enterprise-operational-assurance-ready',
  assurance: Object.freeze({
    quality_gate:'approved', audit_3x:'approved', security_10x:'approved',
    observability_10x:'approved', dr_10x:'approved', sales_machine_20x:'approved',
    command_center_20x:'approved', architecture_20x:'approved', autonomous_engine_20x:'approved',
    composable_10x5:'approved', enterprise_10x:'approved', audit_30x:'approved',
    resilience:'approved', contract_smoke:'approved', supplychain_scan:'approved', final_20x:'approved',
  }),
  recovery: Object.freeze({ mode:'transactional-rollback', tables:15, migrations:9, persistent_changes:false }),
  requiredRoutes: Object.freeze([
    '/', '/piloto', '/termos', '/privacidade', '/reembolso', '/afiliados',
    '/api/config', '/api/health', '/api/live', '/api/status', '/api/assurance',
    '/api/events/public', '/api/events/operator', '/api/agent/status', '/api/agent/run',
    '/api/checkout/asaas', '/api/webhooks/asaas', '/api/release',
  ]),
});
