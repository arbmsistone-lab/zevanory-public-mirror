import { aiServicePublicIdentity } from '../aiServiceIdentity.mjs';

export default async function handler(req,res){
  if(req.method!=='GET'){
    res.statusCode=405;res.setHeader('content-type','application/json; charset=utf-8');
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const secret=process.env.ELITE_INTERNAL_TOKEN;
  if(!secret){res.statusCode=503;res.setHeader('content-type','application/json; charset=utf-8');return res.end(JSON.stringify({error:'ai_service_identity_unavailable'}));}
  const identity=aiServicePublicIdentity(secret);
  res.statusCode=200;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','public, max-age=300');
  return res.end(JSON.stringify({ok:true,...identity,secret_exposed:false}));
}
