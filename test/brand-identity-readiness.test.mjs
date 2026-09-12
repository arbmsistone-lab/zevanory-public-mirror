import test from 'node:test';
import assert from 'node:assert/strict';
import { brandIdentityReadiness, BRAND_IDENTITY_FRONTS } from '../src/brandIdentityReadiness.mjs';
import { EXCLUDED_COMMERCIAL_FRONTS } from '../src/activeCommercialScope.mjs';

test('brand identity gate covers the 9 active commercial fronts',()=>{
  assert.equal(BRAND_IDENTITY_FRONTS.length,9);
  assert.equal(BRAND_IDENTITY_FRONTS.includes('tiktok'),false);
  assert.equal(BRAND_IDENTITY_FRONTS.includes('linkedin'),false);
  assert.equal(BRAND_IDENTITY_FRONTS.includes('nuvemshop'),false);
  const r=brandIdentityReadiness({});
  assert.equal(r.total_fronts,9);
  assert.equal(r.ready,false);
  assert.equal(r.verified_fronts,4);
  assert.ok(r.blockers.includes('WHATSAPP_BRAND_IDENTITY_NOT_VERIFIED'));
});

test('TikTok LinkedIn and Nuvemshop are explicit backlog exclusions',()=>{
  assert.equal(EXCLUDED_COMMERCIAL_FRONTS.tiktok.state,'backlog_excluded');
  assert.equal(EXCLUDED_COMMERCIAL_FRONTS.linkedin.state,'backlog_excluded');
  assert.equal(EXCLUDED_COMMERCIAL_FRONTS.nuvemshop.state,'backlog_excluded');
});

test('brand identity becomes ready only with all active provider visual proofs',()=>{
  const env={};
  for(const key of ['WHATSAPP','INSTAGRAM','FACEBOOK','YOUTUBE','MERCADOLIVRE']) env[`${key}_BRAND_IDENTITY_VERIFIED`]='true';
  const r=brandIdentityReadiness(env);
  assert.equal(r.ready,true);
  assert.equal(r.verified_fronts,9);
  assert.deepEqual(r.blockers,[]);
});
