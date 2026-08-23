import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const port = 4193;
const token = 'integration-token-1234567890';
let child;

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server_not_ready');
}

async function post(path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {'content-type':'application/json', ...headers},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
test.before(async () => {
  child = spawn(process.execPath, ['src/server-v2.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      WHATSAPP_NUMBER: '5588992340423',
      OPERATOR_TOKEN: token,
    },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  child?.kill();
});

test('runtime config exposes canonical definitions and official WhatsApp', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.whatsapp_number, '5588992340423');
  assert.equal(body.offer_id, 'OFFER-0001');
  assert.equal(body.experiment_id, 'EXP-0001');
  assert.equal(body.experimental_price_brl, 497);
});

test('public and operator boundaries reject forged financial events', async () => {
  const session_id = randomUUID();
  assert.equal((await post('/api/events/public', {name:'page_view', session_id})).status, 202);
  assert.equal((await post('/api/events/public', {name:'payment_confirmed', session_id})).status, 400);
  assert.equal((await post('/api/events/operator', {name:'lead_qualified', session_id})).status, 401);
  assert.equal((await post('/api/events/operator', {name:'lead_qualified', session_id}, {authorization:`Bearer ${token}`})).status, 202);
  assert.equal((await post('/api/events/financial', {name:'payment_confirmed', session_id})).status, 503);
});

test('input validation is fail-closed for malformed JSON and invalid sessions', async () => {
  const malformed = await post('/api/events/public', '{bad json');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_json');
  const invalidSession = await post('/api/events/public', {name:'page_view', session_id:'fake'});
  assert.equal(invalidSession.status, 400);
  assert.equal((await invalidSession.json()).error, 'invalid_session_id');
});

test('landing and API responses include basic defensive headers', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const api = await fetch(`http://127.0.0.1:${port}/api/config`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

