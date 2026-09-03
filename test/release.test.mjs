import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release.mjs';
import releaseHandler from '../api/release.mjs';

test('release fingerprint is canonical and immutable',()=>{
  assert.equal(RELEASE.id,'ZEVANORY-EG0039-FINAL');
  assert.equal(Object.isFrozen(RELEASE),true);
  assert.equal(RELEASE.structuralCompletion,'arbm-sist-offer-launch-ready');
  assert.equal(RELEASE.commercialModel,'no-inventory');
  assert.equal(RELEASE.assurance.autonomous_engine_20x,'approved');
  assert.equal(RELEASE.assurance.composable_10x5,'approved');
  assert.equal(RELEASE.assurance.enterprise_10x,'approved');
  assert.equal(RELEASE.assurance.activation_20x,'approved');
  assert.equal(RELEASE.assurance.single_screen_layout,'approved');
  assert.equal(RELEASE.assurance.worldclass_dashboard,'approved');
  assert.equal(RELEASE.assurance.visual_certification,'approved');
  assert.equal(RELEASE.assurance.offer_launch_20x,'approved');
  assert.equal(RELEASE.assurance.official_brand,'approved');
  assert.equal(RELEASE.assurance.rules_audit_20x,'approved');
  assert.equal(RELEASE.assurance.sales_lifecycle_v2,'blocked_pending_39x10');
  assert.equal(RELEASE.recovery.tables,23);
  assert.equal(RELEASE.recovery.migrations,16);
  assert.equal(RELEASE.salesMode,'globally-blocked');
  assert.equal(RELEASE.checkoutMode,'globally-blocked');
});

test('release manifest requires all production surfaces',()=>{
  for(const route of ['/','/arbm-sist','/piloto','/termos','/privacidade','/reembolso','/afiliados','/api/config','/api/health','/api/live','/api/status','/api/assurance','/api/activation/readiness','/api/events/public','/api/events/operator','/api/agent/status','/api/agent/run','/api/checkout/asaas','/api/webhooks/asaas','/api/webhooks/resend','/api/webhooks/meta','/api/release']) assert.equal(RELEASE.requiredRoutes.includes(route),true);
});
function invokeRelease(env={}){  const previous={...process.env}; Object.assign(process.env,env);
  let body=''; const headers={};
  const res={statusCode:0,setHeader:(k,v)=>{headers[k]=v},end:(v)=>{body=String(v||'')}};
  try { releaseHandler({method:'GET'},res); return {status:res.statusCode,body:JSON.parse(body),headers}; }
  finally { process.env=previous; }
}

test('release endpoint prefers valid native Vercel provenance over stale explicit metadata',()=>{
  const native='b'.repeat(40);
  const r=invokeRelease({ZEVANORY_RELEASE_SHA:'a'.repeat(40),ZEVANORY_RELEASE_REF:'stale',VERCEL_GIT_COMMIT_SHA:native,VERCEL_GIT_COMMIT_REF:'main'});
  assert.equal(r.status,200);
  assert.equal(r.body.deployment.commit_sha,native);
  assert.equal(r.body.deployment.branch,'main');
});

test('release endpoint uses valid explicit provenance when native metadata is absent',()=>{
  const sha='a'.repeat(40);
  const r=invokeRelease({ZEVANORY_RELEASE_SHA:sha,ZEVANORY_RELEASE_REF:'main',VERCEL_GIT_COMMIT_SHA:'',VERCEL_GIT_COMMIT_REF:''});
  assert.equal(r.body.deployment.commit_sha,sha);
  assert.equal(r.body.deployment.branch,'main');
});

test('release endpoint rejects malformed explicit SHA and falls back to Vercel metadata',()=>{
  const native='b'.repeat(40);
  const r=invokeRelease({ZEVANORY_RELEASE_SHA:'not-a-sha',VERCEL_GIT_COMMIT_SHA:native});
  assert.equal(r.body.deployment.commit_sha,native);
});
