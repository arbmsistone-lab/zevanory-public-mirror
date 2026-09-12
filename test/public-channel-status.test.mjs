import test from 'node:test';
import assert from 'node:assert/strict';
import { publicChannelStatus, publicChannelReadinessSummary } from '../src/publicChannelStatus.mjs';

test('public channel status exposes active readiness without secret inventory',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'secret-email',MERCADOPAGO_ACCESS_TOKEN:'secret-payment'});
  assert.equal(Object.keys(state).length,9);
  assert.equal(state.tiktok,undefined); assert.equal(state.linkedin,undefined); assert.equal(state.nuvemshop,undefined);
  assert.equal(state.zevanory.configured,true); assert.equal(state.google.configured,true); assert.equal(state.email.configured,true);
  assert.equal(state.whatsapp.configured,false);
  assert.equal(state.instagram.profile_url,'https://www.instagram.com/zevanory_/'); assert.equal(state.youtube.profile_url,'https://youtube.com/@zevanory');
  const serialized=JSON.stringify(state); assert.doesNotMatch(serialized,/secret-email|secret-payment|ACCESS_TOKEN|missing/i);
});

test('configured does not bypass commercial gates',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'re_test'});
  assert.equal(state.email.configured,true); assert.equal(state.email.api_configured,true); assert.equal(state.email.commercial,true); assert.equal(state.email.role,'crm_nurture');
});

test('summary omits excluded fronts and exposes no secret material',()=>{
  const summary=publicChannelReadinessSummary({});
  assert.equal(summary.tiktok,undefined); assert.equal(summary.linkedin,undefined); assert.equal(summary.nuvemshop,undefined);
  assert.equal(Object.keys(summary).length,9);
  const serialized=JSON.stringify(summary); assert.doesNotMatch(serialized,/ACCESS_TOKEN|CLIENT_SECRET|secret/i);
});