import { neon } from '@neondatabase/serverless';
import { assessOutboxHealth, assessAgentHealth, SERVICE_OBJECTIVES } from '../src/enterpriseAssurance.mjs';
import { validateProviderContracts } from '../src/providerContracts.mjs';
import { attachRequestContext, operationalLog } from '../src/observability.mjs';
import { verifyExternalChannelIdentities } from '../src/channelIdentityPreflight.mjs';
import { channelReadiness } from '../src/channelAdapters.mjs';

const DIAG_PROBE='provider-closeout-6e9f2c';
const boolSummary=(x)=>({attempted:Boolean(x?.attempted),verified:Boolean(x?.verified),reason:String(x?.reason||'unknown')});

export default async function handler(req,res){
  const context=attachRequestContext(req,res,'/api/assurance');
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;operationalLog(context,405,'method_not_allowed');return res.end(JSON.stringify({error:'method_not_allowed',request_id:context.requestId}));}
  if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'assurance_storage_unavailable',request_id:context.requestId}));}
  try{
    const sql=neon(process.env.DATABASE_URL);
    const probe=String(req.query?.probe||new URL(req.url||'/api/assurance','https://zevanory.api.br').searchParams.get('probe')||'');
    if(probe===DIAG_PROBE){
      const [identities,oauthRows]=await Promise.all([
        verifyExternalChannelIdentities({env:process.env}),
        sql.query(`select provider,expires_at from provider_oauth_credentials where provider in ('tiktok','tiktok_sandbox','linkedin','nuvemshop','mercado_livre') order by provider`),
      ]);
      const readiness=channelReadiness(process.env);
      const providers=Object.fromEntries(Object.entries(readiness).map(([k,v])=>[k,{configured:Boolean(v.configured),missing_count:v.missing.length}]));
      const oauth=Object.fromEntries(['tiktok','tiktok_sandbox','linkedin','nuvemshop','mercado_livre'].map(name=>{const row=oauthRows.find(x=>x.provider===name);return [name,{present:Boolean(row),expired:row?new Date(row.expires_at).getTime()<=Date.now():null}]}));
      const body={temporary_probe:true,commercial_unlock:false,identities:Object.fromEntries(Object.entries(identities).map(([k,v])=>[k,boolSummary(v)])),providers,oauth,request_id:context.requestId};
      res.statusCode=200; operationalLog(context,200,'provider_closeout_probe'); return res.end(JSON.stringify(body));
    }
    const [outbox,runs]=await Promise.all([
      sql.query(`select count(*) filter(where status='pending')::int pending,count(*) filter(where status='retry')::int retry,
        count(*) filter(where status='dead_letter')::int dead_letter,
        coalesce(extract(epoch from(now()-min(created_at) filter(where status in('pending','retry')))),0)::int oldest_pending_seconds from integration_outbox`),
      sql.query(`select count(*)::int runs,count(*) filter(where outcome='failed')::int failed,
        count(*) filter(where outcome='blocked')::int blocked,count(*) filter(where mode='deterministic')::int fallback
        from agent_runs where created_at>=now()-interval '24 hours'`),
    ]);
    const body={service:'ZEVANORY',objectives:SERVICE_OBJECTIVES,outbox:assessOutboxHealth({pending:outbox[0]?.pending,retry:outbox[0]?.retry,deadLetter:outbox[0]?.dead_letter,oldestPendingSeconds:outbox[0]?.oldest_pending_seconds}),
      agent:assessAgentHealth(runs[0]||{}),provider_contracts:validateProviderContracts(),historical_slo_proven:false,request_id:context.requestId};
    res.statusCode=200; operationalLog(context,200,'enterprise_assurance_ok',{outbox_healthy:body.outbox.healthy,agent_healthy:body.agent.healthy});
    return res.end(JSON.stringify(body));
  }catch{res.statusCode=503;operationalLog(context,503,'enterprise_assurance_unavailable');return res.end(JSON.stringify({error:'enterprise_assurance_unavailable',request_id:context.requestId}));}
}
