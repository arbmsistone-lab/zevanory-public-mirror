import test from 'node:test';
import assert from 'node:assert/strict';
import { brandIdentityReadiness, BRAND_IDENTITY_FRONTS } from '../src/brandIdentityReadiness.mjs';
import { EXCLUDED_COMMERCIAL_FRONTS } from '../src/activeCommercialScope.mjs';

test('brand identity gate covers exactly the 9 active fronts',()=>{
  assert.equal(BRAND_IDENTITY_FRONTS.length,9);
  for(const name of ['tiktok','linkedin','nuvemshop']) assert.equal(BRAND_IDENTITY_FRONTS.includes(name),false);
  assert.deepEqual(Object.keys(EXCLUDED_COMMERCIAL_FRONTS).sort(),['linkedin','nuvemshop','tiktok']);
  const r=brandIdentityReadiness({});
  assert.equal(r.total_fronts,9);assert.equal(r.ready,false);assert.equal(r.verified_fronts,4);
});

test('standby identities do not inflate active identity readiness',()=>{
  const env={TIKTOK_PROFILE_VERIFIED:'true',LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',NUVEMSHOP_STOREFRONT_VERIFIED:'true'};
  const r=brandIdentityReadiness(env);
  assert.equal(r.total_fronts,9);assert.equal(r.fronts.tiktok,undefined);assert.equal(r.fronts.linkedin,undefined);assert.equal(r.fronts.nuvemshop,undefined);
});

test('brand identity becomes ready when all 9 active identity proofs are present',()=>{
  const env={};
  for(const key of ['WHATSAPP','INSTAGRAM','FACEBOOK','YOUTUBE','MERCADOLIVRE']) env[`${key}_BRAND_IDENTITY_VERIFIED`]='true';
  const r=brandIdentityReadiness(env);assert.equal(r.ready,true);assert.equal(r.verified_fronts,9);assert.deepEqual(r.blockers,[]);
});
