import test from 'node:test';
import assert from 'node:assert/strict';
import { createTikTokOAuthStart, exchangeTikTokCode, loadTikTokCredential, persistTikTokTokens, readTikTokOAuthCookie, refreshTikTokCredential, TIKTOK_REDIRECT_URI } from '../src/tiktokOAuth.mjs';
import oauthTikTokHandler from '../src/http/oauthTikTok.mjs';

const env={TIKTOK_CLIENT_KEY:'client-key',TIKTOK_CLIENT_SECRET:'client-secret',TIKTOK_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64')};
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('TikTok production OAuth requests publishing scope and protects state',()=>{
  const start=createTikTokOAuthStart(env);const u=new URL(start.url);
  assert.equal(u.origin,'https://www.tiktok.com');assert.equal(u.pathname,'/v2/auth/authorize/');
  assert.equal(u.searchParams.get('redirect_uri'),TIKTOK_REDIRECT_URI);
  assert.equal(u.searchParams.get('scope'),'user.info.basic,video.publish');
  assert.equal(u.searchParams.get('response_type'),'code');
  const state=u.searchParams.get('state');assert.ok(state);assert.doesNotThrow(()=>readTikTokOAuthCookie(start.cookie,state,env));
  assert.throws(()=>readTikTokOAuthCookie(start.cookie,'wrong-state',env),/tiktok_oauth_state_invalid/);
});

test('TikTok production code exchange requires video.publish',async()=>{
  const calls=[];const token={access_token:'access',refresh_token:'refresh',open_id:'open-1',scope:'user.info.basic,video.publish',token_type:'Bearer',expires_in:86400};
  const out=await exchangeTikTokCode({code:'code-1',env,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(200,token);}});
  assert.equal(out.open_id,'open-1');assert.equal(calls[0].url,'https://open.tiktokapis.com/v2/oauth/token/');
  assert.match(String(calls[0].opt.body),/grant_type=authorization_code/);assert.equal(JSON.stringify(out).includes('client-secret'),false);
});

test('TikTok credentials are encrypted at rest and decrypted only server-side',async()=>{
  let stored;const sql={query:async(text,args)=>{
    if(text.startsWith('insert')){stored=args;return [{account_id:args[0],expires_at:new Date()}];}
    return [{account_id:'open-1',access_token_enc:stored[1],refresh_token_enc:stored[2],token_type:'Bearer',scope:'user.info.basic,video.publish',expires_at:new Date(Date.now()+3600000)}];
  }};  await persistTikTokTokens(sql,{token:{access_token:'access-secret',refresh_token:'refresh-secret',open_id:'open-1',scope:'user.info.basic,video.publish',token_type:'Bearer',expires_in:3600},env});
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

test('TikTok sandbox OAuth is isolated and requests Login Kit scope only',()=>{
  const sandboxEnv={...env,TIKTOK_SANDBOX_CLIENT_KEY:'sandbox-key',TIKTOK_SANDBOX_CLIENT_SECRET:'sandbox-secret'};
  const start=createTikTokOAuthStart(sandboxEnv,{mode:'sandbox'});const u=new URL(start.url);
  assert.equal(u.searchParams.get('client_key'),'sandbox-key');assert.equal(u.searchParams.get('scope'),'user.info.basic');assert.equal(start.mode,'sandbox');
  const parsed=readTikTokOAuthCookie(start.cookie,u.searchParams.get('state'),sandboxEnv);assert.equal(parsed.mode,'sandbox');
});

test('TikTok sandbox token exchange does not require video.publish',async()=>{
  const sandboxEnv={...env,TIKTOK_SANDBOX_CLIENT_KEY:'sandbox-key',TIKTOK_SANDBOX_CLIENT_SECRET:'sandbox-secret'};
  const token={access_token:'sandbox-access',refresh_token:'sandbox-refresh',open_id:'sandbox-open',scope:'user.info.basic',token_type:'Bearer',expires_in:86400};
  const out=await exchangeTikTokCode({code:'code-1',env:sandboxEnv,mode:'sandbox',fetchImpl:async()=>response(200,token)});assert.equal(out.scope,'user.info.basic');
});

test('TikTok sandbox tokens persist under isolated provider and do not overwrite production row',async()=>{
  const queries=[];const sql={query:async(text,args)=>{queries.push({text,args});return [{account_id:'sandbox-open',expires_at:new Date()}];}};
  await persistTikTokTokens(sql,{token:{access_token:'sandbox-access',refresh_token:'sandbox-refresh',open_id:'sandbox-open',scope:'user.info.basic',token_type:'Bearer',expires_in:3600},env,mode:'sandbox'});
  assert.match(queries[0].text,/values\('tiktok_sandbox'/);assert.doesNotMatch(queries[0].text,/values\('tiktok',/);
});

test('TikTok canonical OAuth start defaults to production publishing scope',async()=>{
  const old={key:process.env.TIKTOK_CLIENT_KEY,secret:process.env.TIKTOK_CLIENT_SECRET,enc:process.env.TIKTOK_TOKEN_ENCRYPTION_KEY,skey:process.env.TIKTOK_SANDBOX_CLIENT_KEY,ssecret:process.env.TIKTOK_SANDBOX_CLIENT_SECRET};
  Object.assign(process.env,{TIKTOK_CLIENT_KEY:'client-key',TIKTOK_CLIENT_SECRET:'client-secret',TIKTOK_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),TIKTOK_SANDBOX_CLIENT_KEY:'sandbox-key',TIKTOK_SANDBOX_CLIENT_SECRET:'sandbox-secret'});
  const req={method:'GET',url:'/api/oauth/tiktok/start?action=start',query:{action:'start'},headers:{}}; const headers={}; const res={statusCode:0,setHeader:(k,v)=>{headers[String(k).toLowerCase()]=v;},end:()=>{}};
  try{await oauthTikTokHandler(req,res);assert.equal(res.statusCode,302);const u=new URL(headers.location);assert.equal(u.searchParams.get('client_key'),'client-key');assert.equal(u.searchParams.get('scope'),'user.info.basic,video.publish');}
  finally{for(const [k,v] of Object.entries({TIKTOK_CLIENT_KEY:old.key,TIKTOK_CLIENT_SECRET:old.secret,TIKTOK_TOKEN_ENCRYPTION_KEY:old.enc,TIKTOK_SANDBOX_CLIENT_KEY:old.skey,TIKTOK_SANDBOX_CLIENT_SECRET:old.ssecret})){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});