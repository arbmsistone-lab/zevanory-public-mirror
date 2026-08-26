export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0032-FINAL',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  structuralCompletion: 'sales-machine-ready',
  requiredRoutes: Object.freeze([
    '/',
    '/piloto',
    '/api/config',
    '/api/health',
    '/api/live',
    '/api/status',
    '/api/events/public',
    '/api/checkout/asaas',
    '/api/webhooks/asaas',
    '/api/release',
  ]),
});
