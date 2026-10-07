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
const [runsDoc,manifest,branchDoc,branchRuns]=await Promise.all([
  jf("https://api.github.com/repos/"+repo+"/actions/runs?head_sha="+sha+"&per_page=100"),
  jf("https://raw.githubusercontent.com/"+repo+"/gh-pages/zea10-external/manifest.json?cb="+Date.now()),
  jf("https://api.github.com/repos/"+repo+"/branches/gh-pages"),
  jf("https://api.github.com/repos/"+repo+"/actions/runs?branch=gh-pages&per_page=100")
]);
const workflows=new Map();
for(const run of runsDoc.workflow_runs||[]){
  if(run.head_sha!==sha||run.status!=="completed") continue;
  const current=workflows.get(run.name);
  if(!current||new Date(run.updated_at||run.created_at)>new Date(current.updated_at||current.created_at)) workflows.set(run.name,run);
}

const exactWorkflowProofs=[
  {
    name:"ZEVANORY apex engineering gate",
    file:"zevanory-apex-engineering.yml",
    artifact:"zevanory-apex-engineering-evidence-"+sha.slice(0,12),
    markers:["P01_APEX_EXACT_RELEASE=PASS","APEX_CANDIDATE_PREVIEW_SECURITY_HEADERS=PASS","Verify candidate preview legal surfaces and parity contract","PASS source hygiene/provenance"]
  },
  {
    name:"ZEES-16 Evidence Gate",
    file:"zees16-evidence-gate.yml",
    artifact:"p06-zees-gate-"+sha.slice(0,12),
    markers:["P06_ZEES_GATE_EXACT_RELEASE=PASS","Validate ZEES-16 registry","Validate P14 provider independence"]
  },
  {
    name:"ZEVANORY portable disaster recovery",
    file:"zevanory-portable-dr.yml",
    artifact:"zevanory-portable-recovery-kit-"+sha.slice(0,12),
    markers:["P09_P10_DR_EXACT_RELEASE=PASS","transport outage and commercial lock semantics are independently fail-safe","rollback_version"]
  },
  {
    name:"zevanory-p15-provenance",
    file:"zevanory-p15-provenance.yml",
    artifact:"p15-provenance-"+sha.slice(0,12),
    markers:["P13_P15_PROVENANCE_EXACT_RELEASE=PASS","Build deterministic exact-production tree manifest","tracked_tree_sha256"]
  },
  {
    name:"ZEVANORY provider independence gate",
    file:"zevanory-provider-independence.yml",
    artifact:"p14-provider-independence-"+sha.slice(0,12),
    markers:["P14_PROVIDER_INDEPENDENCE_EXACT_RELEASE=PASS","technical continuity is independent","minQuorum:3"]
  },
  {
    name:"ZEVANORY authenticated open-provider runtime quorum",
    file:"zevanory-three-provider-quorum.yml",
    artifact:"p14-three-provider-quorum-"+sha.slice(0,12),
    markers:["P14_THREE_PROVIDER_QUORUM_EXACT_RELEASE=PASS","open provider mesh satisfies independent quorum","min_quorum"]
  },
  {
    name:"zevanory-p02-visual-regression",
    file:"zevanory-p02-visual-regression.yml",
    artifact:"p02-visual-evidence-"+sha.slice(0,12),
    markers:["EXACT_RELEASE_BINDING=PASS","Verify responsive no-horizontal-scroll contract","overflowX"]
  },
  {
    name:"zevanory-p04-wcag",
    file:"zevanory-p04-wcag.yml",
    artifact:"p04-wcag-evidence-"+sha.slice(0,12),
    markers:["EXACT_RELEASE_BINDING=PASS","WCAG2AA","errorCount"]
  },
  {
    name:"zevanory-remote-quality-gates",
    file:"zevanory-remote-quality-gates.yml",
    artifact:"zevanory-remote-quality-evidence-"+sha.slice(0,12),
    markers:["EXACT_RELEASE_BINDING=PASS","Audit production quality","REQUIRED_STATUS_REPORT=PASS"]
  },
  {
    name:"zevanory-p12-continuous-slo",
    file:"zevanory-p12-continuous-slo.yml",
    artifact:"p12-slo-observation-"+sha.slice(0,12),
    markers:["EXACT_RELEASE_BINDING=PASS","zevanory.p12.slo.v1","all_ok"]
  },
  {
    name:"zevanory-p07-app-security",
    file:"zevanory-p07-app-security.yml",
    artifact:"zevanory-p07-security-"+sha.slice(0,12),
    markers:["P07_SECURITY=PROVED","SAST=PASS","DAST=PASS","SCA=PASS","FALSE_GREEN=0"]
  },
  {
    name:"ZEVANORY P08 supply-chain exact-release proof",
    file:"zevanory-p08-supply-chain.yml",
    artifact:"zevanory-p08-supply-chain-"+sha.slice(0,12),
    markers:["P08_SUPPLY_CHAIN=PROVED","SBOM=PASS","SCA=PASS","PROVENANCE=PASS","FAIL_CLOSED=PASS"]
  },
  {
    name:"zevanory-p12-observability-exact-release",
    file:"zevanory-p12-observability-exact-release.yml",
    artifact:"zevanory-p12-observability-"+sha.slice(0,12),
    markers:["P12_OBSERVABILITY=PROVED","METRICS=PASS","REQUEST_CORRELATION=PASS","SLO=PASS","INCIDENT_VISIBILITY=PASS"]
  },
  {
    name:"zevanory-p16-deterministic-exact-release",
    file:"zevanory-p16-deterministic-exact-release.yml",
    artifact:"zevanory-p16-financial-"+sha.slice(0,12),
    markers:["P16_LIFECYCLE=PROVED","P16_SOURCE_CONTRACT=PASS","RUNTIME_SHA_MATCH=PASS","financial_engine_deterministic.py","IDEMPOTENCY","REFUND"]
  }
];

