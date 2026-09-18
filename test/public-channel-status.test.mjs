import test from 'node:test';
import assert from 'node:assert/strict';
import { publicChannelStatus, publicChannelReadinessSummary } from '../src/publicChannelStatus.mjs';

test('public channel status exposes 9 active plus 3 standby without secret inventory',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'secret-email',MERCADOPAGO_ACCESS_TOKEN:'secret-payment'});
  assert.equal(Object.keys(state).length,12);
  const standby=['tiktok','linkedin','nuvemshop'];
  assert.equal(Object.values(state).filter(x=>x.scope_status==='active').length,9);
  for(const c of standby){assert.equal(state[c].scope_status,'standby');assert.equal(state[c].configured,false);assert.equal(state[c].api_configured,false);assert.equal(state[c].operational_ready,false);}
  assert.equal(state.zevanory.configured,true);assert.equal(state.google.configured,true);assert.equal(state.email.configured,true);
  assert.equal(state.whatsapp.configured,false);
  assert.equal(state.instagram.profile_url,'https://www.instagram.com/zevanory_/');assert.equal(state.youtube.profile_url,'https://youtube.com/@zevanory');
  const serialized=JSON.stringify(state);assert.doesNotMatch(serialized,/secret-email|secret-payment|ACCESS_TOKEN|CLIENT_SECRET/i);
});

test('configured does not bypass commercial gates',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'re_test'});
  assert.equal(state.email.configured,true);assert.equal(state.email.api_configured,true);assert.equal(state.email.commercial,true);assert.equal(state.email.role,'crm_nurture');
});

test('summary explicitly preserves 9 active plus 3 standby',()=>{
  const summary=publicChannelReadinessSummary({});
  assert.equal(Object.keys(summary).length,12);
  assert.equal(Object.values(summary).filter(x=>x.scope_status==='active').length,9);
  for(const c of ['tiktok','linkedin','nuvemshop']){assert.equal(summary[c].scope_status,'standby');assert.equal(summary[c].operational_ready,false);assert.equal(summary[c].counts_toward_active_total,false);}
  const serialized=JSON.stringify(summary);assert.doesNotMatch(serialized,/ACCESS_TOKEN|CLIENT_SECRET|secret/i);
});
