import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const html=await readFile(new URL('../public/zevanory-robot-control.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/zevanory-robot-control.js',import.meta.url),'utf8');
const api=await readFile(new URL('../api/robot-control.mjs',import.meta.url),'utf8');
const controlApi=await readFile(new URL('../api/robot-control-action.mjs',import.meta.url),'utf8');
const approvalApi=await readFile(new URL('../api/robot-approval.mjs',import.meta.url),'utf8');

test('robot control surface is private-by-indexing and truth-labeled',()=>{
  assert.match(html,/noindex,nofollow,noarchive/);assert.match(html,/id="mode-label"/);assert.match(html,/SEM PII/);assert.match(html,/ATIVIDADE INVENTADA/);assert.match(js,/MODO OPERADOR AUTENTICADO/);
});

test('robot control API is operator authenticated and excludes payload bodies',()=>{
  assert.match(api,/safeBearerEqual/);assert.match(api,/operator_auth_required/);assert.doesNotMatch(api,/select .*payload/i);assert.doesNotMatch(api,/select .*session_id/i);assert.doesNotMatch(api,/select .*lead_id/i);
});

test('safe pause and approval APIs require operator authentication',()=>{
  for(const source of [controlApi,approvalApi]){assert.match(source,/safeBearerEqual/);assert.match(source,/operator_auth_required/);assert.match(source,/method_not_allowed/);}
  assert.match(controlApi,/setAgentPaused/);assert.match(approvalApi,/decideApproval/);assert.match(approvalApi,/\[1-5\]\[0-9a-f\]\{3\}/);assert.match(approvalApi,/\[89ab\]\[0-9a-f\]\{3\}/);
});

test('control room exposes real pause and human approval controls',()=>{
  assert.match(html,/id="emergency-stop"/);assert.match(html,/id="approval-queue"/);assert.match(html,/id="approval-dialog"/);assert.match(js,/togglePause/);assert.match(js,/decidePendingApproval/);
});

test('robot control assets exist',async()=>{for(const p of ['../public/zevanory-robot-control.css','../public/zevanory-robot-control.js'])assert.ok((await stat(new URL(p,import.meta.url))).size>100);});