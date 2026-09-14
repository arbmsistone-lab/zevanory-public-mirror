import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AUTOPILOT_POLICY,AUTOPILOT_SUBJECTS,autopilotCycleId,buildProgramCandidate,runNonCommercialAutopilot} from '../src/nonCommercialAutopilot.mjs';

const evidence=(org,n)=>({organization:org,ok:true,status:200,evidence:{source:org,organization:org,source_url:`https://${org}.example/x`,observed_at:new Date().toISOString(),verified:true,conflict:false,signal:.8,kind:'market_signal'},metrics:{demand:.8,trend:.8,competition:.2,margin:.8,strategic_fit:.9,execution_fit:.9},sample:n});
const aggregate={decision:{decision:'INVESTIR',readiness:{verified_sources:5,independent_organizations:5},opportunity:{score:.84}}};

test('autopilot policy can never unlock sales or money movement',()=>{
  assert.equal(AUTOPILOT_POLICY.commercial_unlock,false);assert.equal(AUTOPILOT_POLICY.sales,false);assert.equal(AUTOPILOT_POLICY.checkout,false);assert.equal(AUTOPILOT_POLICY.financial,false);assert.ok(AUTOPILOT_SUBJECTS.length>=5);
});

test('program candidates are internal drafts only',()=>{
  const c=buildProgramCandidate('IA aplicada a pequenos negócios',aggregate,'autopilot-1');
  assert.equal(c.type,'internal_program_candidate');assert.equal(c.publishable,false);assert.equal(c.sellable,false);assert.equal(c.commercial_unlock,false);assert.match(c.name,/Programa ZEVANORY/);
});
test('scheduled autopilot researches, drafts a program and creates a creative with sales off',async()=>{
  const calls=[];const sql={query:async(q,args=[])=>{calls.push([q,args]);if(q.includes("provider='noncommercial-autopilot'"))return [];return [];}};
  const result=await runNonCommercialAutopilot({
    env:{DATABASE_URL:'postgres://example',FULFILLMENT_OPERATOR_TOKEN:'12345678901234567890123456789012',PUBLIC_BASE_URL:'https://zevanory.api.br'},scheduledTime:3600000,
    connect:()=>sql,
    collectSignals:async()=>[evidence('org-a',1),evidence('org-b',2),evidence('org-c',3),evidence('org-d',4),evidence('org-e',5)],
    selectCreative:async()=>({winner:{spec:{creative_id:'c1',variant_id:'v1',campaign_id:'autopilot-1'},quality_score:.98,perceptual_score:.96,review_board:{unanimous:true}},selection_basis:'perceptual_quality_no_observed_winner'}),
  });
  assert.equal(result.ok,true);assert.equal(result.processed,true);assert.equal(result.commercial_unlock,false);assert.equal(result.sales,false);assert.equal(result.creative.elite_accepted,true);assert.equal(result.creative.central_ready,true);assert.equal(result.creative.accepted_channels,5);assert.equal(result.creative.channel_creatives.length,5);
  assert.ok(calls.some(([q])=>q.includes('intelligence_snapshots')));assert.ok(calls.some(([q])=>q.includes('knowledge_documents')));assert.ok(calls.some(([q])=>q.includes('agent_runs')));
});

test('autopilot keeps sub-elite material out of the Central after three revision rounds',async()=>{
  let creativeCalls=0;const sql={query:async(q)=>q.includes("provider='noncommercial-autopilot'")?[]:[]};
  const result=await runNonCommercialAutopilot({env:{DATABASE_URL:'postgres://example',PUBLIC_BASE_URL:'https://zevanory.api.br'},scheduledTime:7200000,connect:()=>sql,collectSignals:async()=>[evidence('org-a',1),evidence('org-b',2),evidence('org-c',3),evidence('org-d',4),evidence('org-e',5)],selectCreative:async()=>{creativeCalls++;return {winner:{spec:{creative_id:'low',variant_id:'v1',campaign_id:'low'},quality_score:.94,perceptual_score:.91,review_board:{unanimous:true}}};}});
  assert.equal(result.creative.elite_accepted,false);assert.equal(result.creative.central_ready,false);assert.equal(result.creative.accepted_channels,0);assert.equal(creativeCalls,15);assert.ok(result.creative.channel_creatives.every(x=>x.revision_required&&!x.asset_url));
});

test('Cloudflare cron and scheduled handler are wired to the noncommercial autopilot',async()=>{
  const worker=await readFile(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');const wrangler=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(worker,/async scheduled\(/);assert.match(worker,/runNonCommercialAutopilot/);assert.match(wrangler,/"crons"\s*:\s*\["0 \* \* \* \*"\]/);assert.match(worker,/commercial_autopilot_failed|noncommercial_autopilot_failed/);
});

test('cycle id is deterministic per UTC hour',()=>{assert.equal(autopilotCycleId(3600000),autopilotCycleId(7199999));assert.notEqual(autopilotCycleId(3600000),autopilotCycleId(7200000));});
