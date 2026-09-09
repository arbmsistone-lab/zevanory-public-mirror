import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveYouTubeAccessToken,inspectRemoteVideo,materializeRemoteVideo,createYouTubeUploadSession,queryYouTubeUploadProgress,uploadYouTubeFromRemote} from '../src/youtubeUpload.mjs';
import {channelReadiness} from '../src/channelAdapters.mjs';

const response=(status,{body={},headers={}}={})=>({status,ok:status>=200&&status<300,headers:new Headers(headers),json:async()=>body,arrayBuffer:async()=>Buffer.from(body)});

test('YouTube readiness accepts access token or complete refresh credentials only',()=>{
  assert.equal(channelReadiness({YOUTUBE_OAUTH_ACCESS_TOKEN:'a',YOUTUBE_IDENTITY_VERIFIED:'true'}).youtube.configured,true);
  assert.equal(channelReadiness({YOUTUBE_OAUTH_CLIENT_ID:'i',YOUTUBE_OAUTH_CLIENT_SECRET:'s',YOUTUBE_OAUTH_REFRESH_TOKEN:'r',YOUTUBE_IDENTITY_VERIFIED:'true'}).youtube.configured,true);
  assert.equal(channelReadiness({YOUTUBE_OAUTH_CLIENT_ID:'i'}).youtube.configured,false);
  assert.equal(channelReadiness({YOUTUBE_API_KEY:'key'}).youtube.configured,false);
});

test('OAuth refresh remains server side and returns access token',async()=>{
  const calls=[];const token=await resolveYouTubeAccessToken({env:{YOUTUBE_OAUTH_CLIENT_ID:'id',YOUTUBE_OAUTH_CLIENT_SECRET:'secret',YOUTUBE_OAUTH_REFRESH_TOKEN:'refresh'},fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(200,{body:{access_token:'access'}});}});
  assert.equal(token,'access');assert.match(calls[0].url,/oauth2\.googleapis\.com\/token/);assert.match(String(calls[0].opt.body),/grant_type=refresh_token/);
});

test('remote media probe requires HTTPS length and video MIME',async()=>{
  const video=await inspectRemoteVideo({url:'https://cdn.example.com/video.mp4',fetchImpl:async()=>response(200,{headers:{'content-length':'5','content-type':'video/mp4'}})});
  assert.deepEqual(video,{url:'https://cdn.example.com/video.mp4',size:5,mime:'video/mp4'});
  await assert.rejects(()=>inspectRemoteVideo({url:'http://cdn.example.com/video.mp4',fetchImpl:async()=>response(200)}),/youtube_media_url_required/);
});
test('resumable session is private by default and returns Google Location',async()=>{
  const video={url:'https://cdn.example.com/v.mp4',size:5,mime:'video/mp4'};let sent;
  const session=await createYouTubeUploadSession({accessToken:'access',video,title:'Demo ZEVANORY',fetchImpl:async(url,opt)=>{sent=JSON.parse(opt.body);return response(200,{headers:{location:'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc'}});}});
  assert.equal(session.privacy_status,'private');assert.equal(sent.status.privacyStatus,'private');assert.match(session.session_url,/upload_id=abc/);
});

test('upload resumes from provider range and completes without proxying inbound media',async()=>{
  const calls=[];const sql={query:async(q,args)=>{calls.push({q,args});return [];}};
  const fetchImpl=async(url,opt={})=>{
    if(opt.method==='HEAD')return response(200,{headers:{'content-length':'5','content-type':'video/mp4'}});
    if(String(url).includes('uploadType=resumable'))return response(200,{headers:{location:'https://upload.example/session'}});
    if(url==='https://cdn.example.com/v.mp4')return response(200,{body:'12345',headers:{'content-type':'video/mp4','content-length':'5'}});
    if(url==='https://upload.example/session'&&opt.method==='PUT')return response(201,{body:{id:'yt_video_1'}});
    throw new Error(`unexpected:${url}`);
  };
  const result=await uploadYouTubeFromRemote({event:{event_id:'e1',headers:{},payload:{media_url:'https://cdn.example.com/v.mp4',title:'Demo',content:'Descrição'}},sql,env:{YOUTUBE_OAUTH_ACCESS_TOKEN:'access'},fetchImpl});
  assert.equal(result.provider_media_id,'yt_video_1');assert.equal(result.privacy_status,'private');assert.ok(calls.some(x=>String(x.args?.[1]||'').includes('youtube_upload')));
});


