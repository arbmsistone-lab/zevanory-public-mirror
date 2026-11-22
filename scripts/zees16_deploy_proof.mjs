// ZEVANORY | ZEES-16: prova do "ZEVANORY central production deploy" para a release EXATA (22/11/2026, r2).
// Por quê: o reconciliador monta o mapa de workflows a partir de UMA página de /actions/runs?head_sha=<sha>&per_page=100.
// O SHA da release acumula milhares de execuções (horárias), e o deploy daquela release some da primeira página; P12 e
// P15 ficavam PARTIAL mesmo com o deploy bem-sucedido. Aqui o deploy é buscado pelo ARQUIVO do workflow e pelo SHA exato.
// r2 (contra-auditoria do titular, 22/11 14:29): TODA evidência de deploy aceita, venha da consulta específica ou da
// listagem geral, passa pela mesma validação; a entrada da listagem geral que não passar é REMOVIDA do mapa.
// Regras (falha fechada; os demais requisitos de P12/P15 e o critério 16/16 não mudam):
//  - só execuções com head_sha === release, path === ".github/workflows/central-production-deploy.yml",
//    head_branch === "gh-pages", evento push ou workflow_dispatch e status completed;
//  - vale a execução concluída MAIS RECENTE desse SHA entre as válidas: se o último deploy válido falhou, o requisito
//    continua não comprovado, mesmo havendo sucesso anterior;
//  - consulta específica indisponível: só a entrada da listagem geral, se válida, pode contar;
//  - r3 (contra-auditoria GPT-6, 22/11 14:41): o workflow pode terminar "success" com o job `deploy` PULADO. A execução
//    escolhida só prova se, NA MESMA TENTATIVA (run_attempt), o job de nome exato "deploy" estiver completed/success.
//    Caso contrário (pulado, falho, ausente, jobs ilegíveis), a entrada fica no mapa com conclusion
//    "deploy_job_<estado>" para registro, e P12/P15 não contam a prova.
export const DEPLOY_WORKFLOW_NAME = "ZEVANORY central production deploy";
export const DEPLOY_WORKFLOW_FILE = "central-production-deploy.yml";
const SHA = /^[0-9a-f]{40}$/;

export function isValidDeployRun(run, sha) {
  return Boolean(SHA.test(sha || "") && run &&
    run.head_sha === sha &&
    String(run.path || "") === ".github/workflows/" + DEPLOY_WORKFLOW_FILE &&
    run.head_branch === "gh-pages" &&
    (run.event === "push" || run.event === "workflow_dispatch") &&
    run.status === "completed");
}

export function pickExactDeployRun(runs, sha) {
  const elegiveis = (Array.isArray(runs) ? runs : []).filter((run) => isValidDeployRun(run, sha));
  elegiveis.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  return elegiveis[0] || null;
}

// Devolve as execuções da consulta específica (array) ou null se a consulta estiver indisponível.
export async function fetchExactDeployRuns({ jf, repo, sha }) {
  if (!SHA.test(sha || "")) return null;
  const url = "https://api.github.com/repos/" + repo + "/actions/workflows/" + encodeURIComponent(DEPLOY_WORKFLOW_FILE) +
    "/runs?head_sha=" + sha + "&per_page=100";
  try {
    const doc = await jf(url);
    return Array.isArray(doc && doc.workflow_runs) ? doc.workflow_runs : null;
  } catch {
    return null;
  }
}

// Única porta de entrada da evidência de deploy no mapa (nome -> execução): considera a entrada da listagem geral e as
// execuções da consulta específica, valida todas e grava só a válida mais recente; sem válida, remove a entrada.
export function applyDeployProof(workflows, exactRuns, sha) {
  const candidatos = [workflows.get(DEPLOY_WORKFLOW_NAME), ...(Array.isArray(exactRuns) ? exactRuns : [])];
  const run = pickExactDeployRun(candidatos, sha);
  if (!run) {
    workflows.delete(DEPLOY_WORKFLOW_NAME);
    return null;
  }
  const origem = Array.isArray(exactRuns) && exactRuns.includes(run) ? "workflow-file+head_sha" : "general-list-validated";
  workflows.set(DEPLOY_WORKFLOW_NAME, { ...run, exact_release_bound: true, lookup: origem });
  return run;
}

export const DEPLOY_JOB_NAME = "deploy";

// Estado do job `deploy` na tentativa da execução: "success", "skipped", "failure", "missing", "unverified"...
export function deployJobState(jobs, run) {
  if (!Array.isArray(jobs) || !run) return "unverified";
  const attempt = Number(run.run_attempt || 1);
  const job = jobs.find((j) => j && j.name === DEPLOY_JOB_NAME && Number(j.run_attempt || 1) === attempt);
  if (!job) return "missing";
  if (job.status !== "completed") return "in_progress";
  return job.conclusion || "unknown";
}

export async function fetchRunAttemptJobs({ jf, repo, run }) {
  if (!run || !Number.isInteger(Number(run.id))) return null;
  const url = "https://api.github.com/repos/" + repo + "/actions/runs/" + run.id + "/attempts/" +
    Number(run.run_attempt || 1) + "/jobs?per_page=100";
  try {
    const doc = await jf(url);
    return Array.isArray(doc && doc.jobs) ? doc.jobs : null;
  } catch {
    return null;
  }
}

// Exige o job `deploy` bem-sucedido na execução já escolhida por applyDeployProof; sem isso, a prova não conta.
export function requireDeployJob(workflows, jobs) {
  const run = workflows.get(DEPLOY_WORKFLOW_NAME);
  if (!run) return null;
  const estado = deployJobState(jobs, run);
  if (estado === "success" && run.conclusion === "success") {
    workflows.set(DEPLOY_WORKFLOW_NAME, { ...run, deploy_job: "success" });
    return true;
  }
  workflows.set(DEPLOY_WORKFLOW_NAME, { ...run, deploy_job: estado,
    conclusion: run.conclusion === "success" ? "deploy_job_" + estado : run.conclusion });
  return false;
}

// Sequência usada pelo reconciliador.
export async function proveExactDeploy({ jf, repo, sha, workflows }) {
  const run = applyDeployProof(workflows, await fetchExactDeployRuns({ jf, repo, sha }), sha);
  if (!run) return false;
  return requireDeployJob(workflows, await fetchRunAttemptJobs({ jf, repo, run }));
}
