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

test('Buffer alternate automation remains technically channel specific',()=>{
  assert.equal(alternateAutomationReadiness('tiktok',{}).ready,false);
  assert.equal(alternateAutomationReadiness('linkedin',env).ready,true);
  assert.equal(alternateAutomationReadiness('youtube',env).ready,true);
  assert.equal(alternateAutomationReadiness('instagram',env).ready,true);
  assert.equal(alternateAutomationReadiness('facebook',env).ready,true);
});

test('Buffer LinkedIn helper remains available only as backlog code',async()=>{
  const calls=[];
  const out=await publishViaBuffer({channel:'linkedin',event:{payload:{content:'ZEVANORY update'}},env,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response({data:{createPost:{post:{id:'post-1',status:'scheduled'}}}});}});
  assert.equal(out.provider,'buffer');assert.equal(out.provider_post_id,'post-1');assert.equal(calls[0].url,'https://api.buffer.com');
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

test('TikTok and LinkedIn active alternates remain uncertainty-safe',async()=>{
  const adapters=buildOutboundAdapters({env,fetchImpl:async()=>response({}),commercialGate:gate});
  await assert.rejects(()=>adapters['channel:tiktok']({payload:{content:'x',media_url:'https://cdn.example/a.mp4'}},{sql:{query:async()=>[]}}),/provider_effect_uncertain/);
  await assert.rejects(()=>adapters['channel:linkedin']({payload:{content:'x'}},{sql:{query:async()=>[]}}),/provider_effect_uncertain/);
});

test('distribution includes TikTok LinkedIn and Nuvemshop as active non-sales fronts',()=>{
  const distribution=commercialDistributionReadiness(env);
  for(const c of ['tiktok','linkedin','nuvemshop'])assert.ok(distribution.fronts[c]);
  const publicState=publicChannelStatus(env); for(const c of ['tiktok','linkedin','nuvemshop'])assert.ok(publicState[c]);
});
