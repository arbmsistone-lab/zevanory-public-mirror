import handler from '../../api/checkout.mjs'; import { invokeLegacy, withSearch } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req,{rewriteUrl:u=>u.pathname.endsWith('/asaas')?withSearch(u,'provider','asaas'):u.pathname.endsWith('/mercadopago')?withSearch(u,'provider','mercadopago'):u});
export const config={path:['/api/checkout','/api/checkout/asaas','/api/checkout/mercadopago']};
