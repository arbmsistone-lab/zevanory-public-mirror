import test from 'node:test';
import assert from 'node:assert/strict';
import { brandIdentityReadiness, BRAND_IDENTITY_FRONTS } from '../src/brandIdentityReadiness.mjs';
import { EXCLUDED_COMMERCIAL_FRONTS } from '../src/activeCommercialScope.mjs';

test('brand identity gate covers all 12 active fronts',()=>{
  assert.equal(BRAND_IDENTITY_FRONTS.length,12);
  for(const name of ['tiktok','linkedin','nuvemshop']) assert.equal(BRAND_IDENTITY_FRONTS.includes(name),true);
  assert.deepEqual(EXCLUDED_COMMERCIAL_FRONTS,{});
  const r=brandIdentityReadiness({});
  assert.equal(r.total_fronts,12);assert.equal(r.ready,false);assert.equal(r.verified_fronts,4);
});

test('brand identity accepts verified assisted identities without claiming provider API',()=>{
  const env={TIKTOK_PROFILE_VERIFIED:'true',LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',NUVEMSHOP_STOREFRONT_VERIFIED:'true'};
  const r=brandIdentityReadiness(env);
  assert.equal(r.fronts.tiktok.verified,true);assert.equal(r.fronts.linkedin.verified,true);assert.equal(r.fronts.nuvemshop.verified,true);
});

test('brand identity becomes ready only with all provider or assisted identity proofs',()=>{
  const env={TIKTOK_PROFILE_VERIFIED:'true',LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',NUVEMSHOP_STOREFRONT_VERIFIED:'true'};
  for(const key of ['WHATSAPP','INSTAGRAM','FACEBOOK','YOUTUBE','MERCADOLIVRE']) env[`${key}_BRAND_IDENTITY_VERIFIED`]='true';
  const r=brandIdentityReadiness(env);assert.equal(r.ready,true);assert.equal(r.verified_fronts,12);assert.deepEqual(r.blockers,[]);
});