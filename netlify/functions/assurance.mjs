import handler from '../../api/assurance.mjs'; import { invokeLegacy } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req); export const config={path:'/api/assurance'};
