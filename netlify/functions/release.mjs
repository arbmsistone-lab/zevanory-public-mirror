import handler from '../../api/release.mjs'; import { invokeLegacy } from '../lib/legacy-adapter.mjs';
export default req=>invokeLegacy(handler,req); export const config={path:'/api/release'};
