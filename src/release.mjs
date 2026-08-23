export const RELEASE = Object.freeze({
  id: 'ZEVANORY-EG0014-RC1',
  checkoutMode: 'sandbox-disabled',
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
