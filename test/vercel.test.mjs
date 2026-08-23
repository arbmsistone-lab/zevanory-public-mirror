import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import configHandler from '../api/config.mjs';

function mock(method='GET') {
  const headers={};
  return {req:{method},res:{statusCode:200,body:'',setHeader(k,v){headers[k.toLowerCase()]=v;},end(v=''){this.body=v;return this;},headers}};
}

test('production config remains fail-closed until persistence proof',()=>{
  const {req,res}=mock('GET');
  configHandler(req,res);
  const body=JSON.parse(res.body);
  assert.equal(res.statusCode,200);
  assert.equal(body.whatsapp_enabled,false);
  assert.equal(body.whatsapp_number,'5588992340423');
});

test('event function uses Neon with idempotent insert',async()=>{
  const raw=await readFile(new URL('../api/events-public.mjs',import.meta.url),'utf8');
  assert.ok(raw.includes("@neondatabase/serverless"));
  assert.ok(raw.includes('ON CONFLICT (event_id) DO NOTHING'));
  assert.ok(raw.includes("normalizePublicEvent"));
});

test('temporary migration endpoint is fail-closed',async()=>{
  const raw=await readFile(new URL('../api/admin-migrate.mjs',import.meta.url),'utf8');
  assert.ok(raw.includes('ZEVANORY_MIGRATION_TOKEN'));
  assert.ok(raw.includes('unauthorized'));
  assert.ok(raw.includes('001_telemetry_events'));
});

test('vercel routing publishes landing and exact event endpoint',async()=>{
  const raw=await readFile(new URL('../vercel.json',import.meta.url),'utf8');
  const cfg=JSON.parse(raw);
  assert.ok(cfg.rewrites.some(x=>x.source==='/'&&x.destination==='/public/index.html'));
  assert.ok(cfg.rewrites.some(x=>x.source==='/api/events/public'&&x.destination==='/api/events-public'));
  assert.equal(cfg.cleanUrls,true);
});