test('multi-chunk upload materializes source once and slices the same bytes',async()=>{
  const body=Buffer.alloc(5*1024*1024,7);let sourceGets=0,uploads=0;
  const fetchImpl=async(url,opt={})=>{
    if(String(url).includes('uploadType=resumable'))return response(200,{headers:{location:'https://upload.example/session'}});
    if(url==='https://cdn.example.com/big.webm'){sourceGets+=1;return response(200,{body,headers:{'content-type':'video/webm','content-length':String(body.length)}});}
    if(url==='https://upload.example/session'&&opt.method==='PUT'){uploads+=1;if(uploads===1)return response(308,{headers:{range:`bytes=0-${4*1024*1024-1}`}});return response(201,{body:{id:'yt_video_big'}});}
    throw new Error(`unexpected:${url}`);
  };
  const result=await uploadYouTubeFromRemote({event:{event_id:'e-big',headers:{},payload:{media_url:'https://cdn.example.com/big.webm',title:'Demo'}},env:{YOUTUBE_OAUTH_ACCESS_TOKEN:'access'},fetchImpl});
  assert.equal(result.provider_media_id,'yt_video_big');assert.equal(sourceGets,1);assert.equal(uploads,2);
});

test('materialized source is fingerprinted and bounded',async()=>{
  const media=await materializeRemoteVideo({url:'https://cdn.example.com/v.mp4',fetchImpl:async()=>response(200,{body:'12345',headers:{'content-type':'video/mp4','content-length':'5'}})});
  assert.equal(media.size,5);assert.equal(media.mime,'video/mp4');assert.equal(media.bytes.toString(),'12345');assert.match(media.sha256,/^[0-9a-f]{64}$/);
});

test('resume fails closed when remote video bytes change',async()=>{
  const original=await materializeRemoteVideo({url:'https://cdn.example.com/v.mp4',fetchImpl:async()=>response(200,{body:'12345',headers:{'content-type':'video/mp4','content-length':'5'}})});
  const event={event_id:'e2',headers:{youtube_upload:{session_url:'https://upload.example/session',uploaded_bytes:0,total_bytes:5,mime:'video/mp4',media_url:'https://cdn.example.com/v.mp4',privacy_status:'private',title:'Demo',source_sha256:original.sha256}},payload:{}};
  const fetchImpl=async(url,opt={})=>{if(url==='https://upload.example/session'&&opt.method==='PUT')return response(308);if(url==='https://cdn.example.com/v.mp4')return response(200,{body:'54321',headers:{'content-type':'video/mp4','content-length':'5'}});throw new Error(`unexpected:${url}`);};
  await assert.rejects(()=>uploadYouTubeFromRemote({event,env:{YOUTUBE_OAUTH_ACCESS_TOKEN:'access'},fetchImpl}),/youtube_media_changed_manual_reconcile/);
});

test('progress query follows 308 Range rather than guessing transferred bytes',async()=>{
  const p=await queryYouTubeUploadProgress({sessionUrl:'https://upload.example/session',totalBytes:900,accessToken:'a',fetchImpl:async()=>response(308,{headers:{range:'bytes=0-511'}})});
  assert.equal(p.complete,false);assert.equal(p.uploaded_bytes,512);
});

test('remote media probe falls back to GET when HEAD is rejected',async()=>{
  const calls=[];const video=await inspectRemoteVideo({url:'https://zevanory.api.br/creative.webm',fetchImpl:async(url,opt={})=>{calls.push(opt.method||'GET');if(opt.method==='HEAD')return response(405);return response(200,{body:'12345',headers:{'content-type':'video/webm'}});}});
  assert.equal(video.size,5);assert.equal(video.mime,'video/webm');assert.deepEqual(calls,['HEAD','GET']);
});
