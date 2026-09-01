import { neon } from '@neondatabase/serverless';
import { safeBearerEqual } from '../src/security.mjs';
import { runAgentOnce } from '../src/agentWorker.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { dispatchChannelOutboxOnce } from '../src/integrationOutbox.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const expected=String(process.env.AGENT_WORKER_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'agent_auth_required'}));}
  if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'agent_storage_unavailable'}));}
  try{
    const sql=neon(process.env.DATABASE_URL);
    const agent=await runAgentOnce(sql);
    const channel=await dispatchChannelOutboxOnce(sql,buildOutboundAdapters());
    const ok=agent.ok!==false && channel.status!=='dead_letter';
    res.statusCode=ok?200:503;
    return res.end(JSON.stringify({ok,agent,channel}));
  }catch{res.statusCode=503;return res.end(JSON.stringify({error:'agent_execution_unavailable'}));}
}
