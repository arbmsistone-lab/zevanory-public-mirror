import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteRuntimeChannelTruth,overlayRemoteChannelTruth} from '../src/remoteRuntimeTelemetry.mjs';

test('remote runtime promotes only proven Facebook Instagram and YouTube API readiness',async()=>{
  const body={channels:{facebook:{api_configured:true,operational_ready:true},instagram:{api_configured:true,operational_ready:true},youtube:{api_configured:true,operational_ready:true},tiktok:{api_configured:true,operational_ready:true}}};
  const remote=await remoteRuntimeChannelTruth({REMOTE_CHANNEL_STATUS_URL:'https://example.org/status'},async()=>({ok:true,json:async()=>body}));
  assert.deepEqual(Object.keys(remote).sort(),['facebook','instagram','youtube']);
  const base={facebook:{operational_ready:false,api_configured:false},instagram:{operational_ready:false,api_configured:false},youtube:{operational_ready:false,api_configured:false},tiktok:{operational_ready:false,api_configured:false}};
  const out=overlayRemoteChannelTruth(base,remote);
  assert.equal(out.facebook.automation_ready,true);assert.equal(out.instagram.automation_ready,true);assert.equal(out.youtube.automation_ready,true);assert.equal(out.youtube.operational_mode,'provider_api_secondary_runtime');assert.equal(out.tiktok.api_configured,false);
});

test('remote runtime fails closed on unproven or unavailable source',async()=>{
  const remote=await remoteRuntimeChannelTruth({REMOTE_CHANNEL_STATUS_URL:'https://example.org/status'},async()=>({ok:true,json:async()=>({channels:{facebook:{api_configured:true,operational_ready:false}}})}));
  assert.deepEqual(remote,{});
  assert.deepEqual(await remoteRuntimeChannelTruth({},async()=>{throw new Error('must not call')}),{});
});
