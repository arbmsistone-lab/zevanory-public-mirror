export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0032-FINAL',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  structuralCompletion: 'operations-console-ready',
  assurance: Object.freeze({
    quality_gate: 'approved', audit_3x: 'approved', security_10x: 'approved',
    observability_10x: 'approved', dr_10x: 'approved', sales_machine_20x: 'approved',
    final_15x: 'approved', audit_30x: 'approved', resilience: 'approved',
  }),
  recovery: Object.freeze({ mode:'transactional-rollback', tables:7, migrations:6, persistent_changes:false }),
  requiredRoutes: Object.freeze([
    '/', '/piloto', '/api/config', '/api/health', '/api/live', '/api/status',
    '/api/events/public', '/api/checkout/asaas', '/api/webhooks/asaas', '/api/release',
  ]),
});
