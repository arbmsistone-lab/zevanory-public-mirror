const enc=new TextEncoder();
const b64urlToBytes=(value)=>{
  const raw=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=raw+'='.repeat((4-raw.length%4)%4);
  const bin=atob(padded),out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
};
const decodeJson=(value)=>JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
const audienceMatches=(claim,expected)=>Array.isArray(claim)?claim.includes(expected):claim===expected;
export const GITHUB_OIDC_TRUST=Object.freeze({
  issuer:'https://token.actions.githubusercontent.com',
  jwks:'https://token.actions.githubusercontent.com/.well-known/jwks',
  audience:'zevanory-ai-vault',
  repository:'arbmsistone-lab/arbm-sist-external-exec-proof',
  repository_id:'1355191632',
  repository_owner_id:'295485177',
  ref:'refs/heads/g3-free-cert-lane-20260910',
  workflow_path:'.github/workflows/zevanory-ai3-free-transfer.yml',
  event_name:'workflow_dispatch',
});
export async function verifyGitHubOidcToken(token,{fetchImpl=globalThis.fetch,trust=GITHUB_OIDC_TRUST,nowSec=Math.floor(Date.now()/1000)}={}){
  const parts=String(token||'').split('.');
  if(parts.length!==3)throw new Error('github_oidc_malformed');
  const [h,p,s]=parts,header=decodeJson(h),claims=decodeJson(p);
  if(header.alg!=='RS256'||!header.kid)throw new Error('github_oidc_header_invalid');
  const response=await fetchImpl(trust.jwks,{headers:{accept:'application/json'},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('github_oidc_jwks_unavailable');
  const jwks=await response.json(),jwk=(jwks?.keys||[]).find(x=>x.kid===header.kid&&x.kty==='RSA');
  if(!jwk)throw new Error('github_oidc_kid_untrusted');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64urlToBytes(s),enc.encode(`${h}.${p}`));
  if(!valid)throw new Error('github_oidc_signature_invalid');
  if(claims.iss!==trust.issuer||!audienceMatches(claims.aud,trust.audience))throw new Error('github_oidc_issuer_audience_invalid');
  if(Number(claims.exp)<=nowSec||Number(claims.nbf||0)>nowSec+30||Number(claims.iat||0)>nowSec+30)throw new Error('github_oidc_time_invalid');
  if(claims.repository!==trust.repository||String(claims.repository_id)!==trust.repository_id)throw new Error('github_oidc_repository_invalid');
  if(String(claims.repository_owner_id)!==trust.repository_owner_id||claims.ref!==trust.ref)throw new Error('github_oidc_ref_invalid');
  if(claims.event_name!==trust.event_name)throw new Error('github_oidc_event_invalid');
  const expectedWorkflow=`${trust.repository}/${trust.workflow_path}@${trust.ref}`;
  if(claims.job_workflow_ref!==expectedWorkflow)throw new Error('github_oidc_workflow_invalid');
  return Object.freeze({ok:true,repository:claims.repository,ref:claims.ref,run_id:String(claims.run_id||''),workflow:claims.job_workflow_ref});
}
