import { reconcileControlPlane, readControlState } from "./evidence-control-plane.mjs";

const ACTION_LEDGER_PREFIX="control:v2:action-ledger:zevanory:";
const utf8=new TextEncoder();

async function sha256Hex(value){
  const digest=await crypto.subtle.digest("SHA-256",utf8.encode(String(value)));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function stable(value){
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
}
function json(body,status=200,extra={}){
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...extra}});
}
async function appendAudit(env,event){
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  const event_hash=await sha256Hex(stable(event));
  if(kv&&typeof kv.put==="function"){
    const ts=event.observed_at.replace(/[:.]/g,"-");
    await kv.put(ACTION_LEDGER_PREFIX+ts+":"+event_hash,JSON.stringify({...event,event_hash}),{
      metadata:{type:event.type,action:event.action||"",result:event.result||"",event_hash}
    });
  }
  return event_hash;
}
function readIdempotencyKey(request){
  return String(request.headers.get("idempotency-key")||"").trim();
}
export async function handleControlActionRequest(request,env,ctx,worker){
  const url=new URL(request.url);
  if(url.pathname==="/api/admin/control/v2/actions"){
    if(request.method!=="GET") return json({error:"method_not_allowed"},405,{"allow":"GET"});
    return json({
      plane:"action",
      mode:"fail-closed",
      destructive_actions:false,
      available:[
        {id:"inspect",method:"POST",effect:"none"},
        {id:"reconcile",method:"POST",effect:"materialize evidence-derived state only"}
      ],
      invariants:[
        "no deploy",
        "no rollback",
        "no commercial activation",
        "no direct pillar promotion",
        "every accepted action is audit-ledgered"
      ]
    });
  }
  if(!url.pathname.startsWith("/api/admin/control/v2/actions/")) return json({error:"not_found"},404);
  if(request.method!=="POST") return json({error:"method_not_allowed"},405,{"allow":"POST"});

  const action=url.pathname.slice("/api/admin/control/v2/actions/".length);
  if(!["inspect","reconcile"].includes(action)) return json({error:"action_not_allowed",action},403);

  const key=readIdempotencyKey(request);
  if(!key||key.length<12||key.length>160) return json({error:"valid_idempotency_key_required"},400);

  const observed_at=new Date().toISOString();
  const base={
    type:"CONTROL_ACTION",
    target:"zevanory",
    action,
    idempotency_key_hash:await sha256Hex(key),
    observed_at
  };

  try{
    let output;
    if(action==="inspect"){
      output=await readControlState(env);
      if(!output) output={state:"unavailable"};
    }else{
      output=await reconcileControlPlane(worker,env,ctx,url.origin);
    }
    const event_hash=await appendAudit(env,{...base,result:"success",decision_hash:output?.decision_hash||null,release_sha:output?.release_sha||null});
    return json({ok:true,action,event_hash,output});
  }catch(error){
    const message=String(error?.message||error||"action_failed");
    const event_hash=await appendAudit(env,{...base,result:"failure",error:message});
    return json({ok:false,action,event_hash,error:message},503);
  }
}
