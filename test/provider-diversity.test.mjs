import test from 'node:test';
import assert from 'node:assert/strict';
import { alternateAutomationReadiness } from '../src/alternateChannelAutomation.mjs';
import { publishViaBuffer } from '../src/bufferSocial.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { publicChannelStatus } from '../src/publicChannelStatus.mjs';

const gate=()=>({enabled:true});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
const env={BUFFER_API_KEY:'buf-key',BUFFER_FACEBOOK_CHANNEL_ID:'fb-1',BUFFER_INSTAGRAM_CHANNEL_ID:'ig-1',BUFFER_TIKTOK_CHANNEL_ID:'tt-1',BUFFER_YOUTUBE_CHANNEL_ID:'yt-1',BUFFER_LINKEDIN_CHANNEL_ID:'li-1'};

test('Buffer alternate automation is fail closed and channel specific',()=>{
  assert.equal(alternateAutomationReadiness('tiktok',{}).ready,false);
  assert.equal(alternateAutomationReadiness('linkedin',env).ready,true);
  assert.equal(alternateAutomationReadiness('youtube',env).ready,true);
  assert.equal(alternateAutomationReadiness('instagram',env).ready,true);
  assert.equal(alternateAutomationReadiness('facebook',env).ready,true);
});

test('Buffer publishes LinkedIn through official GraphQL endpoint',async()=>{
  const calls=[];
  const out=await publishViaBuffer({channel:'linkedin',event:{payload:{content:'ZEVANORY update'}},env,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response({data:{createPost:{post:{id:'post-1',status:'scheduled'}}}});}});
  assert.equal(out.provider,'buffer');assert.equal(out.provider_post_id,'post-1');assert.equal(calls[0].url,'https://api.buffer.com');
  const body=JSON.parse(calls[0].opt.body);assert.equal(body.variables.input.channelId,'li-1');assert.equal(body.variables.input.text,'ZEVANORY update');
});

test('Buffer TikTok path requires media and sends public video URL',async()=>{
  await assert.rejects(()=>publishViaBuffer({channel:'tiktok',event:{payload:{content:'x'}},env,fetchImpl:async()=>response({})}),/buffer_tiktok_media_required/);
  let sent;
  const out=await publishViaBuffer({channel:'tiktok',event:{payload:{content:'demo',media_url:'https://cdn.example/demo.mp4'}},env,fetchImpl:async(url,opt)=>{sent=JSON.parse(opt.body);return response({data:{createPost:{post:{id:'tt-post',status:'scheduled'}}}});}});
  assert.equal(out.provider_post_id,'tt-post');assert.equal(sent.variables.input.assets[0].video.url,'https://cdn.example/demo.mp4');
});

test('Buffer media-first networks fail before provider effect and Facebook accepts text',async()=>{
  await assert.rejects(()=>publishViaBuffer({channel:'instagram',event:{payload:{content:'x'}},env,fetchImpl:async()=>response({})}),/buffer_instagram_media_required/);
  await assert.rejects(()=>publishViaBuffer({channel:'youtube',event:{payload:{content:'x'}},env,fetchImpl:async()=>response({})}),/buffer_youtube_media_required/);
  const out=await publishViaBuffer({channel:'facebook',event:{payload:{content:'text-only'}},env,fetchImpl:async()=>response({data:{createPost:{post:{id:'fb-post',status:'scheduled'}}}})});
  assert.equal(out.provider_post_id,'fb-post');
});

test('outbound adapters use Buffer only when direct OAuth credential is absent',async()=>{
  const sql={query:async()=>[]};
  const fetchImpl=async()=>response({data:{createPost:{post:{id:'fallback-1',status:'scheduled'}}}});
  const adapters=buildOutboundAdapters({env,fetchImpl,commercialGate:gate});
  const li=await adapters['channel:linkedin']({payload:{content:'fallback linkedin'}},{sql});
  const tt=await adapters['channel:tiktok']({payload:{content:'fallback tiktok',media_url:'https://cdn.example/a.mp4'}},{sql});
  assert.equal(li.provider,'buffer');assert.equal(tt.provider,'buffer');
});

test('distribution and public status expose alternate API truth without claiming direct API',()=>{
  const distribution=commercialDistributionReadiness({...env,TIKTOK_PROFILE_VERIFIED:'true',TIKTOK_OPERATOR_ASSISTED_PUBLISHING:'true',TIKTOK_PROFILE_URL:'https://www.tiktok.com/@zevanory3',LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',LINKEDIN_OPERATOR_ASSISTED_PUBLISHING:'true',LINKEDIN_FOUNDER_PROFILE_URL:'https://www.linkedin.com/in/example/',NUVEMSHOP_STOREFRONT_VERIFIED:'true',NUVEMSHOP_STOREFRONT_URL:'https://zevanory.lojavirtualnuvem.com.br/',AFFILIATE_PROVIDER:'first_party'});
  assert.equal(distribution.fronts.tiktok.alternate_api_ready,true);assert.equal(distribution.fronts.tiktok.operational_mode,'buffer_api');
  const publicState=publicChannelStatus(env);assert.equal(publicState.linkedin.api_configured,false);assert.equal(publicState.linkedin.alternate_api_configured,true);assert.equal(publicState.linkedin.active_provider,'buffer');
});
