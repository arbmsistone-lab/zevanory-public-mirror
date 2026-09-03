import handler from '../../api/events-public.mjs'; import { invokeLegacy } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req); export const config={path:'/api/events/public'};
