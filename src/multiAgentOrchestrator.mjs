import { authorizeTool } from './agentPolicy.mjs';

export const COMMERCIAL_AGENTS=Object.freeze({
  research:Object.freeze({capabilities:['market_research','product_intelligence']}),
  growth:Object.freeze({capabilities:['creative','campaign','experiment']}),
  sales:Object.freeze({capabilities:['qualify','offer','follow_up','checkout']}),
  customer:Object.freeze({capabilities:['onboarding','support','retention','win_back']}),
  finance:Object.freeze({capabilities:['checkout','reconciliation','refund']}),
  data:Object.freeze({capabilities:['attribution','learning','customer_features']}),
});
const routes=Object.freeze({market:'research',product:'research',creative:'growth',campaign:'growth',experiment:'growth',lead:'sales',offer:'sales',follow_up:'sales',checkout:'sales',onboarding:'customer',support:'customer',retention:'customer',win_back:'customer',reconciliation:'finance',refund:'finance',attribution:'data',learning:'data',customer_features:'data'});
export function routeCommercialTask(task={}){
  const kind=String(task.kind||'').toLowerCase(); const agent=routes[kind]||null;
  return Object.freeze({routed:Boolean(agent),agent,kind,reason:agent?'capability_match':'no_specialist'});
}
export function buildSupervisorPlan(tasks=[]){
  const steps=(Array.isArray(tasks)?tasks:[]).map((task,index)=>Object.freeze({step:index+1,task,route:routeCommercialTask(task)}));
  const unrouted=steps.filter(x=>!x.route.routed).length;
  return Object.freeze({ready:steps.length>0&&unrouted===0,supervisor:'commercial_orchestrator_v2',steps:Object.freeze(steps),unrouted,commercial_unlock:false});
}
export function authorizeSpecialistTool(tool,env=process.env){
  const auth=authorizeTool(tool,env);
  return Object.freeze({...auth,supervised:true,commercial_unlock:false});
}
