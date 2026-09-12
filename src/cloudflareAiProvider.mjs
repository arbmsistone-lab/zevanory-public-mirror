import { randomUUID } from 'node:crypto';
import { defineExecutionProvider } from './universalExecutionFabric.mjs';

export const CLOUDFLARE_AI_MODEL='@cf/meta/llama-3.2-1b-instruct';
export const CLOUDFLARE_AI_POLICY=Object.freeze({
  version:'cf-ai-free-v1',
  default_daily_call_limit:20,
  absolute_daily_call_limit:40,
  max_input_chars:24000,
  max_output_tokens:384,
  free_only:true,
});
const dayKey=()=>new Date().toISOString().slice(0,10);
const runtime=()=>globalThis.__ZEVANORY_EDGE_AI__?.AI||null;
const safeJson=text=>{
  const raw=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<start)throw new Error('cloudflare_ai_invalid_json');
  return JSON.parse(raw.slice(start,end+1));
};
async function reserveFreeCall(sql,limit){
  const today=dayKey(),id=randomUUID();
  const rows=await sql.query(`insert into agent_memory(memory_id,scope_type,scope_ref,memory_key,memory_value,confidence)
    values($1,'global','cloudflare-workers-ai','daily-free-budget',jsonb_build_object('day',$2,'count',1),1)
    on conflict(scope_type,scope_ref,memory_key) do update set
      memory_value=case when agent_memory.memory_value->>'day'=$2
        then jsonb_build_object('day',$2,'count',coalesce((agent_memory.memory_value->>'count')::int,0)+1)
        else jsonb_build_object('day',$2,'count',1) end,
      confidence=1,updated_at=now()
    where case when agent_memory.memory_value->>'day'=$2
      then coalesce((agent_memory.memory_value->>'count')::int,0)<$3 else true end
    returning memory_value`,[id,today,limit]);
  if(rows.length!==1)throw new Error('cloudflare_ai_free_budget_exhausted');
  return Number(rows[0]?.memory_value?.count||1);
}
async function freeBudgetHealth(sql,limit){
  const rows=await sql.query(`select memory_value from agent_memory
    where scope_type='global' and scope_ref='cloudflare-workers-ai' and memory_key='daily-free-budget' limit 1`);
  const value=rows[0]?.memory_value||{},used=value.day===dayKey()?Number(value.count||0):0;
  return {used,remaining:Math.max(0,limit-used)};
}
export function buildCloudflareAiExecutionProvider({sql,env=process.env}={}){
  const ai=runtime();
  if(!ai||!sql||String(env.CLOUDFLARE_AI_FREE_ONLY||'').toLowerCase()!=='true')return null;
  const requested=Math.max(1,Number(env.CLOUDFLARE_AI_DAILY_CALL_LIMIT)||CLOUDFLARE_AI_POLICY.default_daily_call_limit);
  const limit=Math.min(CLOUDFLARE_AI_POLICY.absolute_daily_call_limit,requested);
  return defineExecutionProvider({
    id:'ai-cloudflare-workers-adapter',capabilities:['ai:decision'],independenceDomain:'cloudflare-workers-ai',cost:0,priority:-10,
    health:async()=>{const q=await freeBudgetHealth(sql,limit);return {state:q.remaining>0?'available':'quota_limited',quotaRemainingPct:Math.round(q.remaining/limit*100),free_only:true,model:CLOUDFLARE_AI_MODEL};},
    execute:async({input,systemInstruction})=>{
      const call=await reserveFreeCall(sql,limit);
      const user=JSON.stringify(input||{}).slice(0,CLOUDFLARE_AI_POLICY.max_input_chars);
      const result=await ai.run(CLOUDFLARE_AI_MODEL,{messages:[
        {role:'system',content:`${String(systemInstruction||'')} Return one strict JSON object only.`},
        {role:'user',content:user},
      ],max_tokens:CLOUDFLARE_AI_POLICY.max_output_tokens,temperature:0.1});
      const parsed=safeJson(result?.response||result?.choices?.[0]?.message?.content||'');
      return Object.freeze({provider:'cloudflare',model:CLOUDFLARE_AI_MODEL,mode:'ai_assisted',free_only:true,daily_call_number:call,...parsed});
    },
  });
}
