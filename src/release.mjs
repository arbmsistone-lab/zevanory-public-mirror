export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0029-RC1',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  requiredRoutes: Object.freeze([
    '/',
    '/piloto',
    '/api/config',
    '/api/health',
    '/api/events/public',
    '/api/checkout/asaas',
    '/api/webhooks/asaas',
    '/api/release',
  ]),
});
