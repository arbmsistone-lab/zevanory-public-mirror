import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteRuntimeChannelTruth,overlayRemoteChannelTruth} from '../src/remoteRuntimeTelemetry.mjs';

test('remote runtime promotes only proven Meta API readiness',async()=>{
  const body={channels:{facebook:{api_configured:true,operational_ready:true},instagram:{api_configured:true,operational_ready:true},tiktok:{api_configured:true,operational_ready:true}}};
  const remote=await remoteRuntimeChannelTruth({REMOTE_CHANNEL_STATUS_URL:'https://example.org/status'},async()=>({ok:true,json:async()=>body}));
  assert.deepEqual(Object.keys(remote).sort(),['facebook','instagram']);
  const base={facebook:{operational_ready:false,api_configured:false},instagram:{operational_ready:false,api_configured:false},youtube:{operational_ready:true,api_configured:true}};
  const out=overlayRemoteChannelTruth(base,remote);
  assert.equal(out.facebook.api_configured,true);assert.equal(out.facebook.automation_ready,true);assert.equal(out.facebook.operational_mode,'provider_api_secondary_runtime');
  assert.equal(out.instagram.api_configured,true);assert.equal(out.youtube.api_configured,true);
});

test('remote runtime fails closed on unproven or unavailable source',async()=>{
  const remote=await remoteRuntimeChannelTruth({REMOTE_CHANNEL_STATUS_URL:'https://example.org/status'},async()=>({ok:true,json:async()=>({channels:{facebook:{api_configured:true,operational_ready:false}}})}));
  assert.deepEqual(remote,{});
  assert.deepEqual(await remoteRuntimeChannelTruth({},async()=>{throw new Error('must not call')}),{});
});