import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('central identifies ZEVANORY and connects real operational APIs',()=>{
  assert.match(html,/<title>ZEVANORY<\/title>/); assert.match(html,/CENTRAL OPERACIONAL/);
  for(const path of ['/api/status','/api/health','/api/release','/api/config']) assert.match(js,new RegExp(path.replaceAll('/','\\/')));
  assert.doesNotMatch(html,/GIRO LOCAL/i);
});

test('central exposes complete sales machine infrastructure',()=>{
  for(const id of ['crm','follow-up','unit-economics','learning','outbound','db-state','schema-state','schema-tables','schema-migrations','quality-gate','dr-mode','switches']) assert.match(html,new RegExp(`id="${id}"`));
  for(const key of ['page_views','leads_qualified','pipeline_open','actions_scheduled','offers_sent','checkouts_started','payments_confirmed','refunds_confirmed']) assert.match(html,new RegExp(`data-kpi="${key}"`));
});

test('central keeps commercial truth and no-baseline semantics explicit',()=>{
  assert.match(html,/nenhuma venda simulada/i); assert.match(js,/SEM BASELINE/); assert.match(js,/BLOQUEADO GLOBALMENTE/);
  assert.match(html,/dados agregados · sem PII/i);
});

test('central has no inline executable code under strict CSP',()=>{
  assert.doesNotMatch(html,/<style[>\s]/i); assert.doesNotMatch(html,/<script>([\s\S]*?)<\/script>/i);
  assert.match(html,/href="\/index\.css"/); assert.match(html,/src="\/index\.js"/);
});
