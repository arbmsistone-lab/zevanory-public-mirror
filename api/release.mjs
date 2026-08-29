import { RELEASE } from '../src/release.mjs';

const explicitReleaseSha = () => {
  const value=String(process.env.ZEVANORY_RELEASE_SHA||'').trim();
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
};
const explicitReleaseRef = () => {
  const value=String(process.env.ZEVANORY_RELEASE_REF||'').trim();
  return /^[A-Za-z0-9._/-]{1,120}$/.test(value) ? value : null;
};

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
    branch:explicitReleaseRef() || process.env.VERCEL_GIT_COMMIT_REF || null,
    commit_sha:explicitReleaseSha() || process.env.VERCEL_GIT_COMMIT_SHA || null,
    region:process.env.VERCEL_REGION || null,
  });
  res.statusCode=200;
  return res.end(JSON.stringify({
    release_id:RELEASE.id, structural_completion:RELEASE.structuralCompletion,
    sales_mode:RELEASE.salesMode, checkout_mode:RELEASE.checkoutMode,
    financial_mode:RELEASE.financialMode, required_routes:RELEASE.requiredRoutes,
    assurance:RELEASE.assurance, recovery:RELEASE.recovery, deployment,
  }));
}
