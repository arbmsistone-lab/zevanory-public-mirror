export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0018-RC2',
  salesMode: 'globally-blocked',
  checkoutMode: 'globally-blocked',
  financialMode: 'disabled',
  requiredRoutes: Object.freeze([
    '/',
    '/piloto',
    '/api/config',
    '/api/events/public',
    '/api/checkout/asaas',
    '/api/webhooks/asaas',
    '/api/release',
  ]),
});
