export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0033-FINAL',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  commercialModel: 'no-inventory',
  structuralCompletion: 'precommerce-no-inventory-ready',
  assurance: Object.freeze({
    quality_gate: 'approved', audit_3x: 'approved', security_10x: 'approved',
    observability_10x: 'approved', dr_10x: 'approved', sales_machine_20x: 'approved',
    final_15x: 'approved', audit_30x: 'approved', resilience: 'approved',
  }),
  recovery: Object.freeze({ mode:'transactional-rollback', tables:9, migrations:7, persistent_changes:false }),
  requiredRoutes: Object.freeze([
    '/', '/piloto', '/termos', '/privacidade', '/reembolso', '/afiliados',
    '/api/config', '/api/health', '/api/live', '/api/status', '/api/events/public',
    '/api/checkout/asaas', '/api/webhooks/asaas', '/api/release',
  ]),
});