import test from "node:test";
import assert from "node:assert/strict";
import {collectEvidence} from "./collector.mjs";

const event = {
  repository:{owner:{login:"arbmsistone-lab"},name:"zevanory-public-mirror",full_name:"arbmsistone-lab/zevanory-public-mirror"},
  pull_request:{number:813,head:{sha:"a".repeat(40)}}
};
const runtime = {
  event:"pull_request_target",
  runsFromProtectedDefaultBranch:true,
  executedPrCode:false,
  workflowRef:".github/workflows/multiprovider-authorizer.yml@refs/heads/gh-pages",
  workflowSha:"1".repeat(40)
};
const github = {
  getPull:async()=>({user:{login:"codex-app[bot]",type:"Bot"},head:{sha:"a".repeat(40)},base:{ref:"gh-pages"}}),
  listAllFiles:async()=>[{filename:"growth/plan.json"}],
  listAllReviews:async()=>[],
  getCollaboratorPermission:async()=>({permission:"write"}),
  getEffectiveAppPermissions:async()=>({exhaustive:true,permissions:{metadata:"read",contents:"write",pull_requests:"write"}}),
  getBranchProtection:async()=>({status:"complete",pull_request_required:true}),
  getEnvironment:async()=>({status:"complete",name:"production"})
};
const bindingVerifier = {
  verify:async()=>({
    status:"verified",source:"owner_registry_and_external_attestation",role:"codex",
    principal:{type:"github_app_installation",login:"codex-app[bot]",installation_id:101},
    principal_login:"codex-app[bot]",installation_id:101,model_identity_status:"verified"
  })
};

test("collector builds complete evidence from read-only sources", async()=>{
  const result=await collectEvidence({github,event,runtime,bindingVerifier});
  assert.equal(result.provenance.status,"complete");
  assert.deepEqual(result.pr.changed_paths,["growth/plan.json"]);
  assert.equal(result.effective_permissions.exhaustive,true);
});

test("collector marks a forged pull SHA incomplete", async()=>{
  const forged={...github,getPull:async()=>({user:{login:"codex-app[bot]",type:"Bot"},head:{sha:"b".repeat(40)},base:{ref:"gh-pages"}})};
  const result=await collectEvidence({github:forged,event,runtime,bindingVerifier});
  assert.equal(result.provenance.status,"incomplete");
  assert.equal(result.provenance.api_errors.at(-1).status,"head_sha_mismatch");
});

test("collector does not hide unavailable protection APIs", async()=>{
  const unavailable={...github,getBranchProtection:async()=>{const error=new Error("forbidden");error.status=403;throw error;}};
  const result=await collectEvidence({github:unavailable,event,runtime,bindingVerifier});
  assert.equal(result.provenance.status,"incomplete");
  assert.deepEqual(result.branch_protection,{status:"unavailable"});
  assert.deepEqual(result.provenance.api_errors.find(x=>x.operation==="branch_protection"),{operation:"branch_protection",status:403});
});

test("collector refuses untrusted event or PR code execution", async()=>{
  await assert.rejects(()=>collectEvidence({github,event,runtime:{...runtime,event:"pull_request"},bindingVerifier}),/trusted_event_required/);
  await assert.rejects(()=>collectEvidence({github,event,runtime:{...runtime,executedPrCode:true},bindingVerifier}),/collector_isolation_required/);
});
