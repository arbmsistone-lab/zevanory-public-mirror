import handler from '../../api/config.mjs';
import { invokeLegacy, withSearch } from '../lib/legacy-adapter.mjs';
export default req => invokeLegacy(handler,req,{rewriteUrl:u=>u.pathname==='/api/activation/readiness'?withSearch(u,'view','activation'):u});
export const config={path:['/api/config','/api/activation/readiness']};
