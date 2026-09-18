import releaseHandler from '../src/http/release.mjs';
import assuranceHandler from '../src/http/assurance.mjs';
import financeHandler from '../src/http/finance.mjs';
import controlPlaneHandler from '../src/http/control-plane.mjs';

const handlers=Object.freeze({release:releaseHandler,assurance:assuranceHandler,finance:financeHandler,'control-plane':controlPlaneHandler});
export default async function handler(req,res){
  const surface=String(req.query?.surface||new URL(req.url||'/api/platform','https://zevanory.api.br').searchParams.get('surface')||'').toLowerCase();
  const target=handlers[surface];
  if(!target){res.statusCode=404;res.setHeader('content-type','application/json; charset=utf-8');return res.end(JSON.stringify({error:'platform_surface_not_found'}));}
  return target(req,res);
}
