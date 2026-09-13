import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupportRequest, buildSupportKnowledgeQuery, evaluateSupportEvidence, validateSupportDecision, decideEliteProductSupport } from '../src/productSupport.mjs';
import { authorizeTool } from '../src/agentPolicy.mjs';
import { buildLiveActionPlan } from '../src/liveActionPlan.mjs';

const official=(ref='products/releases/v1.1/ZEV-IA-011/README.md')=>({title:'Produto',namespace:'product:ZEV-IA-011',content:'Procedimento oficial validado.',source_ref:ref,trust_level:'official'});

test('support request normalizes product version module symptom and error',()=>{
  const r=normalizeSupportRequest({product_code:' ZEV-IA-011 ',version:' 1.1 ',module:'Prompts',symptom:' Erro ao abrir ',error_code:'E42'});
  assert.equal(r.product_code,'ZEV-IA-011');assert.equal(r.product_version,'1.1');assert.equal(r.error_code,'E42');
  assert.match(buildSupportKnowledgeQuery(r),/ZEV-IA-011 1\.1 Prompts E42/);
});

test('ordinary support requires verified source and product identity',()=>{
  assert.equal(evaluateSupportEvidence({product_code:'ZEV-IA-011',question:'como usar?'},[official()]).ready,true);
  assert.equal(evaluateSupportEvidence({question:'como usar?'},[official()]).ready,false);
  assert.equal(evaluateSupportEvidence({product_code:'ZEV-IA-011',question:'como usar?'},[{...official(),trust_level:'unverified'}]).ready,false);
});

test('high risk guidance requires exact version and two verified sources',()=>{
  const req={product_code:'ZEV-IA-011',module:'deploy',question:'como restaurar backup de produção?'};
  assert.equal(evaluateSupportEvidence(req,[official()]).ready,false);
  assert.equal(evaluateSupportEvidence({...req,product_version:'1.1'},[official(),official('specs/recovery.md')]).ready,true);
});
test('elite gate rejects commercial content and invalid citations',()=>{
  const evidence=evaluateSupportEvidence({product_code:'ZEV-IA-011',question:'como usar?'},[official()]);
  const bad=validateSupportDecision({action:'support_reply',confidence:.99,message:'Compre agora por R$ 197',source_refs:[official().source_ref]},evidence);
  assert.equal(bad.pass,false);assert.ok(bad.issues.includes('commercial_content_forbidden_in_support'));
  const badCitation=validateSupportDecision({action:'support_reply',confidence:.99,message:'Siga o procedimento oficial.',source_refs:['inventado.md']},evidence);
  assert.equal(badCitation.pass,false);assert.ok(badCitation.issues.includes('support_citations_invalid_or_insufficient'));
});

test('support messaging authorization remains independent of sales gate',()=>{
  const auth=authorizeTool('send_support_message',{SALE_GLOBALLY_ENABLED:'false',SUPPORT_MESSAGING_ENABLED:'true'});
  assert.equal(auth.allowed,true);assert.equal(auth.risk_level,'support');
});

test('live action plan marks support as external without commercial approval',()=>{
  const plan=buildLiveActionPlan({job:{job_id:'1',payload:{}},runId:'2',traceId:'3',tool:'send_support_message',auth:{risk_level:'support',reason:'support'},decision:{action:'support_reply',message:'Orientação técnica',rationale:'verified'},context:{lead:{channel:'whatsapp'}}});
  assert.equal(plan.external_effect_possible,true);assert.equal(plan.approval.required,false);assert.equal(plan.where,'channel:whatsapp');
});

test('insufficient evidence fails closed before AI call',async()=>{
  const out=await decideEliteProductSupport({request:{product_code:'ZEV-IA-011',module:'deploy',question:'restaurar banco de produção'},knowledge:[official()]});
  assert.equal(out.action,'support_request_context');assert.equal(out.evidence.ready,false);
});
