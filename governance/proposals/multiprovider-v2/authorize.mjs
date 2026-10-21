const LEVEL = Object.freeze({none:0, read:1, write:2, admin:3});
const deny = (...reasons) => ({ok:false, decision:"DENY", reasons});
const unproven = (...reasons) => ({ok:false, decision:"NOT_PROVEN", reasons});
const placeholder = value => !value || String(value).startsWith("REPLACE");

function samePrincipal(expected, actual) {
  return actual && expected &&
    actual.type === expected.type &&
    actual.login === expected.login &&
    String(actual.installation_id ?? "") === String(expected.installation_id ?? "");
}

function validateCollector(policy, evidence) {
  const expected = policy.trusted_collector;
  const p = evidence?.provenance;
  if (!p || p.source !== "github_api_readonly") return "collector_provenance_missing";
  if (p.status !== "complete" || (p.api_errors || []).length) return "collector_evidence_incomplete";
  if (p.event !== expected.event || p.workflow_ref !== expected.workflow_ref) return "untrusted_collector_workflow";
  if (placeholder(expected.workflow_sha) || p.workflow_sha !== expected.workflow_sha) return "collector_workflow_sha_unproven";
  if (p.runs_from_protected_default_branch !== true || p.executed_pr_code !== false) return "collector_isolation_unproven";
  if (evidence.pr?.head_sha !== p.event_head_sha || evidence.pr?.head_sha !== evidence.api?.pull_head_sha) return "head_sha_mismatch";
  return null;
}

function validatePermissions(role, snapshot) {
  if (!snapshot || snapshot.status !== "complete" || snapshot.exhaustive !== true || snapshot.source !== "github_api") {
    return "permission_evidence_incomplete";
  }
  const actual = snapshot.permissions;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return "permission_evidence_incomplete";
  for (const [name, level] of Object.entries(actual)) {
    if (!(name in role.permission_allowlist)) return "unknown_permission:" + name;
    if (!(level in LEVEL)) return "unknown_permission_level:" + name;
    if (LEVEL[level] > LEVEL[role.permission_allowlist[name]]) return "excess_permission:" + name;
  }
  for (const [name, required] of Object.entries(role.required_permissions || {})) {
    if (!(name in actual)) return "missing_permission:" + name;
    if (!(actual[name] in LEVEL) || LEVEL[actual[name]] < LEVEL[required]) return "insufficient_permission:" + name;
  }
  return null;
}

function exactOwnerApproval(policy, evidence) {
  const owner = policy.roles.owner.principal.login;
  if (placeholder(owner) || evidence.pr.author_login === owner) return false;
  return (evidence.reviews || []).some(review =>
    review.state === "APPROVED" &&
    review.actor === owner &&
    review.commit_id === evidence.pr.head_sha &&
    review.dismissed !== true
  );
}

export function authorize(policy, evidence) {
  if (policy?.status !== "active") return deny("policy_not_active");
  const collectorFailure = validateCollector(policy, evidence);
  if (collectorFailure) return unproven(collectorFailure);

  const binding = evidence.executor_binding;
  if (!binding || binding.status !== "verified" || binding.source !== "owner_registry_and_external_attestation") {
    return unproven("executor_binding_unproven");
  }
  if (binding.model_identity_status !== "verified") return unproven("model_identity_unproven");

  const role = policy.roles?.[binding.role];
  if (!role) return deny("unknown_executor");
  if (placeholder(role.principal.login) || placeholder(role.principal.installation_id)) return unproven("principal_placeholder");
  if (!samePrincipal(role.principal, evidence.authenticated_principal)) return deny("authenticated_principal_mismatch");
  if (binding.principal_login !== evidence.authenticated_principal.login ||
      String(binding.installation_id) !== String(evidence.authenticated_principal.installation_id)) {
    return deny("executor_binding_mismatch");
  }
  const ownerLogin = policy.roles.owner.principal.login;
  if (binding.role !== "owner" && evidence.authenticated_principal.login === ownerLogin) return deny("shared_owner_identity");

  const action = evidence.requested_action;
  if (!role.actions.includes(action)) return deny("action_not_allowed");
  const permissionFailure = validatePermissions(role, evidence.effective_permissions);
  if (permissionFailure) return deny(permissionFailure);

  if (binding.role === "codex") {
    const paths = evidence.pr.changed_paths;
    if (!Array.isArray(paths) || paths.length === 0) return unproven("changed_paths_missing");
    for (const path of paths) {
      if (policy.codex_forbidden_paths.some(fragment => path.toLowerCase().includes(fragment.toLowerCase()))) {
        return deny("codex_forbidden_path:" + path);
      }
      if (!role.allowed_path_prefixes.some(prefix => path.startsWith(prefix))) return deny("codex_out_of_scope:" + path);
    }
  }

  if (action === "merge") {
    if (!exactOwnerApproval(policy, evidence)) return deny("distinct_owner_exact_head_approval_missing");
    const b = evidence.branch_protection;
    if (!b || b.status !== "complete" || b.pull_request_required !== true ||
        b.code_owner_review_required !== true || b.stale_reviews_dismissed !== true) {
      return unproven("branch_protection_unproven");
    }
  }

  if (action === "deploy") {
    if (!exactOwnerApproval(policy, evidence)) return deny("distinct_owner_exact_head_approval_missing");
    if (!policy.publication.canonical_workflows.includes(evidence.workflow?.path)) return deny("noncanonical_publisher");
    const env = evidence.environment;
    if (!env || env.status !== "complete" || env.name !== policy.publication.environment ||
        env.owner_approved !== true || env.prevent_self_review !== true || env.protected_branch_only !== true) {
      return unproven("production_environment_unproven");
    }
  }

  return {ok:true, decision:"ALLOW", executor:binding.role, action, head_sha:evidence.pr.head_sha};
}
