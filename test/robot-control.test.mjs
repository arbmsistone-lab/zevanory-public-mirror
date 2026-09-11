import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const html=await readFile(new URL('../public/zevanory-robot-control.html',import.meta.url),'utf8');
const js=await readFile(new URL('../public/zevanory-robot-control.js',import.meta.url),'utf8');
const api=await readFile(new URL('../api/robot-control.mjs',import.meta.url),'utf8');

test('robot control surface is private-by-indexing and truth-labeled',()=>{
  assert.match(html,/noindex,nofollow,noarchive/);assert.match(html,/id="mode-label"/);assert.match(html,/SEM PII/);assert.match(html,/ATIVIDADE INVENTADA/);assert.match(js,/MODO OPERADOR AUTENTICADO/);
});

test('robot control API is authenticated and exposes only operational approval fields',()=>{
  assert.match(api,/safeBearerEqual/);assert.match(api,/OPERATOR_TOKEN_SECONDARY/);assert.match(api,/secondary&&safeBearerEqual/);assert.match(api,/operator_auth_required/);assert.match(api,/payload->'approval'/);assert.doesNotMatch(api,/select .*session_id/i);assert.doesNotMatch(api,/select .*lead_id/i);assert.doesNotMatch(api,/contact_ref|email|phone|cpf/i);
});

test('safe pause and approval commands share one authenticated function',()=>{
  assert.match(api,/req.method==='POST'/);assert.match(api,/setAgentPaused/);assert.match(api,/decideApproval/);assert.match(api,/control_command_invalid/);assert.match(api,/approval_request_invalid/);assert.match(api,/\[1-5\]\[0-9a-f\]\{3\}/);assert.match(api,/\[89ab\]\[0-9a-f\]\{3\}/);
  assert.match(js,/command:action/);assert.match(js,/command:'approval'/);assert.doesNotMatch(js,/robot-control-action|robot-approval/);
});

test('control room exposes real pause and human approval controls',()=>{
  assert.match(html,/id="emergency-stop"/);assert.match(html,/id="approval-queue"/);assert.match(html,/id="approval-dialog"/);assert.match(js,/togglePause/);assert.match(js,/decidePendingApproval/);
});

test('robot control assets exist',async()=>{for(const p of ['../public/zevanory-robot-control.css','../public/zevanory-robot-control.js'])assert.ok((await stat(new URL(p,import.meta.url))).size>100);});

test('certification probe is isolated, deterministic and cannot unlock commerce',()=>{
  assert.match(api,/certification_probe/);assert.match(api,/queueOutcomeLearningReview/);assert.match(api,/operator_certification_probe/);
  assert.ok(api.includes('runAgentOnce(sql,{jobId:queued.job_id,ignorePause:true')); assert.match(api,/AGENT_AI_ENABLED:'false'/);assert.match(api,/commercial_unlock:false/);
});
