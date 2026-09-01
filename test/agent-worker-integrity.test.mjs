import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentOnce} from '../src/agentWorker.mjs';

function fakeSql(){
  const state={runInserted:false,auditInserted:false,jobStatus:null,queries:[]};
  return {state,async query(text,args=[]){
    const q=String(text); state.queries.push(q);
    if(q.includes("update agent_jobs set status='running'")) return [{job_id:'11111111-1111-4111-8111-111111111111',job_type:'lead_review',lead_id:'22222222-2222-4222-8222-222222222222'}];
    if(q.includes('select lead_id,channel,stage')) return [{lead_id:'22222222-2222-4222-8222-222222222222',channel:'web',stage:'qualified',touchpoints:0}];
    if(q.includes('from knowledge_documents')) return [];
    if(q.includes('insert into agent_runs')){ state.runInserted=true; return []; }
    if(q.includes('insert into agent_tool_audit')){ assert.equal(state.runInserted,true,'tool audit must reference an existing run'); state.auditInserted=true; return []; }
    if(q.includes('insert into sales_actions')) return [];
    if(q.includes('update sales_leads')) return [];
    if(q.includes('insert into agent_memory')) return [];
    if(q.includes('update agent_jobs set status=$2')){ state.jobStatus=args[1]; return []; }
    return [];
  }};
}

test('agent persists run before FK-backed tool audit',async()=>{
  const sql=fakeSql();
  const result=await runAgentOnce(sql,{env:{AGENT_AI_ENABLED:'false'}});
  assert.equal(result.ok,true);
  assert.equal(result.outcome,'completed');
  assert.equal(sql.state.runInserted,true);
  assert.equal(sql.state.auditInserted,true);
  assert.equal(sql.state.jobStatus,'completed');
});
