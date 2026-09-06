import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/release.mjs';

const invoke=(env)=>{const old={...process.env};Object.assign(process.env,env);let body='';const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(v=''){body=v;}};try{handler({method:'GET'},res);return JSON.parse(body);}finally{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}};

test('generic deployment provenance is used outside Vercel',()=>{
  const out=invoke({VERCEL_ENV:'',VERCEL_REGION:'',VERCEL_GIT_COMMIT_SHA:'',VERCEL_GIT_COMMIT_REF:'',ZEVANORY_DEPLOYMENT_ENV:'cold-standby',ZEVANORY_DEPLOYMENT_REGION:'us-east-2',ZEVANORY_RELEASE_SHA:'0b1c976e0c7596a2edad6355efa4c01d36917524',ZEVANORY_RELEASE_REF:'main'});
  assert.equal(out.deployment.environment,'cold-standby');
  assert.equal(out.deployment.region,'us-east-2');
  assert.equal(out.deployment.branch,'main');
  assert.equal(out.deployment.commit_sha,'0b1c976e0c7596a2edad6355efa4c01d36917524');
});

test('native Vercel provenance remains authoritative',()=>{
  const out=invoke({VERCEL_ENV:'production',VERCEL_REGION:'iad1',VERCEL_GIT_COMMIT_SHA:'1111111111111111111111111111111111111111',VERCEL_GIT_COMMIT_REF:'main',ZEVANORY_DEPLOYMENT_ENV:'cold-standby',ZEVANORY_DEPLOYMENT_REGION:'us-east-2',ZEVANORY_RELEASE_SHA:'2222222222222222222222222222222222222222',ZEVANORY_RELEASE_REF:'backup'});
  assert.equal(out.deployment.environment,'production');
  assert.equal(out.deployment.region,'iad1');
  assert.equal(out.deployment.branch,'main');
  assert.equal(out.deployment.commit_sha,'1111111111111111111111111111111111111111');
});
