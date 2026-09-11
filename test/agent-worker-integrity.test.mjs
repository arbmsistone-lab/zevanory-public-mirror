import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentOnce} from '../src/agentWorker.mjs';

function fakeSql({paused=false}={}){
  const state={runInserted:false,auditInserted:false,jobStatus:null,queries:[]};
  return {state,async query(text,args=[]){
    const q=String(text);state.queries.push(q);
    if(q.includes('from agent_memory')) return [{memory_value:{paused,reason:paused?'operator_pause':'ready',changed_by:'test'},updated_at:null}];
    if(q.includes("update agent_jobs set status='running'")) return [{job_id:'11111111-1111-4111-8111-111111111111',job_type:'lead_review',lead_id:'22222222-2222-4222-8222-222222222222'}];
    if(q.includes('select lead_id,session_id,channel,stage')) return [{lead_id:'22222222-2222-4222-8222-222222222222',session_id:'33333333-3333-4333-8333-333333333333',channel:'zevanory',stage:'qualified',contact_ref:null,touchpoints:0}];
    if(q.includes('from knowledge_documents')) return [];
    if(q.includes("payload=jsonb_set(coalesce(payload,'{}'::jsonb),'{live_action_plan}'")) return [{live_action_plan:JSON.parse(args[1])}];
    if(q.includes("payload=jsonb_set(\n    payload,'{live_action_plan}'")) return [{live_action_plan:{state:JSON.parse(args[1]).state}}];
    if(q.includes('insert into agent_runs')){state.runInserted=true;return []}
    if(q.includes('insert into agent_tool_audit')){assert.equal(state.runInserted,true);state.auditInserted=true;return []}
    if(q.includes('update agent_jobs set status=$2')){state.jobStatus=args[1];return []}
    return [];
  }};
}

test('agent persists run before FK-backed tool audit without migration 011',async()=>{
  const sql=fakeSql();const result=await runAgentOnce(sql,{env:{AGENT_AI_ENABLED:'false'}});
  assert.equal(result.ok,true);assert.equal(result.outcome,'completed');assert.equal(sql.state.runInserted,true);assert.equal(sql.state.auditInserted,true);assert.equal(sql.state.jobStatus,'completed');
  assert.equal(sql.state.queries.some(q=>/agent_control_state|agent_approvals|\br\.trace_id\b|\br\.span_id\b/.test(q)),false);
  const planIndex=sql.state.queries.findIndex(q=>q.includes('{live_action_plan}'));const runIndex=sql.state.queries.findIndex(q=>q.includes('insert into agent_runs'));assert.ok(planIndex>=0&&planIndex<runIndex);
});

test('safe pause blocks the worker before claiming a job',async()=>{
  const sql=fakeSql({paused:true});const result=await runAgentOnce(sql,{env:{AGENT_AI_ENABLED:'false'}});assert.equal(result.processed,false);assert.equal(result.reason,'agent_paused');assert.equal(sql.state.queries.some(q=>q.includes("update agent_jobs set status='running'")),false);
});


test('targeted certification path may bypass pause only with explicit job id',async()=>{
  const sql=fakeSql({paused:true});
  const result=await runAgentOnce(sql,{jobId:'11111111-1111-4111-8111-111111111111',ignorePause:true,env:{AGENT_AI_ENABLED:'false'}});
  assert.equal(result.processed,true);
  assert.equal(sql.state.queries.some(q=>q.includes("where job_id=$1 and status='queued'")),true);
});
