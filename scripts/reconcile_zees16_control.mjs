import { evaluatePolicy } from "../worker/evidence-control-plane.mjs";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const repo=process.env.GITHUB_REPOSITORY||"arbmsistone-lab/zevanory-public-mirror";
const token=process.env.GITHUB_TOKEN||"";
const base=process.env.ZEVANORY_BASE_URL||"https://zevanory.api.br";
const previousPath=process.env.PREVIOUS_STATE_PATH||"";
const headers={"accept":"application/vnd.github+json","user-agent":"ZEVANORY-ZEES16-Reconciler/1.0"};
if(token) headers.authorization="Bearer "+token;

async function jf(url,init={}){
  const r=await fetch(url,{...init,headers:{...headers,...(init.headers||{})}});
  if(!r.ok) throw new Error("fetch "+r.status+" "+url);
  return r.json();
}
async function publicJson(path){
  const r=await fetch(base+path+(path.includes("?")?"&":"?")+"cb="+Date.now(),{headers:{"accept":"application/json","cache-control":"no-cache","user-agent":"ZEVANORY-ZEES16-Reconciler/1.0"}});
  if(!r.ok) throw new Error("production "+r.status+" "+path);
  return r.json();
}
function stable(value){
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
}
const [build,status,health,control,continuity]=await Promise.all([
  publicJson("/build-info.json"),
  publicJson("/api/status"),
  publicJson("/api/health"),
  publicJson("/api/control-plane"),
  publicJson("/api/continuity")
]);
const sha=build.sha;
if(!/^[0-9a-f]{40}$/.test(sha||"")) throw new Error("invalid production SHA");
if(control?.release?.deployment?.commit_sha!==sha) throw new Error("control-plane SHA divergence");
const runsDoc=await jf("https://api.github.com/repos/"+repo+"/actions/runs?head_sha="+sha+"&per_page=100");
const workflows=new Map();
for(const run of runsDoc.workflow_runs||[]){
  if(run.head_sha!==sha||run.status!=="completed") continue;
  const current=workflows.get(run.name);
  if(!current||new Date(run.updated_at||run.created_at)>new Date(current.updated_at||current.created_at)) workflows.set(run.name,run);
}
const signals={
  "runtime:exact_sha":true,
  "runtime:health_ready":health.ready===true&&health.live!==false,
  "runtime:telemetry_active":status?.runtime?.telemetry==="active",
  "runtime:quorum_ok":continuity?.quorum_ok===true,
  "runtime:sales_fail_closed":status?.runtime?.sales==="globally-blocked",
  "runtime:commercial_release":control?.global_state==="operational_commercial_enabled"&&status?.runtime?.sales!=="globally-blocked"
};
const observedAt=new Date().toISOString();
const state=evaluatePolicy({signals,workflows,releaseSha:sha,observedAt});
let previous=null;
if(previousPath){
  try{previous=JSON.parse(await fs.readFile(previousPath,"utf8"));}catch{}
}
const event={
  type:"ZEES16_RECONCILED",
  target:"zevanory",
  policy_version:state.policy_version,
  release_sha:state.release_sha,
  counts:state.counts,
  observed_at:state.observed_at,
  pillars:state.pillars,
  previous_decision_hash:previous?.decision_hash||null
};
const decisionHash=crypto.createHash("sha256").update(stable(event)).digest("hex");
const decision={...state,inputs:signals,decision_hash:decisionHash,previous_decision_hash:event.previous_decision_hash,persistence:"kv-append-only",evaluator:"ZEES16_POLICY_ENGINE",evaluator_version:state.policy_version};
await fs.writeFile("zees16-state.json",JSON.stringify(decision,null,2)+"\n");
await fs.writeFile("zees16-event.json",JSON.stringify({...event,event_hash:decisionHash},null,2)+"\n");
console.log(JSON.stringify({sha,counts:state.counts,decision_hash:decisionHash},null,2));
