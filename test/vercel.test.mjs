import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import configHandler from '../api/config.mjs';
import eventHandler from '../api/events-public.mjs';

function mock(method='GET') {
  const headers = {};
  return {
    req: { method },
    res: {
      statusCode: 200,
      body: '',
      setHeader(k,v){ headers[k.toLowerCase()] = v; },
      end(v=''){ this.body = v; return this; },
      headers
    }
  };
}

test('production config is fail-closed and canonical', () => {
  const {req,res} = mock('GET');
  configHandler(req,res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.whatsapp_enabled, false);
  assert.equal(body.whatsapp_number, '5588992340423');
});
test('production telemetry rejects until persistence exists', () => {
  const {req,res} = mock('POST');
  eventHandler(req,res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 503);
  assert.equal(body.accepted, false);
  assert.equal(body.error, 'persistent_telemetry_not_configured');
});

test('vercel routing publishes landing and exact event endpoint', async () => {
  const raw = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(cfg.rewrites.some(x => x.source === '/' && x.destination === '/public/index.html'));
  assert.ok(cfg.rewrites.some(x => x.source === '/api/events/public' && x.destination === '/api/events-public'));
  assert.equal(cfg.cleanUrls, true);
});
