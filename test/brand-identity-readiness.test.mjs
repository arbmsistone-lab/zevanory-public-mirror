import test from 'node:test';
import assert from 'node:assert/strict';
import { brandIdentityReadiness, BRAND_IDENTITY_FRONTS } from '../src/brandIdentityReadiness.mjs';

test('brand identity gate covers all 12 commercial fronts',()=>{
  assert.equal(BRAND_IDENTITY_FRONTS.length,12);
  const r=brandIdentityReadiness({});
  assert.equal(r.total_fronts,12);
  assert.equal(r.ready,false);
  assert.equal(r.verified_fronts,4);
  assert.ok(r.blockers.includes('WHATSAPP_BRAND_IDENTITY_NOT_VERIFIED'));
  assert.ok(r.blockers.includes('LINKEDIN_IDENTITY_ROUTE_NOT_VERIFIED'));
});

test('verified founder route is accepted without claiming a corporate LinkedIn page',()=>{
  const r=brandIdentityReadiness({LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',LINKEDIN_OPERATOR_ASSISTED_PUBLISHING:'true'});
  assert.equal(r.fronts.linkedin.verified,true);
  assert.equal(r.fronts.linkedin.source,'verified_founder_profile');
});

test('brand identity becomes ready only with all provider visual proofs',()=>{
  const env={};
  for(const key of ['WHATSAPP','INSTAGRAM','FACEBOOK','TIKTOK','YOUTUBE','LINKEDIN','NUVEMSHOP','MERCADOLIVRE']) env[`${key}_BRAND_IDENTITY_VERIFIED`]='true';
  const r=brandIdentityReadiness(env);
  assert.equal(r.ready,true);
  assert.equal(r.verified_fronts,12);
  assert.deepEqual(r.blockers,[]);
});