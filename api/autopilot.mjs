import { safeBearerEqual } from '../src/security.mjs';
import { runNonCommercialAutopilot } from '../src/nonCommercialAutopilot.mjs';

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST'){res.statusCode=405;return res.end(JSON.stringify({error:'method_not_allowed'}));}
  const expected=String(process.env.OPERATOR_TOKEN||process.env.AGENT_WORKER_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'operator_auth_required'}));}
  const requestedCycle=String(req.headers?.['x-zevanory-cycle-id']||'').trim().toLowerCase();
  if(requestedCycle&&!/^cert-[a-z0-9-]{8,80}$/.test(requestedCycle)){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_certification_cycle_id'}));}
  try{
    const result=await runNonCommercialAutopilot({env:process.env,scheduledTime:Date.now(),cycleIdOverride:requestedCycle||null});
    res.statusCode=result.ok?200:503;return res.end(JSON.stringify(result));
  }catch(error){res.statusCode=503;return res.end(JSON.stringify({error:'autopilot_run_failed',detail:String(error?.message||'unknown').slice(0,160),commercial_unlock:false}));}
}
