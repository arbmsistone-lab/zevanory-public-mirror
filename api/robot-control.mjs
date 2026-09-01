import {neon} from '@neondatabase/serverless';
import {safeBearerEqual} from '../src/security.mjs';
import {channelReadiness} from '../src/channelAdapters.mjs';
import {getAgentControlState} from '../src/agentControl.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||min));
const cleanError=(v)=>String(v||'').slice(0,240);

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET') return json(res,405,{error:'method_not_allowed'});
  const expected=String(process.env.OPERATOR_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(expected,provided)) return json(res,401,{error:'operator_auth_required'});
  if(!process.env.DATABASE_URL) return json(res,503,{error:'robot_control_storage_unavailable'});
  const limit=clamp(req.query?.limit||30,10,100);
  try{
    const sql=neon(process.env.DATABASE_URL);
    const [runs,tools,jobs,outbox,actions,approvals,control]=await Promise.all([
      sql.query(`select r.run_id,r.job_id,r.trace_id,r.span_id,j.job_type,r.provider,r.model,r.mode,r.outcome,r.latency_ms,r.input_tokens,r.output_tokens,r.estimated_cost_usd,r.created_at,
        r.decision->>'action' action,r.decision->>'rationale' rationale,r.decision->>'confidence' confidence,r.decision->>'tool' tool,r.decision->'result' result,r.decision->'eval' eval
        from agent_runs r left join agent_jobs j on j.job_id=r.job_id order by r.created_at desc limit $1`,[limit]),
      sql.query(`select run_id,tool_name,risk_level,allowed,reason,created_at from agent_tool_audit order by created_at desc limit $1`,[limit]),
      sql.query(`select job_id,job_type,status,priority,attempts,available_at,locked_at,completed_at,last_error,created_at from agent_jobs order by created_at desc limit $1`,[limit]),
      sql.query(`select event_id,run_id,trace_id,aggregate_type,event_type,destination,status,attempts,available_at,locked_at,delivered_at,last_error,created_at from integration_outbox order by created_at desc limit $1`,[limit]),
      sql.query(`select action_type,channel,status,count(*)::int count from sales_actions group by action_type,channel,status order by count desc`),
      sql.query(`select approval_id,job_id,run_id,trace_id,tool_name,risk_level,status,request_reason,decision_reason,decided_by,requested_at,decided_at from agent_approvals order by requested_at desc limit $1`,[limit]),
      getAgentControlState(sql),
    ]);
    const gates={sale:process.env.SALE_GLOBALLY_ENABLED==='true',pre_sale:process.env.PRE_SALE_GATES_APPROVED==='true',checkout:process.env.CHECKOUT_ENABLED==='true',financial:process.env.FINANCIAL_EVENTS_ENABLED==='true',whatsapp:process.env.WHATSAPP_SALES_ENABLED==='true'};
    const channels=Object.fromEntries(Object.entries(channelReadiness()).map(([k,v])=>[k,{configured:v.configured,role:v.role,commercial:v.commercial}]));
    return json(res,200,{mode:'operator',generated_at:new Date().toISOString(),control,gates,channels,
      runs:runs.map(x=>({...x,rationale:String(x.rationale||'').slice(0,500)})),tools,
      jobs:jobs.map(x=>({...x,last_error:cleanError(x.last_error)})),
      outbox:outbox.map(x=>({...x,last_error:cleanError(x.last_error)})),actions,approvals});
  }catch(error){return json(res,503,{error:'robot_control_unavailable',detail:cleanError(error?.message)});}
}
