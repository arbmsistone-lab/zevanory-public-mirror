import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokOAuthStart, exchangeTikTokCode, loadTikTokCredential, persistTikTokTokens, readTikTokOAuthCookie, refreshTikTokCredential, TIKTOK_REDIRECT_URI } from '../src/tiktokOAuth.mjs';

const env={TIKTOK_CLIENT_KEY:'client-key',TIKTOK_CLIENT_SECRET:'client-secret',TIKTOK_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64')};
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('TikTok OAuth start is state protected and requests only required scopes',()=>{
  const start=createTikTokOAuthStart(env);const u=new URL(start.url);
  assert.equal(u.origin,'https://www.tiktok.com');assert.equal(u.pathname,'/v2/auth/authorize/');
  assert.equal(u.searchParams.get('redirect_uri'),TIKTOK_REDIRECT_URI);
  assert.equal(u.searchParams.get('scope'),'user.info.basic,video.publish');
  assert.equal(u.searchParams.get('response_type'),'code');
  const state=u.searchParams.get('state');assert.ok(state);assert.doesNotThrow(()=>readTikTokOAuthCookie(start.cookie,state,env));
  assert.throws(()=>readTikTokOAuthCookie(start.cookie,'wrong-state',env),/tiktok_oauth_state_invalid/);
});

test('TikTok authorization code exchange is server-side and requires video.publish',async()=>{
  const calls=[];const token={access_token:'access',refresh_token:'refresh',open_id:'open-1',scope:'user.info.basic,video.publish',token_type:'Bearer',expires_in:86400};
  const out=await exchangeTikTokCode({code:'code-1',env,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(200,token);}});
  assert.equal(out.open_id,'open-1');assert.equal(calls[0].url,'https://open.tiktokapis.com/v2/oauth/token/');
  assert.match(String(calls[0].opt.body),/grant_type=authorization_code/);assert.equal(JSON.stringify(out).includes('client-secret'),false);
});
test('TikTok credentials are encrypted at rest and decrypted only server-side',async()=>{
  let stored;const sql={query:async(text,args)=>{
    if(text.startsWith('insert')){stored=args;return [{account_id:args[0],expires_at:new Date()}];}
    return [{account_id:'open-1',access_token_enc:stored[1],refresh_token_enc:stored[2],token_type:'Bearer',scope:'user.info.basic,video.publish',expires_at:new Date(Date.now()+3600000)}];
  }};
  await persistTikTokTokens(sql,{token:{access_token:'access-secret',refresh_token:'refresh-secret',open_id:'open-1',scope:'user.info.basic,video.publish',token_type:'Bearer',expires_in:3600},env});
  assert.notEqual(stored[1],'access-secret');assert.notEqual(stored[2],'refresh-secret');
  const loaded=await loadTikTokCredential(sql,env);assert.equal(loaded.access_token,'access-secret');assert.equal(loaded.refresh_token,'refresh-secret');
});

test('TikTok refresh rotates both tokens and persists the new pair',async()=>{
  let persisted;const sql={query:async(text,args)=>{
    if(text.startsWith('insert')){persisted=args;return [{account_id:args[0],expires_at:new Date()}];}
    return [{account_id:'open-1',access_token_enc:persisted[1],refresh_token_enc:persisted[2],token_type:'Bearer',scope:'user.info.basic,video.publish',expires_at:new Date(Date.now()+3600000)}];
  }};
  const initial={account_id:'open-1',access_token:'old-access',refresh_token:'old-refresh'};
  const out=await refreshTikTokCredential(sql,initial,{env,fetchImpl:async()=>response(200,{access_token:'new-access',refresh_token:'new-refresh',open_id:'open-1',scope:'user.info.basic,video.publish',token_type:'Bearer',expires_in:86400})});
  assert.equal(out.access_token,'new-access');assert.equal(out.refresh_token,'new-refresh');
});
