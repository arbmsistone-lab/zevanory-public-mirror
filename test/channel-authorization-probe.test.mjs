import test from 'node:test';
import assert from 'node:assert/strict';
import { probeChannelAuthorizations } from '../src/channelAuthorizationProbe.mjs';
import { encryptTikTokSecret } from '../src/tiktokOAuth.mjs';
import { encryptCommercialSecret } from '../src/commercialOAuthCrypto.mjs';
import { publishLinkedIn } from '../src/socialPosting.mjs';

const key=Buffer.alloc(32,17).toString('base64');
const env={TIKTOK_TOKEN_ENCRYPTION_KEY:key,COMMERCIAL_OAUTH_ENCRYPTION_KEY:key,TIKTOK_EXPECTED_USERNAME:'zevanory',LINKEDIN_CLIENT_ID:'fixture-client',LINKEDIN_CLIENT_SECRET:'fixture-secret',LINKEDIN_EXPECTED_AUTHOR_URN:'urn:li:person:1',NUVEMSHOP_STOREFRONT_URL:'https://zevanory.lojavirtualnuvem.com.br'};
const response=body=>({status:200,json:async()=>body});

test('configuration and sandbox cannot become authorization proof',async()=>{
  let calls=0;
  const proof=await probeChannelAuthorizations({query:async()=>[]},{env,fetchImpl:async()=>{calls++;throw new Error('unexpected');}});
  assert.equal(calls,0);
  for(const row of Object.values(proof.fronts)){assert.equal(row.authorization_ready,false);assert.equal(row.automation_proven,false);}
});

test('database outage fails closed without disclosing provider errors or attempting publication',async()=>{
  const proof=await probeChannelAuthorizations({query:async()=>{throw new Error('private database connection details');}},{env,fetchImpl:async()=>{throw new Error('unexpected');}});
  assert.doesNotMatch(JSON.stringify(proof),/postgres|secret@/);
  for(const row of Object.values(proof.fronts))assert.deepEqual(row.blockers,['authorization_probe_unavailable','real_execution_not_proven']);
});

test('live read-only authorization still cannot certify real execution',async()=>{
  const calls=[];
  const sql={query:async q=>q.includes("provider='tiktok'")?[{account_id:'tt',access_token_enc:encryptTikTokSecret('tt-token',env),refresh_token_enc:encryptTikTokSecret('tt-refresh',env),scope:'video.publish',expires_at:new Date(Date.now()+3600000)}]:q.includes("provider='linkedin'")?[{account_id:'1',access_token_enc:encryptCommercialSecret('li-token',env),scope:'w_member_social',expires_at:new Date(Date.now()+3600000)}]:[{account_id:'123',access_token_enc:encryptCommercialSecret('ns-token',env),scope:'write_products',expires_at:null}]};
  const fetchImpl=async(url,options)=>{
    calls.push(url);assert.ok(options.signal instanceof AbortSignal);assert.equal(options.redirect,'error');
    if(url.includes('creator_info'))return response({error:{code:'ok'},data:{creator_username:'zevanory',privacy_level_options:['SELF_ONLY']}});
    if(url.includes('introspectToken'))return response({active:true,client_id:'fixture-client',expires_at:Math.floor(Date.now()/1000)+3600,scope:'w_member_social'});
    if(url.includes('userinfo'))return response({sub:'1'});
    if(url.endsWith('/store'))return response({id:123,domains:['zevanory.lojavirtualnuvem.com.br']});
    if(url.includes('/products?'))return response([]);
    if(url.includes('/webhooks?'))return response([]);
    throw new Error('unexpected_endpoint');
  };
  const proof=await probeChannelAuthorizations(sql,{env,fetchImpl});
  for(const row of Object.values(proof.fronts)){assert.equal(row.authorization_ready,true);assert.equal(row.identity_ready,true);assert.equal(row.capability_ready,true);assert.equal(row.automation_proven,false);}
  assert.equal(calls.length,6);assert.doesNotMatch(JSON.stringify(proof),/tt-token|li-token|ns-token|fixture-secret/);
});

test('LinkedIn successful HTTP without ID stops rerouting',async()=>{
  await assert.rejects(publishLinkedIn({event:{payload:{content:'test'}},accessToken:'test-only',authorUrn:'urn:li:person:1',env:{LINKEDIN_VERSION:'202608'},fetchImpl:async()=>({status:201,headers:new Headers()})}),error=>error.ambiguous===true&&error.retryable===false);
});

test('LinkedIn outage after POST stops rerouting without leaking errors',async()=>{
  await assert.rejects(publishLinkedIn({event:{payload:{content:'test'}},accessToken:'test-only',authorUrn:'urn:li:person:1',env:{LINKEDIN_VERSION:'202608'},fetchImpl:async()=>{throw new Error('secret-token');}}),error=>error.ambiguous===true&&error.message==='social_publication_uncertain');
});
