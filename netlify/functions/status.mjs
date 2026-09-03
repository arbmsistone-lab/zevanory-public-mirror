import handler from '../../api/status.mjs';
import { invokeLegacy, withSearch } from '../lib/legacy-adapter.mjs';
export default req => invokeLegacy(handler,req,{rewriteUrl:u=>u.pathname==='/api/live'?withSearch(u,'probe','live'):u.pathname==='/api/health'?withSearch(u,'probe','health'):u});
export const config={path:['/api/status','/api/live','/api/health']};
