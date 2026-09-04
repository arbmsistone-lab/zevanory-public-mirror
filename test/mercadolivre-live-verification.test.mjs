import test from 'node:test';
import assert from 'node:assert/strict';
import { mercadoPagoClientIdFromAccessToken, verifyMercadoLivreLive } from '../src/mercadoLivreVerification.mjs';
import { encryptSecret } from '../src/mercadoLivreOAuth.mjs';
const key=Buffer.alloc(32,7).toString('base64');
const env={MERCADOLIVRE_APP_ID:'123',MERCADOLIVRE_TOKEN_ENCRYPTION_KEY:key,MERCADOPAGO_ACCESS_TOKEN:'APP_USR-999-010101-abc'};
test('extracts Mercado Pago client id without exposing token',()=>{assert.equal(mercadoPagoClientIdFromAccessToken(env.MERCADOPAGO_ACCESS_TOKEN),'999');assert.equal(mercadoPagoClientIdFromAccessToken('bad'),'');});
test('live verification requires seller app callback and distinct Mercado Pago app',async()=>{
  const sql={query:async()=>[{account_id:'456',access_token_enc:encryptSecret('ml-token',env),refresh_token_enc:encryptSecret('refresh',env),token_type:'Bearer',scope:'read',expires_at:new Date(Date.now()+3600000)}]};
  const fetchImpl=async(url)=>String(url).includes('/users/me')?{ok:true,status:200,json:async()=>({id:456})}:{ok:true,status:200,json:async()=>({id:123,notification_url:'https://zevanory.api.br/api/webhooks/mercadolivre'})};
  const r=await verifyMercadoLivreLive(sql,{env,fetchImpl}); assert.equal(r.all_verified,true); assert.equal(r.identity_verified,true); assert.equal(r.notifications_verified,true); assert.equal(r.app_separation_verified,true);
});
test('live verification fails closed on wrong notification or shared app id',async()=>{
  const badEnv={...env,MERCADOPAGO_ACCESS_TOKEN:'APP_USR-123-010101-abc'};
  const sql={query:async()=>[{account_id:'456',access_token_enc:encryptSecret('ml-token',badEnv),refresh_token_enc:encryptSecret('refresh',badEnv),token_type:'Bearer',scope:'read',expires_at:new Date(Date.now()+3600000)}]};
  const fetchImpl=async(url)=>String(url).includes('/users/me')?{ok:true,status:200,json:async()=>({id:456})}:{ok:true,status:200,json:async()=>({id:123,notification_url:'https://wrong.example/webhook'})};
  const r=await verifyMercadoLivreLive(sql,{env:badEnv,fetchImpl}); assert.equal(r.all_verified,false); assert.equal(r.notifications_verified,false); assert.equal(r.app_separation_verified,false);
});