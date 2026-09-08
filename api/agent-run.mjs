import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { safeBearerEqual } from '../src/security.mjs';
import { runAgentOnce } from '../src/agentWorker.mjs';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { dispatchChannelOutboxOnce } from '../src/integrationOutbox.mjs';
import { preserveStorageOperation, storageOperation } from '../src/storageFabric.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store'); res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const expected=String(process.env.AGENT_WORKER_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'agent_auth_required'}));}
  const requestId=String(req.headers?.['x-request-id']||randomUUID()).slice(0,120);
  const operation=storageOperation({operationId:`agent-run:${requestId}`,operationType:'agent.run_request',payload:{request_id:requestId,executed:false}});
  if(!process.env.DATABASE_URL){
    const preserved=await preserveStorageOperation(operation);
    res.statusCode=preserved.preserved?202:503;
    return res.end(JSON.stringify({ok:false,preserved:preserved.preserved,pending_storage:preserved.preserved,executed:false,error:preserved.preserved?undefined:'agent_storage_unavailable'}));
  }
  try{
    const sql=neon(process.env.DATABASE_URL);
    const agent=await runAgentOnce(sql);
    const channel=await dispatchChannelOutboxOnce(sql,buildOutboundAdapters());
    const ok=agent.ok!==false && channel.status!=='dead_letter';
    res.statusCode=ok?200:503;
    return res.end(JSON.stringify({ok,agent,channel}));
  }catch(error){
    const preserved=await preserveStorageOperation(storageOperation({operationId:`agent-run-reconcile:${requestId}`,operationType:'agent.run_reconciliation',payload:{request_id:requestId,executed:null,reconciliation_required:true,reason:String(error?.message||'agent_execution_unavailable').slice(0,160)}}));
    res.statusCode=503;return res.end(JSON.stringify({error:'agent_execution_unavailable',preserved:preserved.preserved,reconciliation_required:true}));
  }
}
