import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { authorize } from "./authorize.mjs";

const load = async () => JSON.parse(await readFile(new URL("./policy.proposal.json", import.meta.url), "utf8"));
const active = async () => {
  const p = await load();
  p.status = "active";
  p.roles.codex.principal = {type:"github_app_installation",login:"codex-app[bot]",installation_id:101};
  p.roles.publisher.principal = {type:"github_actions_oidc",login:"github-actions[bot]",installation_id:"actions"};
  return p;
};
const permission = (login, extra={}) => ({
  login,
  repository:"arbmsistone-lab/zevanory-public-mirror",
  observed_via_api:true,
  permissions:{contents:"write",pull_requests:"write",metadata:"read",...extra}
});
const codex = () => ({
  executor_id:"codex",
  declared_executor:"codex",
  action:"propose_acquisition_change",
  authenticated_principal:{type:"github_app_installation",login:"codex-app[bot]",installation_id:101},
  permission_snapshot:permission("codex-app[bot]"),
  changed_paths:["growth/campaigns/plan.json"],
  head_sha:"a".repeat(40)
});

test("proposal is fail-closed until owner activates observed principals and controls", async () => {
  const policy = await load();
  assert.deepEqual(authorize(policy, codex()).reasons, ["policy_not_active"]);
});

test("declared executor without matching authenticated principal is denied", async () => {
  const policy = await active(), ctx = codex();
  delete ctx.authenticated_principal;
  assert.deepEqual(authorize(policy, ctx).reasons, ["authenticated_principal_mismatch"]);
});

test("shared owner identity cannot authenticate Codex", async () => {
  const policy = await active(), ctx = codex();
  ctx.authenticated_principal = {type:"github_app_installation",login:"arbmsistone-lab",installation_id:101};
  ctx.permission_snapshot = permission("arbmsistone-lab");
  assert.deepEqual(authorize(policy, ctx).reasons, ["authenticated_principal_mismatch"]);
});

test("Codex is restricted to growth paths", async () => {
  const policy = await active(), ctx = codex();
  ctx.changed_paths = ["worker/funnel.mjs"];
  assert.match(authorize(policy, ctx).reasons[0], /codex_forbidden_path/);
});

test("excess GitHub permission is denied even on an allowed path", async () => {
  const policy = await active(), ctx = codex();
  ctx.permission_snapshot = permission("codex-app[bot]", {actions:"write"});
  assert.deepEqual(authorize(policy, ctx).reasons, ["excess_permission:actions"]);
});

test("owner approval on a stale SHA cannot authorize merge", async () => {
  const policy = await active();
  policy.roles.owner.actions.push("merge");
  const ctx = {
    executor_id:"owner", declared_executor:"owner", action:"merge",
    authenticated_principal:{type:"human_github_account",login:"arbmsistone-lab"},
    permission_snapshot:permission("arbmsistone-lab"),
    head_sha:"b".repeat(40),
    owner_approval:{state:"APPROVED",actor:"arbmsistone-lab",head_sha:"a".repeat(40),stale_reviews_dismissed:true},
    branch_protection:{pull_request_required:true,code_owner_review_required:true,stale_reviews_dismissed:true}
  };
  assert.deepEqual(authorize(policy, ctx).reasons, ["owner_exact_head_approval_missing"]);
});

test("a valid isolated Codex acquisition proposal is allowed", async () => {
  const policy = await active();
  assert.equal(authorize(policy, codex()).decision, "ALLOW");
});

test("publisher requires canonical workflow and protected production approval", async () => {
  const policy = await active();
  const ctx = {
    executor_id:"publisher",declared_executor:"publisher",action:"deploy",
    authenticated_principal:{type:"github_actions_oidc",login:"github-actions[bot]",installation_id:"actions"},
    permission_snapshot:permission("github-actions[bot]"),
    changed_paths:[],head_sha:"c".repeat(40),
    owner_approval:{state:"APPROVED",actor:"arbmsistone-lab",head_sha:"c".repeat(40),stale_reviews_dismissed:true},
    workflow_path:".github/workflows/not-canonical.yml",
    environment:{name:"production",owner_approved:true,prevent_self_review:true,protected_branch_only:true}
  };
  assert.deepEqual(authorize(policy, ctx).reasons, ["noncanonical_publisher"]);
  ctx.workflow_path=".github/workflows/central-production-deploy.yml";
  assert.equal(authorize(policy, ctx).decision, "ALLOW");
});
