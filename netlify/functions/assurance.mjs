import handler from '../../src/http/assurance.mjs'; import { invokeLegacy } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req); export const config={path:'/api/assurance'};
