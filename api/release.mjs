import { RELEASE } from '../src/release.mjs';

export default function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const deployment=Object.freeze({
    environment:process.env.VERCEL_ENV || 'local',
    branch:process.env.VERCEL_GIT_COMMIT_REF || null,
    commit_sha:process.env.VERCEL_GIT_COMMIT_SHA || null,
    region:process.env.VERCEL_REGION || null,
  });
  res.statusCode=200;
  return res.end(JSON.stringify({
    release_id:RELEASE.id,
    structural_completion:RELEASE.structuralCompletion,
    sales_mode:RELEASE.salesMode,
    checkout_mode:RELEASE.checkoutMode,
    financial_mode:RELEASE.financialMode,
    required_routes:RELEASE.requiredRoutes,    assurance:RELEASE.assurance,
    recovery:RELEASE.recovery,
    deployment,
  }));
}
