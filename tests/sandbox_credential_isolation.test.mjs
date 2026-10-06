import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(p,'utf8');
test('deployment preserves sandbox and production credential separation',()=>{
 const prepare=read('scripts/deploy/prepare-central-candidate.py');
 assert.ok(!prepare.includes("'const providerToken = String(process.env.MERCADOPAGO_ACCESS_TOKEN"));
 assert.ok(!prepare.includes("'if (provider === \"mercadopago_test\") return handleMercadoPagoWebhook"));
 assert.ok(!prepare.includes("'if (!String(env.MERCADOPAGO_ACCESS_TOKEN"));
 const source=read('worker/cloudflare-worker.recovered.mjs');
 assert.match(source,/if \(provider === "mercadopago_test"\) return handleMercadoPagoWebhook\(req, res, \{ accessToken: process\.env\.MERCADOPAGO_TEST_ACCESS_TOKEN, webhookSecret: process\.env\.MERCADOPAGO_TEST_WEBHOOK_SECRET/);
 assert.ok(source.includes('if (provider === "mercadopago") return handler16(req, res);'));
 assert.ok(source.includes('accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET, certificationOnly: false'));
 const deploy=read('.github/workflows/central-production-deploy.yml');
 for(const name of ['MERCADOPAGO_ACCESS_TOKEN','MERCADOPAGO_WEBHOOK_SECRET','MERCADOPAGO_TEST_ACCESS_TOKEN','MERCADOPAGO_TEST_WEBHOOK_SECRET']){
  assert.ok(deploy.includes(name + ': $' + '{{ secrets.' + name + ' }}'));
 }
});
test('variable compaction inherits secrets and preserves voice values',()=>{
 const code=`import runpy\nm=runpy.run_path('scripts/deploy/compact-sandbox-bindings.py')\ns={'bindings':[{'name':'ZEVANORY_RUNTIME_CONFIG','type':'json','json':{'other':'keep'}},{'name':'VOICE_TTS_PROVIDER','type':'plain_text','text':'piper-relay'},{'name':'VOICE_TTS_PROVIDER_CHAIN','type':'plain_text','text':'a,b'},{'name':'SECRET','type':'secret_text'},{'name':'AI','type':'ai'}]}\nr=m['compact'](s)\nassert {'name':'SECRET','type':'inherit'} in r['bindings']\nv=next(x['json'] for x in r['bindings'] if x['type']=='json')\nassert v=={'other':'keep','VOICE_TTS_PROVIDER':'piper-relay','VOICE_TTS_PROVIDER_CHAIN':'a,b'}\nassert len(r['bindings'])==3\n`;
 const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
