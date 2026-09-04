import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8');

test('webhook ingress is bounded and provider-authenticated',()=>{
  const ingress=read('api/webhooks.mjs');
  const meta=read('src/http/webhookMeta.mjs');
  const mp=read('src/mercadopago.mjs');
  const resend=read('src/http/webhookResend.mjs');
  const asaas=read('src/http/webhookAsaas.mjs');
  assert.match(ingress,/WEBHOOK_MAX_BYTES=256\*1024/);
  assert.match(ingress,/payload_too_large/);
  assert.match(ingress,/statusCode=tooLarge\?413:400/);
  assert.match(meta,/timingSafeEqual/);
  assert.match(mp,/Math\.abs\(now-tsMs\)>10\*60\*1000/);
  assert.match(mp,/createHmac\('sha256'/);
  assert.match(resend,/verify/i);
  assert.match(asaas,/webhook/i);
  assert.match(asaas,/401/);
});
