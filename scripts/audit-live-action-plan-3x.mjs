import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),cwd=fileURLToPath(root);
const text=p=>readFile(new URL(p,root),'utf8');
const run=(args)=>spawnSync(process.execPath,args,{cwd,encoding:'utf8'}).status===0;
const [plan,worker,control,provider,api,html,js,evidence]=await Promise.all([
  text('src/liveActionPlan.mjs'),text('src/agentWorker.mjs'),text('src/agentControl.mjs'),text('src/providerConfirmation.mjs'),
  text('api/robot-control.mjs'),text('public/zevanory-robot-control.html'),text('public/zevanory-robot-control.js'),text('evidence/EG-0070-live-action-plan.md')
]);
const audits=[];const add=(name,checks)=>audits.push({name,checks,pass:checks.every(Boolean)});
add('AUDITORIA_1_ESTRUTURA_CONFIGURACAO',[
  plan.includes("state:'planned'"),plan.includes('manifest_id'),plan.includes('expected_result'),plan.includes('content_or_offer'),
  worker.indexOf('persistLiveActionPlan')<worker.indexOf('executeTool(sql,tool'),html.includes('PLANO DE AÇÃO VIVO'),api.includes('live_action_plans'),/Status: APROVADO COM RESTRI(?:COES|ÇÕES)/.test(evidence)
]);
add('AUDITORIA_2_FUNCAO_SEGURANCA_INTEGRIDADE',[
  run(['--test','test/live-action-plan.test.mjs','test/provider-confirmation.test.mjs','test/agent-worker-integrity.test.mjs','test/robot-control.test.mjs']),
  run(['--check','src/liveActionPlan.mjs']),run(['--check','src/agentWorker.mjs']),run(['--check','src/providerConfirmation.mjs']),
  !/contact_ref|session_id|cpf|password|token/i.test(plan),control.includes("state:decision==='approved'?'planned':'canceled'"),provider.includes("provider_confirmation")
]);
add('AUDITORIA_3_INTEGRACAO_REGRESSAO',[
  worker.includes("state:'awaiting_approval'"),worker.includes("outcome==='completed'?'executed':'failed'"),
  provider.includes("payload->'live_action_plan'->>'run_id'"),js.includes('renderLiveActionPlans'),js.includes("p.state==='executed'"),
  run(['scripts/identity-guard.mjs'])
]);
for(const a of audits) console.log(`${a.pass?'APPROVED':'BLOCKED'} ${a.name} checks=${a.checks.filter(Boolean).length}/${a.checks.length}`);
const failed=audits.filter(a=>!a.pass);
console.log(`LIVE_ACTION_PLAN_3X_${failed.length?'BLOCKED':'APPROVED'} audits=3 approved=${3-failed.length} failed=${failed.length}`);
if(failed.length) process.exitCode=1;
