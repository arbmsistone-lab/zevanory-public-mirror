export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0031-RC1',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  requiredRoutes: Object.freeze([
    '/',
    '/piloto',
    '/api/config',
    '/api/health',
    '/api/live',
    '/api/events/public',
    '/api/checkout/asaas',
    '/api/webhooks/asaas',
    '/api/release',
  ]),
});
