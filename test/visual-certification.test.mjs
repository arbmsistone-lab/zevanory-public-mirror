import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const js=await readFile(new URL('../public/index.js',import.meta.url),'utf8');

test('EG0046 uses progressive disclosure instead of technical compression',()=>{
  assert.match(css,/EG-0046 — progressive executive disclosure/);
  assert.match(html,/id="details-dialog"/);assert.match(js,/showModal\(\)/);assert.match(js,/details\.close\(\)/);
});

test('primary surface exposes five executive KPIs and preserves secondary evidence',()=>{
  assert.equal((html.match(/<article><span>[^<]+<\/span><strong data-kpi=/g)||[]).length,5);
  for(const k of ['actions_scheduled','refunds_confirmed','offers_sent']) assert.match(html,new RegExp(`data-kpi="${k}"`));
});

test('technical evidence remains complete in the dialog',()=>{
  for(const id of ['crm','follow-up','unit-economics','learning','outbound','schema-tables','schema-migrations','audit-grid','checkout','financial','whatsapp']) assert.match(html,new RegExp(`id="${id}"`));
});

test('commercial switches remain runtime driven and fail closed visually',()=>{
  assert.match(js,/switchEntries/);assert.match(js,/b\.textContent=v\?'ON':'OFF'/);
  assert.match(css,/data-enabled="false"[^}]*amber/s);assert.match(css,/data-enabled="true"[^}]*red/s);
});