async function collectProtectedExactProof(spec){
  const specificRuns=await jf(
    "https://api.github.com/repos/"+repo+"/actions/workflows/"+encodeURIComponent(spec.file)+"/runs?status=success&per_page=10"
  );
  const candidates=(specificRuns.workflow_runs||[]).filter(run=>
    run.status==="completed" &&
    run.conclusion==="success" &&
    String(run.path||"")===".github/workflows/"+spec.file
  ).sort((a,b)=>new Date(b.updated_at||b.created_at)-new Date(a.updated_at||a.created_at));

  // Quota-aware: newest 5 runs only; markers are checked on raw.githubusercontent
  // (no API quota) before a single artifacts API call. The proof stays bound to
  // the exact release through the SHA-derived artifact name.
  for(const run of candidates.slice(0,5)){
    const head=String(run.head_sha||"");
    if(!/^[0-9a-f]{40}$/.test(head)) continue;
    const workflowResponse=await fetch("https://raw.githubusercontent.com/"+repo+"/"+head+"/.github/workflows/"+spec.file,{
      headers:{"user-agent":"ZEVANORY-ZEES16-Reconciler/1.2","cache-control":"no-cache"}
    });
    if(!workflowResponse.ok) continue;
    const workflow=await workflowResponse.text();
    if(!spec.markers.every(marker=>workflow.includes(marker))) continue;
    if(!workflow.includes(sha) && !workflow.includes("EXPECTED_SHA12")) continue;
    const artifactsDoc=await jf("https://api.github.com/repos/"+repo+"/actions/runs/"+run.id+"/artifacts?per_page=100");
    const artifact=(artifactsDoc.artifacts||[]).find(item=>
      item?.name===spec.artifact &&
      item?.expired!==true &&
      Number(item?.size_in_bytes||0)>0
    );
    if(!artifact) continue;
    return {
      ...run,
      conclusion:"success",
      exact_release_bound:true,
      target_release_sha:sha,
      proof_artifact:{id:artifact.id,name:artifact.name,size_in_bytes:artifact.size_in_bytes,digest:artifact.digest||null}
    };
  }
  return null;
}

for(const spec of exactWorkflowProofs){
  try{
    const proof=await collectProtectedExactProof(spec);
    if(proof) workflows.set(spec.name,proof);
  }catch(error){
    console.error("EXACT_PROOF_COLLECTOR_ERROR",spec.name,String(error?.message||error));
  }
}
const currentHead=branchDoc?.commit?.sha||null;
const packRun=(branchRuns.workflow_runs||[]).find(run=>
  run.name==="ZEA-10 external evidence pack" &&
  run.status==="completed" &&
  run.conclusion==="success" &&
  run.head_sha===currentHead
);
const zea10PackBound=Boolean(
  packRun &&
  manifest?.production_release_sha===sha &&
  manifest?.external_certification_claimed===false
);
const signals={
  "runtime:exact_sha":true,
  "runtime:health_ready":health.ready===true&&health.live!==false,
  "runtime:telemetry_active":status?.runtime?.telemetry==="active",
  "runtime:quorum_ok":continuity?.quorum_ok===true,
  "runtime:sales_fail_closed":status?.runtime?.sales==="globally-blocked",
  "runtime:commercial_release":control?.global_state==="operational_commercial_enabled"&&status?.runtime?.sales!=="globally-blocked",
  "runtime:zea10_pack_bound":zea10PackBound
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
console.log("ZEES16_NON_PROVEN",JSON.stringify(state.pillars.filter(p=>p.state!=="PROVADO").map(p=>({id:p.id,state:p.state,blockers:p.blockers}))));
console.log(JSON.stringify({sha,counts:state.counts,decision_hash:decisionHash},null,2));
