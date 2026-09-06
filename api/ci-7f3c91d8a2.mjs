import { verifyExternalChannelIdentities } from '../src/channelIdentityPreflight.mjs';
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  if(req.method!=='GET'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const result=await verifyExternalChannelIdentities({env:process.env,fetchImpl:globalThis.fetch});
  const safe=Object.fromEntries(Object.entries(result).map(([k,v])=>[k,{attempted:v.attempted,verified:v.verified,reason:v.reason,details:v.details||null}]));
  res.statusCode=200; return res.end(JSON.stringify({mode:'read_only_identity_preflight',result:safe}));
}
