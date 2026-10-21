/**
 * PROPOSAL ONLY. This module becomes trustworthy only after the owner installs an
 * reviewed copy on the protected default branch. A live collector must run on
 * pull_request_target, never checkout/execute PR code, and use a read-only token.
 */
const safe = async (name, fn, errors) => {
  try { return await fn(); }
  catch (error) { errors.push({operation:name, status:error?.status ?? "unknown"}); return null; }
};

export async function collectEvidence({github, event, runtime, bindingVerifier}) {
  if (runtime.event !== "pull_request_target") throw new Error("trusted_event_required");
  if (!runtime.runsFromProtectedDefaultBranch || runtime.executedPrCode) throw new Error("collector_isolation_required");

  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const number = event.pull_request.number;
  const errors = [];

  const pull = await safe("pull", () => github.getPull({owner,repo,pull_number:number}), errors);
  const files = await safe("files", () => github.listAllFiles({owner,repo,pull_number:number}), errors);
  const reviews = await safe("reviews", () => github.listAllReviews({owner,repo,pull_number:number}), errors);
  const permission = pull && await safe("permission", () => github.getCollaboratorPermission({owner,repo,username:pull.user.login}), errors);
  const appPermissions = pull && await safe("app_permissions", () => github.getEffectiveAppPermissions({owner,repo,actor:pull.user.login}), errors);
  const branch = pull && await safe("branch_protection", () => github.getBranchProtection({owner,repo,branch:pull.base.ref}), errors);
  const environment = await safe("environment", () => github.getEnvironment({owner,repo,environment_name:"production"}), errors);
  const binding = pull && await safe("executor_binding", () => bindingVerifier.verify({
    repository:event.repository.full_name,
    actor:pull.user.login,
    head_sha:pull.head.sha
  }), errors);

  const headMatches = pull?.head?.sha === event.pull_request.head.sha;
  if (!headMatches) errors.push({operation:"integrity", status:"head_sha_mismatch"});

  return {
    schema:"zevanory-trusted-evidence/v1",
    provenance:{
      source:"github_api_readonly",
      status:errors.length ? "incomplete" : "complete",
      api_errors:errors,
      event:runtime.event,
      workflow_ref:runtime.workflowRef,
      workflow_sha:runtime.workflowSha,
      runs_from_protected_default_branch:runtime.runsFromProtectedDefaultBranch,
      executed_pr_code:runtime.executedPrCode,
      event_head_sha:event.pull_request.head.sha
    },
    api:{pull_head_sha:pull?.head?.sha ?? null},
    pr:{
      number,
      author_login:pull?.user?.login ?? null,
      author_type:pull?.user?.type ?? null,
      head_sha:pull?.head?.sha ?? null,
      base_ref:pull?.base?.ref ?? null,
      changed_paths:Array.isArray(files) ? files.map(file => file.filename) : null
    },
    authenticated_principal: binding?.principal ?? null,
    executor_binding: binding ?? null,
    effective_permissions: appPermissions ? {
      status:appPermissions.exhaustive === true ? "complete" : "incomplete",
      exhaustive:appPermissions.exhaustive === true,
      source:"github_api",
      permissions:appPermissions.permissions
    } : null,
    collaborator_permission:permission ?? null,
    reviews:Array.isArray(reviews) ? reviews.map(review => ({
      actor:review.user?.login,
      state:review.state,
      commit_id:review.commit_id,
      dismissed:review.dismissed === true
    })) : null,
    branch_protection:branch ?? {status:"unavailable"},
    environment:environment ?? {status:"unavailable"}
  };
}
