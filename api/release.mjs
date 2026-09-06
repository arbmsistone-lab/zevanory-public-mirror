import { RELEASE, runtimeReleaseModes } from '../src/release.mjs';

const validSha = (value) => /^[0-9a-f]{40}$/i.test(String(value||'').trim());
const validRef = (value) => /^[A-Za-z0-9._/-]{1,120}$/.test(String(value||'').trim());
const explicitReleaseSha = () => {
  const value=String(process.env.ZEVANORY_RELEASE_SHA||'').trim();
  return validSha(value) ? value.toLowerCase() : null;
};
const explicitReleaseRef = () => {
  const value=String(process.env.ZEVANORY_RELEASE_REF||'').trim();
  return validRef(value) ? value : null;
};
const nativeReleaseSha = () => {
  const value=String(process.env.VERCEL_GIT_COMMIT_SHA||'').trim();
  return validSha(value) ? value.toLowerCase() : null;
};
const nativeReleaseRef = () => {
  const value=String(process.env.VERCEL_GIT_COMMIT_REF||'').trim();
  return validRef(value) ? value : null;
};

export default function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  const runtimeModes=runtimeReleaseModes(process.env);
  const deployment=Object.freeze({
    environment:process.env.VERCEL_ENV || 'local',    branch:nativeReleaseRef() || explicitReleaseRef(),
    commit_sha:nativeReleaseSha() || explicitReleaseSha(),
    region:process.env.VERCEL_REGION || null,
  });
  res.statusCode=200;
  return res.end(JSON.stringify({
    release_id:RELEASE.id, structural_completion:RELEASE.structuralCompletion,
    sales_mode:runtimeModes.salesMode, checkout_mode:runtimeModes.checkoutMode,
    financial_mode:runtimeModes.financialMode, whatsapp_mode:runtimeModes.whatsappMode, required_routes:RELEASE.requiredRoutes,
    assurance:RELEASE.assurance, recovery:RELEASE.recovery, deployment,
  }));
}
