import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {authorize} from "./authorize.mjs";

const load = async () => JSON.parse(await readFile(new URL("./policy.proposal.json", import.meta.url), "utf8"));
const active = async () => {
  const p = await load();
  p.status = "active";
  p.trusted_collector.workflow_sha = "1".repeat(40);
  p.roles.codex.principal = {type:"github_app_installation",login:"codex-app[bot]",installation_id:101};
  p.roles.owner.principal.login = "renan-owner";
  return p;
};
const evidence = () => ({
  provenance:{
    source:"github_api_readonly", status:"complete", api_errors:[],
    event:"pull_request_target",
    workflow_ref:".github/workflows/multiprovider-authorizer.yml@refs/heads/gh-pages",
    workflow_sha:"1".repeat(40),
    runs_from_protected_default_branch:true,
    executed_pr_code:false,
    event_head_sha:"a".repeat(40)
  },
  api:{pull_head_sha:"a".repeat(40)},
  pr:{
    number:813, author_login:"codex-app[bot]", author_type:"Bot",
    head_sha:"a".repeat(40), base_ref:"gh-pages",
    changed_paths:["growth/campaigns/plan.json"]
  },
  authenticated_principal:{type:"github_app_installation",login:"codex-app[bot]",installation_id:101},
  executor_binding:{
    status:"verified",source:"owner_registry_and_external_attestation",
    role:"codex",principal_login:"codex-app[bot]",installation_id:101,
    model_identity_status:"verified"
  },
  effective_permissions:{
    status:"complete",exhaustive:true,source:"github_api",
    permissions:{metadata:"read",contents:"write",pull_requests:"write"}
  },
  requested_action:"propose_acquisition_change",
  reviews:[]
});

test("inactive proposal always denies", async () => {
  const policy = await load();
  assert.deepEqual(authorize(policy,evidence()).reasons,["policy_not_active"]);
});

test("forged API response with a changed SHA is NOT PROVEN", async () => {
  const policy = await active(), e=evidence();
  e.api.pull_head_sha="b".repeat(40);
  assert.deepEqual(authorize(policy,e),{ok:false,decision:"NOT_PROVEN",reasons:["head_sha_mismatch"]});
});

test("executor-supplied or missing collector provenance is NOT PROVEN", async () => {
  const policy = await active(), e=evidence();
  e.provenance.source="caller_supplied";
  assert.deepEqual(authorize(policy,e).reasons,["collector_provenance_missing"]);
});

test("untrusted workflow and PR-code execution are NOT PROVEN", async () => {
  const policy = await active(), e=evidence();
  e.provenance.executed_pr_code=true;
  assert.deepEqual(authorize(policy,e).reasons,["collector_isolation_unproven"]);
});

test("model-to-principal binding requires external attestation", async () => {
  const policy = await active(), e=evidence();
  e.executor_binding.model_identity_status="declared_only";
  assert.deepEqual(authorize(policy,e).reasons,["model_identity_unproven"]);
});

test("unknown and excessive permissions fail closed", async () => {
  const policy = await active(), unknown=evidence(), excessive=evidence();
  unknown.effective_permissions.permissions.issues="read";
  excessive.effective_permissions.permissions.contents="admin";
  assert.deepEqual(authorize(policy,unknown).reasons,["unknown_permission:issues"]);
  assert.deepEqual(authorize(policy,excessive).reasons,["excess_permission:contents"]);
});

test("absent or incomplete permission evidence fails closed", async () => {
  const policy = await active(), missing=evidence(), incomplete=evidence();
  delete missing.effective_permissions.permissions.pull_requests;
  incomplete.effective_permissions.exhaustive=false;
  assert.deepEqual(authorize(policy,missing).reasons,["missing_permission:pull_requests"]);
  assert.deepEqual(authorize(policy,incomplete).reasons,["permission_evidence_incomplete"]);
});

test("Codex may change growth only", async () => {
  const policy = await active(), e=evidence();
  assert.equal(authorize(policy,e).decision,"ALLOW");
  e.pr.changed_paths=["README.md"];
  assert.deepEqual(authorize(policy,e).reasons,["codex_out_of_scope:README.md"]);
  e.pr.changed_paths=[".github/workflows/bypass.yml"];
  assert.match(authorize(policy,e).reasons[0],/^codex_forbidden_path:/);
});

test("stale, dismissed and self approvals cannot authorize merge", async () => {
  const policy = await active();
  policy.roles.codex.actions.push("merge");
  const stale=evidence();
  stale.requested_action="merge";
  stale.reviews=[{actor:"renan-owner",state:"APPROVED",commit_id:"b".repeat(40),dismissed:false}];
  assert.deepEqual(authorize(policy,stale).reasons,["distinct_owner_exact_head_approval_missing"]);

  const dismissed=evidence();
  dismissed.requested_action="merge";
  dismissed.reviews=[{actor:"renan-owner",state:"APPROVED",commit_id:"a".repeat(40),dismissed:true}];
  assert.deepEqual(authorize(policy,dismissed).reasons,["distinct_owner_exact_head_approval_missing"]);

  const self=evidence();
  self.requested_action="merge";
  self.pr.author_login="renan-owner";
  self.reviews=[{actor:"renan-owner",state:"APPROVED",commit_id:"a".repeat(40),dismissed:false}];
  assert.deepEqual(authorize(policy,self).reasons,["distinct_owner_exact_head_approval_missing"]);
});

test("valid exact-head approval still needs proven branch controls", async () => {
  const policy = await active(), e=evidence();
  policy.roles.codex.actions.push("merge");
  e.requested_action="merge";
  e.reviews=[{actor:"renan-owner",state:"APPROVED",commit_id:"a".repeat(40),dismissed:false}];
  e.branch_protection={status:"unavailable"};
  assert.deepEqual(authorize(policy,e),{ok:false,decision:"NOT_PROVEN",reasons:["branch_protection_unproven"]});
  e.branch_protection={status:"complete",pull_request_required:true,code_owner_review_required:true,stale_reviews_dismissed:true};
  assert.equal(authorize(policy,e).decision,"ALLOW");
});
