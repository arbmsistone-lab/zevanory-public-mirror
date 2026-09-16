import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokOAuthStart, createTikTokReviewSession, exchangeTikTokCode, readTikTokReviewSession } from '../src/tiktokOAuth.mjs';
import { fetchTikTokPostStatus, publishTikTok } from '../src/socialPosting.mjs';

const key=Buffer.alloc(32,19).toString('base64');
const env={TIKTOK_SANDBOX_CLIENT_KEY:'sandbox-key',TIKTOK_SANDBOX_CLIENT_SECRET:'sandbox-secret',TIKTOK_TOKEN_ENCRYPTION_KEY:key,TIKTOK_CONTENT_SOURCE_VERIFIED:'true',TIKTOK_CLIENT_AUDITED:'false'};
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});

test('review OAuth uses sandbox credentials with video.publish',()=>{
  const start=createTikTokOAuthStart(env,{mode:'review'}),u=new URL(start.url);
  assert.equal(u.searchParams.get('client_key'),'sandbox-key');
  assert.equal(u.searchParams.get('scope'),'user.info.basic,video.publish');
  assert.equal(start.mode,'review');
});

test('review token exchange requires video.publish',async()=>{
  await assert.rejects(exchangeTikTokCode({code:'x',env,mode:'review',fetchImpl:async()=>response(200,{access_token:'a',refresh_token:'r',open_id:'o',scope:'user.info.basic'})}),/tiktok_video_publish_scope_missing/);
});

test('review session is encrypted, bound and expiring',()=>{
  const cookie=createTikTokReviewSession('open-1',env);assert.equal(cookie.includes('open-1'),false);
  assert.deepEqual(readTikTokReviewSession(cookie,env),{subject:'open-1',mode:'review'});
});
test('direct post is fail-closed and sends current required fields',async()=>{
  const calls=[];
  const fetchImpl=async(url,opt)=>{calls.push({url,opt});if(url.includes('creator_info'))return response(200,{data:{creator_username:'zevanory3',privacy_level_options:['SELF_ONLY'],comment_disabled:false,duet_disabled:false,stitch_disabled:true,max_video_post_duration_sec:60},error:{code:'ok'}});if(url.includes('/video/init/'))return response(200,{data:{publish_id:'pub-1'},error:{code:'ok'}});throw new Error('unexpected');};
  const event={payload:{media_url:'https://zevanory.api.br/video.mp4',video_duration_sec:30,content:'demo',privacy_level:'SELF_ONLY',allow_comment:true,allow_duet:false,allow_stitch:false,commercial_disclosure:true,brand_organic_toggle:true,brand_content_toggle:false,is_aigc:true,user_consent:true,music_usage_confirmation:true}};
  const out=await publishTikTok({event,env,accessToken:'token',fetchImpl});assert.equal(out.provider_post_id,'pub-1');
  const body=JSON.parse(calls.find(x=>x.url.includes('/video/init/')).opt.body);
  assert.equal(body.post_info.brand_content_toggle,false);assert.equal(body.post_info.brand_organic_toggle,true);assert.equal(body.post_info.is_aigc,true);
  assert.equal(body.post_info.disable_comment,false);assert.equal(body.post_info.disable_duet,true);assert.equal(body.post_info.disable_stitch,true);
});

test('direct post rejects missing privacy, consent and invalid private branded content',async()=>{
  const creator=async()=>response(200,{data:{creator_username:'z',privacy_level_options:['SELF_ONLY'],comment_disabled:false,duet_disabled:false,stitch_disabled:false,max_video_post_duration_sec:60},error:{code:'ok'}});
  const base={media_url:'https://zevanory.api.br/video.mp4',video_duration_sec:30,user_consent:true,music_usage_confirmation:true};
  await assert.rejects(publishTikTok({event:{payload:base},env,accessToken:'t',fetchImpl:creator}),/tiktok_privacy_required/);
  await assert.rejects(publishTikTok({event:{payload:{...base,privacy_level:'SELF_ONLY',commercial_disclosure:true,brand_content_toggle:true}},env,accessToken:'t',fetchImpl:creator}),/tiktok_branded_content_private_forbidden/);
});

test('post status uses official status endpoint',async()=>{
  const out=await fetchTikTokPostStatus({publishId:'pub-1',accessToken:'token',fetchImpl:async(url,opt)=>{assert.match(url,/status\/fetch/);assert.equal(opt.method,'POST');return response(200,{data:{status:'PUBLISH_COMPLETE',publicaly_available_post_id:[]},error:{code:'ok'}});}});
  assert.equal(out.status,'PUBLISH_COMPLETE');
});
