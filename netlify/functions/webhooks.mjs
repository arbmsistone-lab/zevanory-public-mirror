import handler from '../../api/webhooks.mjs'; import { invokeLegacy, withSearch } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req,{rewriteUrl:u=>{const p=u.pathname.split('/').pop(); return ['asaas','mercadopago','resend','meta'].includes(p)?withSearch(u,'provider',p):u;}});
export const config={path:['/api/webhooks','/api/webhooks/asaas','/api/webhooks/mercadopago','/api/webhooks/resend','/api/webhooks/meta']};
