import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptSecret,loadMercadoLivreCredential,refreshMercadoLivreCredential} from '../src/mercadoLivreOAuth.mjs';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';

const key=Buffer.alloc(32,7).toString('base64');
const env={MERCADOLIVRE_TOKEN_ENCRYPTION_KEY:key,MERCADOLIVRE_APP_ID:'123456',MERCADOLIVRE_CLIENT_SECRET:'secret'};
const certifiedGate=()=>({enabled:true});
const response=(status,body)=>({status,json:async()=>body});

test('loads and decrypts Mercado Livre OAuth credential from database',async()=>{
  const sql={query:async()=>[{account_id:'999',access_token_enc:encryptSecret('access',env),refresh_token_enc:encryptSecret('refresh',env),token_type:'Bearer',scope:'read write',expires_at:new Date(Date.now()+3600000)}]};
  const c=await loadMercadoLivreCredential(sql,env);
  assert.equal(c.account_id,'999');assert.equal(c.access_token,'access');assert.equal(c.refresh_token,'refresh');
});

test('commercial adapter uses database OAuth token instead of static env token',async()=>{
  const calls=[];
  const sql={query:async()=>[{account_id:'999',access_token_enc:encryptSecret('db-access',env),refresh_token_enc:encryptSecret('db-refresh',env),token_type:'Bearer',scope:'write',expires_at:new Date(Date.now()+3600000)}]};
  const adapters=buildOutboundAdapters({env:{...env,SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'},commercialGate:certifiedGate,fetchImpl:async(url,options)=>{calls.push({url,options});return response(201,{id:'MLB123'});}});
  const result=await adapters['channel:mercado_livre']({payload:{item:{title:'Teste'}}},{sql});
  assert.equal(result.provider_item_id,'MLB123');assert.equal(result.seller_id,'999');assert.equal(calls[0].options.headers.authorization,'Bearer db-access');
});