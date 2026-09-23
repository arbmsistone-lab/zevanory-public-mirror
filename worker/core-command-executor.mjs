const STATE_KEY="control:v3:authority:zevanory";
const LEDGER_PREFIX="control:v3:command-ledger:zevanory:";
const IDEMPOTENCY_PREFIX="control:v3:idempotency:zevanory:";
const utf8=new TextEncoder();

const COMMANDS=Object.freeze({
  "certification.promote":Object.freeze({kind:"governance",state:"CERTIFIED"}),
  "release.promote":Object.freeze({kind:"governance",state:"RELEASE_APPROVED"}),
  "state.transition":Object.freeze({kind:"governance",state:null}),
  "commercial.enable":Object.freeze({kind:"runtime",state:"COMMERCIAL_ENABLE_AUTHORIZED"})
});

const STATE_TRANSITIONS=new Set([
  "EVIDENCE_READY",
  "CERTIFIED",
  "RELEASE_APPROVED",
  "COMMERCIAL_ENABLE_AUTHORIZED",
  "COMMERCIAL_ENABLED",
  "COMMERCIAL_BLOCKED"
]);

function stable(value){
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
}
async function sha256Hex(value){
  const digest=await crypto.subtle.digest("SHA-256",utf8.encode(String(value)));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function readJson(request){
  try{
    const text=await request.text();
    if(!text) return {};
    const value=JSON.parse(text);
    return value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  }catch{return {};}
}
function idempotencyKey(request){
  return String(request.headers.get("idempotency-key")||"").trim();
}
async function kvGet(kv,key){
  if(!kv||typeof kv.get!=="function") return null;
  const raw=await kv.get(key);
  if(!raw) return null;
  try{return JSON.parse(raw);}catch{return null;}
}
async function kvPut(kv,key,value,metadata={}){
  if(!kv||typeof kv.put!=="function") throw new Error("command_state_store_unavailable");
  await kv.put(key,JSON.stringify(value),{metadata});
}
export async function readCoreAuthorityState(env){
  return kvGet(env?.ZEVANORY_PRIVATE_ARTIFACTS,STATE_KEY);
}

export function commandCatalog(){
  return Object.entries(COMMANDS).map(([id,def])=>({
    id,
    effect:def.kind==="runtime"?"runtime-critical":"governance-critical",
    exposed:true,
    requires:["admin-auth","idempotency-key","exact-release-sha","core-decision-ALLOW","audit-ledger"],
    runtime_adapter:def.kind==="runtime"?"required-for-live-effect":"not-required"
  }));
}

export async function executeCoreCommand({request,env,snapshot,decision,command}){
  const def=COMMANDS[command];
  if(!def) return {status:404,body:{ok:false,error:"command_not_found",command}};

  const key=idempotencyKey(request);
  if(key.length<12||key.length>160){
    return {status:400,body:{ok:false,error:"valid_idempotency_key_required",command}};
  }
  const kv=env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if(!kv||typeof kv.get!=="function"||typeof kv.put!=="function"){
    return {status:503,body:{ok:false,error:"command_state_store_unavailable",command,fail_closed:true}};
  }

  const keyHash=await sha256Hex(key);
  const replay=await kvGet(kv,IDEMPOTENCY_PREFIX+keyHash);
  if(replay){
    return {status:Number(replay.http_status||200),body:{...replay,idempotent_replay:true}};
  }

  const input=await readJson(request);
  const expected=String(input.expected_release_sha||request.headers.get("x-zevanory-release-sha")||"").trim();
  if(!expected||expected!==snapshot?.release_sha){
    return {status:409,body:{
      ok:false,command,decision:"DENY",fail_closed:true,
      error:"exact_release_sha_required",
      expected_release_sha:expected||null,
      canonical_release_sha:snapshot?.release_sha||null
    }};
  }
  if(decision?.decision!=="ALLOW"||decision?.eligible_for_critical_promotion!==true){
    return {status:409,body:{
      ok:false,command,decision:"DENY",fail_closed:true,
      error:"core_decision_not_allow",
      blockers:decision?.blockers||["decision_unavailable"]
    }};
  }

  let target=def.state;
  if(command==="state.transition"){
    target=String(input.target_state||"").trim().toUpperCase();
    if(!STATE_TRANSITIONS.has(target)){
      return {status:400,body:{ok:false,command,error:"invalid_target_state",allowed:[...STATE_TRANSITIONS]}};
    }
  }

  const now=new Date().toISOString();
  const current=await readCoreAuthorityState(env);
  const eventBase={
    schema:"zevanory-control-core/command-event-v1",
    type:"CORE_CRITICAL_COMMAND",
    command,
    target_state:target,
    previous_state:current?.state||null,
    release_sha:snapshot.release_sha,
    zees16_decision_hash:snapshot?.zees16?.decision_hash||null,
    zea10_source_decision_hash:snapshot?.zea10?.source_decision_hash||null,
    core_decision:decision.decision,
    reason:String(input.reason||"").slice(0,500)||null,
    requested_at:now,
    idempotency_key_hash:keyHash
  };

  let execution={
    applied:true,
    state:target,
    mode:"canonical-governance-state",
    runtime_effect:"none"
  };

  if(def.kind==="runtime"){
    const adapter=env?.ZEVANORY_RUNTIME_COMMAND_EXECUTOR;
    if(!adapter||typeof adapter.fetch!=="function"){
      const denied={...eventBase,result:"DENY",error:"runtime_command_executor_unavailable",fail_closed:true};
      const eventHash=await sha256Hex(stable(denied));
      await kvPut(kv,LEDGER_PREFIX+now.replace(/[:.]/g,"-")+":"+eventHash,{...denied,event_hash:eventHash},{
        type:denied.type,command,result:"DENY",release_sha:snapshot.release_sha,event_hash:eventHash
      });
      const result={
        ok:false,command,decision:"DENY",fail_closed:true,
        error:"runtime_command_executor_unavailable",
        reason:"commercial activation requires an authenticated runtime deployment adapter; authorization alone never enables sales",
        release_sha:snapshot.release_sha,
        event_hash:eventHash,
        http_status:503
      };
      await kvPut(kv,IDEMPOTENCY_PREFIX+keyHash,result,{command,release_sha:snapshot.release_sha});
      return {status:503,body:result};
    }
    const adapterRequest=new Request("https://runtime-command-executor.internal/v1/execute",{
      method:"POST",
      headers:{"content-type":"application/json","idempotency-key":key},
      body:JSON.stringify({
        command,
        target_state:target,
        release_sha:snapshot.release_sha,
        decision_hash:snapshot?.zees16?.decision_hash||null,
        reason:eventBase.reason
      })
    });
    const adapterResponse=await adapter.fetch(adapterRequest);
    let adapterBody={};
    try{adapterBody=await adapterResponse.json();}catch{}
    if(!adapterResponse.ok||adapterBody?.applied!==true){
      const denied={...eventBase,result:"DENY",error:"runtime_adapter_rejected",adapter_status:adapterResponse.status,fail_closed:true};
      const eventHash=await sha256Hex(stable(denied));
      await kvPut(kv,LEDGER_PREFIX+now.replace(/[:.]/g,"-")+":"+eventHash,{...denied,event_hash:eventHash},{
        type:denied.type,command,result:"DENY",release_sha:snapshot.release_sha,event_hash:eventHash
      });
      const result={ok:false,command,decision:"DENY",fail_closed:true,error:"runtime_adapter_rejected",adapter_status:adapterResponse.status,event_hash:eventHash,http_status:502};
      await kvPut(kv,IDEMPOTENCY_PREFIX+keyHash,result,{command,release_sha:snapshot.release_sha});
      return {status:502,body:result};
    }
    execution={applied:true,state:target,mode:"runtime-adapter",runtime_effect:"applied",adapter:adapterBody};
  }

  const next={
    schema:"zevanory-control-core/authority-state-v1",
    state:target,
    command,
    release_sha:snapshot.release_sha,
    effective_at:now,
    previous_state:current?.state||null,
    previous_event_hash:current?.event_hash||null,
    zees16_decision_hash:snapshot?.zees16?.decision_hash||null,
    zea10_source_decision_hash:snapshot?.zea10?.source_decision_hash||null,
    authority:"ZEVANORY Control Core"
  };
  const event={...eventBase,result:"APPLIED",execution,next_state:next};
  const eventHash=await sha256Hex(stable(event));
  next.event_hash=eventHash;
  await kvPut(kv,LEDGER_PREFIX+now.replace(/[:.]/g,"-")+":"+eventHash,{...event,event_hash:eventHash},{
    type:event.type,command,result:"APPLIED",release_sha:snapshot.release_sha,event_hash:eventHash
  });
  await kvPut(kv,STATE_KEY,next,{state:target,command,release_sha:snapshot.release_sha,event_hash:eventHash});

  const result={
    ok:true,
    command,
    decision:"ALLOW",
    applied:true,
    fail_closed:true,
    state:target,
    execution,
    release_sha:snapshot.release_sha,
    event_hash:eventHash,
    authority_state:next,
    http_status:200
  };
  await kvPut(kv,IDEMPOTENCY_PREFIX+keyHash,result,{command,release_sha:snapshot.release_sha});
  return {status:200,body:result};
}
