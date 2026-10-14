const WRITE = new Set(["write","admin"]);
const sensitive = path => [
  ".github/workflows/","ops/","worker/","scripts/deploy/","sales-public/",
  "checkout","payment","financial","secret","credential"
].some(fragment => String(path).toLowerCase().includes(fragment.toLowerCase()));

const fail = (...reasons) => ({ ok:false, decision:"DENY", reasons });
const exactApproval = (ctx, owner) =>
  ctx.owner_approval?.state === "APPROVED" &&
  ctx.owner_approval?.actor === owner &&
  ctx.owner_approval?.head_sha === ctx.head_sha &&
  ctx.owner_approval?.stale_reviews_dismissed === true;

export function authorize(policy, ctx) {
  if (policy?.status !== "active") return fail("policy_not_active");
  const role = policy.roles?.[ctx.executor_id];
  if (!role) return fail("unknown_executor");
  if (ctx.declared_executor !== ctx.executor_id) return fail("declared_identity_mismatch");

  const expected = role.principal;
  const actual = ctx.authenticated_principal;
  if (!actual || actual.type !== expected.type || actual.login !== expected.login || String(actual.installation_id || "") !== String(expected.installation_id || "")) {
    return fail("authenticated_principal_mismatch");
  }
  if (ctx.executor_id !== "owner" && actual.login === policy.roles.owner.principal.login) return fail("shared_owner_identity");
  if (!role.actions.includes(ctx.action)) return fail("action_not_allowed");

  const snapshot = ctx.permission_snapshot;
  if (!snapshot || snapshot.login !== actual.login || snapshot.repository !== policy.repository || snapshot.observed_via_api !== true) {
    return fail("permission_snapshot_missing");
  }
  if (ctx.executor_id === "codex") {
    for (const [name, level] of Object.entries(policy.least_privilege.forbidden_for_codex)) {
      if (WRITE.has(snapshot.permissions?.[name] || "none")) return fail("excess_permission:" + name);
    }
    for (const path of ctx.changed_paths || []) {
      if (sensitive(path)) return fail("codex_forbidden_path:" + path);
      if (!role.allowed_path_prefixes.some(prefix => path.startsWith(prefix))) return fail("codex_out_of_scope:" + path);
    }
  }

  if (ctx.action === "merge") {
    if (!exactApproval(ctx, policy.roles.owner.principal.login)) return fail("owner_exact_head_approval_missing");
    if (ctx.branch_protection?.pull_request_required !== true || ctx.branch_protection?.code_owner_review_required !== true || ctx.branch_protection?.stale_reviews_dismissed !== true) {
      return fail("branch_protection_unproven");
    }
  }

  if (ctx.action === "deploy") {
    if (!exactApproval(ctx, policy.roles.owner.principal.login)) return fail("owner_exact_head_approval_missing");
    if (!policy.publication.canonical_workflows.includes(ctx.workflow_path)) return fail("noncanonical_publisher");
    if (ctx.environment?.name !== policy.publication.environment || ctx.environment?.owner_approved !== true || ctx.environment?.prevent_self_review !== true || ctx.environment?.protected_branch_only !== true) {
      return fail("production_environment_unproven");
    }
  }

  return { ok:true, decision:"ALLOW", executor:ctx.executor_id, action:ctx.action, head_sha:ctx.head_sha };
}
