import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptCommercialSecret} from '../src/commercialOAuthCrypto.mjs';
import {resolveYouTubeAccessToken} from '../src/youtubeUpload.mjs';
import {persistedOAuthReadiness,overlayPersistedOAuth} from '../src/runtimeOAuthChannelReadiness.mjs';
const key=Buffer.alloc(32,9).toString('base64');

test('YouTube executor accepts valid persisted encrypted OAuth access token',async()=>{
  const env={COMMERCIAL_OAUTH_ENCRYPTION_KEY:key};
  const row={access_token_enc:encryptCommercialSecret('persisted-access',env),refresh_token_enc:encryptCommercialSecret('refresh',env),expires_at:new Date(Date.now()+3600000).toISOString()};
  const sql={query:async()=>[row]};
  const token=await resolveYouTubeAccessToken({env,sql,fetchImpl:async()=>{throw new Error('provider_should_not_be_called')}});
  assert.equal(token,'persisted-access');
});

test('persisted OAuth readiness requires provider-specific scopes and overlays API truth',async()=>{
  const sql={query:async()=>[
    {provider:'youtube_identity',scope:'https://www.googleapis.com/auth/youtube.force-ssl',has_access:true,has_refresh:true},
    {provider:'tiktok',scope:'user.info.basic',has_access:true,has_refresh:true},
    {provider:'nuvemshop',scope:'',has_access:true,has_refresh:false},
    {provider:'meta',scope:'pages_show_list pages_manage_posts instagram_content_publish',has_access:true,has_refresh:false},
  ]};
  const ready=await persistedOAuthReadiness(sql);
  assert.deepEqual(ready,{youtube:true,tiktok:false,nuvemshop:false,facebook:true,instagram:true});
  const out=overlayPersistedOAuth({youtube:{api_configured:false,operational_ready:true,operational_mode:'operator_assisted',provider:'youtube-data-api'}},ready);
  assert.equal(out.youtube.api_configured,true);
  assert.equal(out.youtube.operational_mode,'provider_api_oauth');
  assert.equal(out.youtube.oauth_persisted,true);
});

test('Nuvemshop provider evidence cannot activate a standby front',async()=>{
  const ready=await persistedOAuthReadiness({query:async()=>[{provider:'nuvemshop',scope:'read_products read_orders',has_access:true,integration_verified:true}]});
  assert.equal(ready.nuvemshop,false);
  const out=overlayPersistedOAuth({nuvemshop:{configured:false,operational_ready:false,operational_mode:'standby'}},ready).nuvemshop;assert.equal(out.operational_ready,false);assert.equal(out.operational_mode,'standby');
});
