import { neon } from '@neondatabase/serverless';
import { assessOutboxHealth, assessAgentHealth, SERVICE_OBJECTIVES } from '../enterpriseAssurance.mjs';
import { validateProviderContracts } from '../providerContracts.mjs';
import { attachRequestContext, operationalLog } from '../observability.mjs';
import { isPublicDeploymentRequest, safeBearerEqual } from '../security.mjs';
import { executeVerifiedRead } from '../databaseReadFabric.mjs';

export default async function handler(req,res){
  const context=attachRequestContext(req,res,'/api/assurance');
  if(isPublicDeploymentRequest(req)){const expected=String(process.env.OPERATOR_TOKEN||process.env.FULFILLMENT_OPERATOR_TOKEN||'');const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');if(!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'operator_auth_required'}));}}
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;operationalLog(context,405,'method_not_allowed');return res.end(JSON.stringify({error:'method_not_allowed',request_id:context.requestId}));}
  const readOutcome=await executeVerifiedRead({env:process.env,connect:neon,read:async(sql)=>{
    const [outbox,runs]=await Promise.all([
      sql.query(`select count(*) filter(where status='pending')::int pending,count(*) filter(where status='retry')::int retry,count(*) filter(where status='dead_letter')::int dead_letter,coalesce(extract(epoch from(now()-min(created_at) filter(where status in('pending','retry')))),0)::int oldest_pending_seconds from integration_outbox`),
      sql.query(`select count(*)::int runs,count(*) filter(where outcome='failed')::int failed,count(*) filter(where outcome='blocked')::int blocked,count(*) filter(where mode='deterministic')::int fallback from agent_runs where created_at>=now()-interval '24 hours'`),
    ]);
    return {outbox,runs};
  }});
  if(!readOutcome.ok){res.statusCode=503;operationalLog(context,503,'enterprise_assurance_unavailable',{read_attempts:readOutcome.attempts.length});return res.end(JSON.stringify({error:'enterprise_assurance_unavailable',request_id:context.requestId}));}
  const {outbox,runs}=readOutcome.result;
  const body={service:'ZEVANORY',objectives:SERVICE_OBJECTIVES,outbox:assessOutboxHealth({pending:outbox[0]?.pending,retry:outbox[0]?.retry,deadLetter:outbox[0]?.dead_letter,oldestPendingSeconds:outbox[0]?.oldest_pending_seconds}),agent:assessAgentHealth(runs[0]||{}),provider_contracts:validateProviderContracts(),historical_slo_proven:false,request_id:context.requestId};
  res.statusCode=200;operationalLog(context,200,'enterprise_assurance_ok',{outbox_healthy:body.outbox.healthy,agent_healthy:body.agent.healthy,read_route:readOutcome.route,canonical_read:readOutcome.canonical});
  return res.end(JSON.stringify(body));
}
