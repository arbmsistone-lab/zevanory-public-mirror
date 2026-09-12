import test from 'node:test';
import assert from 'node:assert/strict';
import {createMetaOAuthStart,readMetaOAuthCookie,exchangeMetaCode,fetchMetaPublishingIdentity,persistMetaCredential,loadMetaCredential,META_OAUTH_PUBLIC} from '../src/metaOAuth.mjs';

const env={META_APP_SECRET01:'0123456789abcdef0123456789abcdef'};
const response=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('Meta OAuth start is state-bound to canonical callback',()=>{
  const s=createMetaOAuthStart(env),u=new URL(s.url),state=u.searchParams.get('state');
  assert.equal(u.origin,'https://www.facebook.com');
  assert.equal(u.searchParams.get('client_id'),META_OAUTH_PUBLIC.app_id);
  assert.equal(u.searchParams.get('redirect_uri'),META_OAUTH_PUBLIC.redirect_uri);
  assert.ok(state);assert.equal(readMetaOAuthCookie(s.cookie,state,env).state,state);
});

test('Meta token exchange and identity require both publishing surfaces',async()=>{
  let n=0;const fetchImpl=async(url)=>{n++;const s=String(url);
    if(s.includes('/oauth/access_token'))return response(200,{access_token:n===1?'short':'long',expires_in:3600});
    if(s.includes('/me/permissions'))return response(200,{data:['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'].map(permission=>({permission,status:'granted'}))});
    if(s.includes('/me/accounts'))return response(200,{data:[{id:'p1',name:'Zevanory',access_token:'page-token',instagram_business_account:{id:'ig1',username:'zevanory_'}}]});
    throw new Error('unexpected_provider_call');};
  const token=await exchangeMetaCode({code:'code',env,fetchImpl});assert.equal(token.access_token,'long');
  const identity=await fetchMetaPublishingIdentity(token.access_token,fetchImpl);assert.equal(identity.page_id,'p1');assert.equal(identity.instagram_id,'ig1');
});
