import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const html=await readFile(new URL('../public/zevanory-robot-control.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/zevanory-robot-control.js',import.meta.url),'utf8');
const api=await readFile(new URL('../api/robot-control.mjs',import.meta.url),'utf8');

test('robot control surface is private-by-indexing and truth-labeled',()=>{
  assert.match(html,/noindex,nofollow,noarchive/);
  assert.match(html,/MODO DEMONSTRAÇÃO/);
  assert.match(html,/SEM PII · SEM ATIVIDADE INVENTADA/);
  assert.match(js,/MODO OPERADOR AUTENTICADO/);
});

test('robot control API is operator authenticated and excludes payload bodies',()=>{
  assert.match(api,/safeBearerEqual/);
  assert.match(api,/operator_auth_required/);
  assert.doesNotMatch(api,/select .*payload/i);
  assert.doesNotMatch(api,/select .*session_id/i);
  assert.doesNotMatch(api,/select .*lead_id/i);
});

test('robot control assets exist',async()=>{
  for(const p of ['../public/zevanory-robot-control.css','../public/zevanory-robot-control.js']) assert.ok((await stat(new URL(p,import.meta.url))).size>100);
});
