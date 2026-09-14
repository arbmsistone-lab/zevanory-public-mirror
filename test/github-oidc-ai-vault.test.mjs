import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_OIDC_TRUST, verifyGitHubOidcToken } from '../src/githubOidcTrust.mjs';

const b64url=(value)=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function fixture(overrides={}){
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='test-key';jwk.alg='RS256';jwk.use='sig';
  const now=Math.floor(Date.now()/1000),header=b64url({alg:'RS256',kid:'test-key',typ:'JWT'});
  const claims={iss:GITHUB_OIDC_TRUST.issuer,aud:GITHUB_OIDC_TRUST.audience,repository:GITHUB_OIDC_TRUST.repository,
    repository_id:GITHUB_OIDC_TRUST.repository_id,repository_owner_id:GITHUB_OIDC_TRUST.repository_owner_id,
    ref:GITHUB_OIDC_TRUST.ref,event_name:GITHUB_OIDC_TRUST.event_name,
    job_workflow_ref:`${GITHUB_OIDC_TRUST.repository}/${GITHUB_OIDC_TRUST.workflow_path}@${GITHUB_OIDC_TRUST.ref}`,
    run_id:'123',iat:now-5,nbf:now-5,exp:now+300,...overrides};
  const payload=b64url(claims),data=`${header}.${payload}`;
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data));
  const token=`${data}.${Buffer.from(sig).toString('base64url')}`;
  const fetchImpl=async()=>new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'content-type':'application/json'}});
  return {token,fetchImpl,now};
}
test('GitHub OIDC trust accepts only the pinned proof workflow identity',async()=>{
  const f=await fixture();
  const out=await verifyGitHubOidcToken(f.token,{fetchImpl:f.fetchImpl,nowSec:f.now});
  assert.equal(out.ok,true);assert.equal(out.repository,GITHUB_OIDC_TRUST.repository);assert.equal(out.ref,GITHUB_OIDC_TRUST.ref);
});

test('GitHub OIDC trust rejects another repository even with valid signature',async()=>{
  const f=await fixture({repository:'arbmsistone-lab/other-repo'});
  await assert.rejects(()=>verifyGitHubOidcToken(f.token,{fetchImpl:f.fetchImpl,nowSec:f.now}),/repository_invalid/);
});

test('GitHub OIDC trust rejects tampered signed content',async()=>{
  const f=await fixture();
  const parts=f.token.split('.');
  const tampered=`${parts[0]}.${b64url({...JSON.parse(Buffer.from(parts[1],'base64url').toString()),event_name:'push'})}.${parts[2]}`;
  await assert.rejects(()=>verifyGitHubOidcToken(tampered,{fetchImpl:f.fetchImpl,nowSec:f.now}),/signature_invalid/);
});
