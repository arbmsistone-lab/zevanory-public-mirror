import test from 'node:test';
import assert from 'node:assert/strict';
import handler,{fetchAsaasPayment} from '../api/webhooks/asaas.mjs';
import { asaasBaseUrl } from '../src/asaas.mjs';

function mockReq(headers={},body={},method='POST') { return {headers,body,method}; }
function mockRes() {
  const headers={};
  return {statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers};
}

test('Asaas API environments are explicit and fail closed',()=>{
  assert.equal(asaasBaseUrl('sandbox'),'https://api-sandbox.asaas.com/v3');
  assert.equal(asaasBaseUrl('production'),'https://api.asaas.com/v3');
  assert.equal(asaasBaseUrl('invalid'),'');
});

test('Asaas lookup uses provider access_token and payment id',async()=>{
  let seen;
  const payment=await fetchAsaasPayment('pay_123456789','sandbox','key-123',async(url,opts)=>{
    seen={url,opts}; return {ok:true,json:async()=>({id:'pay_123456789'})};
  });
  assert.equal(payment.id,'pay_123456789');
  assert.match(seen.url,/api-sandbox\.asaas\.com\/v3\/payments\/pay_123456789$/);
  assert.equal(seen.opts.headers.access_token,'key-123');
});

test('webhook rejects invalid token before any provider action',async()=>{
  const old=process.env.ASAAS_WEBHOOK_TOKEN;
  process.env.ASAAS_WEBHOOK_TOKEN='expected-token';
  const res=mockRes();
  await handler(mockReq({'asaas-access-token':'wrong-token'}),res);
  assert.equal(res.statusCode,401);
  assert.match(res.body,/webhook_auth_failed/);
  if(old===undefined) delete process.env.ASAAS_WEBHOOK_TOKEN; else process.env.ASAAS_WEBHOOK_TOKEN=old;
});

test('webhook blocks when financial provider is not configured',async()=>{
  const previous={token:process.env.ASAAS_WEBHOOK_TOKEN,key:process.env.ASAAS_API_KEY,env:process.env.ASAAS_ENV};
  process.env.ASAAS_WEBHOOK_TOKEN='expected-token';
  process.env.FINANCIAL_EVENTS_ENABLED='true';
  delete process.env.ASAAS_API_KEY; delete process.env.ASAAS_ENV;
  const res=mockRes();
  await handler(mockReq({'asaas-access-token':'expected-token'}),res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/financial_provider_unavailable/);
  if(previous.token===undefined) delete process.env.ASAAS_WEBHOOK_TOKEN; else process.env.ASAAS_WEBHOOK_TOKEN=previous.token;
  if(previous.key===undefined) delete process.env.ASAAS_API_KEY; else process.env.ASAAS_API_KEY=previous.key;
  if(previous.env===undefined) delete process.env.ASAAS_ENV; else process.env.ASAAS_ENV=previous.env;
  delete process.env.FINANCIAL_EVENTS_ENABLED;
});


test('webhook is disabled by default even with valid token',async()=>{
  const old=process.env.ASAAS_WEBHOOK_TOKEN;
  process.env.ASAAS_WEBHOOK_TOKEN='expected-token';
  delete process.env.FINANCIAL_EVENTS_ENABLED;
  const res=mockRes();
  await handler(mockReq({'asaas-access-token':'expected-token'}),res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/financial_events_disabled/);
  if(old===undefined) delete process.env.ASAAS_WEBHOOK_TOKEN; else process.env.ASAAS_WEBHOOK_TOKEN=old;
});

test('webhook persists provider-reconciled cumulative refund total',async()=>{
  const { readFile } = await import('node:fs/promises');
  const source=await readFile(new URL('../api/webhooks/asaas.mjs',import.meta.url),'utf8');
  assert.match(source,/refundTotalForWebhook/);
  assert.match(source,/refunded_total/);
  assert.match(source,/normalized === 'refund_confirmed'/);
  assert.match(source,/ON CONFLICT DO NOTHING/);
  assert.match(source,/unlinked_payment/);
});


test('webhook successful acknowledgement uses provider-required HTTP 200',async()=>{
  const source=await (await import('node:fs/promises')).readFile(new URL('../api/webhooks/asaas.mjs',import.meta.url),'utf8');
  assert.match(source,/res\.statusCode = 200;\s*return res\.end\(JSON\.stringify\(\{ accepted: true/);
  assert.doesNotMatch(source,/res\.statusCode = 202;\s*return res\.end\(JSON\.stringify\(\{ accepted: true/);
});
