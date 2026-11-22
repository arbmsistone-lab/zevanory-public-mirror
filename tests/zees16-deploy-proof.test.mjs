// Testes da prova exata do central production deploy no ZEES-16 (22/11/2026, r3).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { pickExactDeployRun, fetchExactDeployRuns, applyDeployProof, isValidDeployRun, DEPLOY_WORKFLOW_NAME,
  deployJobState, fetchRunAttemptJobs, requireDeployJob, proveExactDeploy } from "../scripts/zees16_deploy_proof.mjs";
import { evaluatePolicy } from "../worker/evidence-control-plane.mjs";

const SHA = "6c43535d1407333c1d3ad5871c20d416e36e9011";
const OUTRO = "d5e67df73cd3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO = "arbmsistone-lab/zevanory-public-mirror";
const deploy = (over = {}) => ({ id: 44594956355, name: DEPLOY_WORKFLOW_NAME, head_sha: SHA, head_branch: "gh-pages",
  path: ".github/workflows/central-production-deploy.yml", event: "push", status: "completed", conclusion: "success",
  created_at: "2026-11-19T19:07:00Z", updated_at: "2026-11-19T19:20:00Z", ...over });
const ok = (name, i) => ({ id: 1000 + i, name, head_sha: SHA, status: "completed", conclusion: "success",
  created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22T10:00:00Z" });
const falhaConsulta = async () => { throw new Error("fetch 502"); };

// mapa como o reconciliador monta: só a 1ª página (100 execuções) da listagem geral do SHA, só por nome
function mapaPrimeiraPagina(runs) {
  const m = new Map();
  for (const run of runs.slice(0, 100)) {
    if (run.head_sha !== SHA || run.status !== "completed") continue;
    const cur = m.get(run.name);
    if (!cur || new Date(run.updated_at) > new Date(cur.updated_at)) m.set(run.name, run);
  }
  return m;
}
const sinais = { "runtime:exact_sha": true, "runtime:health_ready": true };
const estado = (m, id) => evaluatePolicy({ signals: sinais, workflows: m, releaseSha: SHA }).pillars.find((p) => p.id === id);
const provasProprias = () => new Map([["zevanory-p12-observability-exact-release", ok("zevanory-p12-observability-exact-release", 1)],
  ["zevanory-p15-provenance", ok("zevanory-p15-provenance", 2)]]);

test("deploy válido fora da 1ª página da listagem geral é recuperado pelo arquivo do workflow e prova P12/P15", async () => {
  const pagina1 = Array.from({ length: 98 }, (_, i) => ok("ZEVANORY ZEES-16 control reconciler", i))
    .concat([ok("zevanory-p12-observability-exact-release", 900), ok("zevanory-p15-provenance", 901)]);
  const m = mapaPrimeiraPagina(pagina1);
  assert.equal(m.has(DEPLOY_WORKFLOW_NAME), false);
  assert.equal(estado(m, "P12").state, "PARTIAL");
  assert.deepEqual(estado(m, "P15").blockers, ["workflow:ZEVANORY central production deploy"]);
  const urls = [];
  const runs = await fetchExactDeployRuns({ jf: async (u) => { urls.push(u); return { workflow_runs: [deploy()] }; }, repo: REPO, sha: SHA });
  assert.match(urls[0], /\/actions\/workflows\/central-production-deploy\.yml\/runs\?head_sha=6c43535d1407333c1d3ad5871c20d416e36e9011&per_page=100$/);
  assert.equal(applyDeployProof(m, runs, SHA).id, 44594956355);
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).lookup, "workflow-file+head_sha");
  assert.equal(estado(m, "P12").state, "PROVADO");
  assert.equal(estado(m, "P15").state, "PROVADO");
});

test("execução de outro SHA é rejeitada, mesmo se a API ignorar o filtro head_sha", async () => {
  const runs = await fetchExactDeployRuns({ jf: async () => ({ workflow_runs: [deploy({ head_sha: OUTRO, id: 1 })] }), repo: REPO, sha: SHA });
  const m = provasProprias();
  assert.equal(applyDeployProof(m, runs, SHA), null);
  assert.equal(m.has(DEPLOY_WORKFLOW_NAME), false);
  assert.notEqual(estado(m, "P12").state, "PROVADO");
  assert.notEqual(estado(m, "P15").state, "PROVADO");
});

test("consulta específica indisponível + entrada geral INVÁLIDA: a entrada geral é removida e P12/P15 não provam", async () => {
  const invalidas = [{ event: "pull_request" }, { head_branch: "claude/x" }, { path: ".github/workflows/outro.yml" },
    { head_sha: OUTRO }, { status: "in_progress", conclusion: null }, { path: undefined }];
  for (const over of invalidas) {
    const m = provasProprias();
    m.set(DEPLOY_WORKFLOW_NAME, deploy(over));
    const runs = await fetchExactDeployRuns({ jf: falhaConsulta, repo: REPO, sha: SHA });
    assert.equal(runs, null);
    assert.equal(applyDeployProof(m, runs, SHA), null, JSON.stringify(over));
    assert.equal(m.has(DEPLOY_WORKFLOW_NAME), false, JSON.stringify(over));
    assert.deepEqual(estado(m, "P12").blockers, ["workflow:ZEVANORY central production deploy"], JSON.stringify(over));
    assert.deepEqual(estado(m, "P15").blockers, ["workflow:ZEVANORY central production deploy"], JSON.stringify(over));
  }
});

test("consulta específica indisponível + entrada geral VÁLIDA: conta, marcada como validada", async () => {
  const m = provasProprias();
  m.set(DEPLOY_WORKFLOW_NAME, deploy());
  applyDeployProof(m, await fetchExactDeployRuns({ jf: falhaConsulta, repo: REPO, sha: SHA }), SHA);
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).lookup, "general-list-validated");
  assert.equal(estado(m, "P15").state, "PROVADO");
});

test("entrada geral inválida e mais nova não encobre nem substitui o deploy válido da consulta específica", () => {
  const m = provasProprias();
  m.set(DEPLOY_WORKFLOW_NAME, deploy({ id: 7, event: "pull_request", conclusion: "success", updated_at: "2026-11-22T00:00:00Z" }));
  assert.equal(applyDeployProof(m, [deploy()], SHA).id, 44594956355);
  assert.equal(estado(m, "P12").state, "PROVADO");
});

test("resposta da API sem workflow_runs é tratada como indisponível", async () => {
  assert.equal(await fetchExactDeployRuns({ jf: async () => ({ message: "Not Found" }), repo: REPO, sha: SHA }), null);
  assert.equal(await fetchExactDeployRuns({ jf: async () => ({ workflow_runs: [] }), repo: REPO, sha: "nao-e-sha" }), null);
});

test("requisitos próprios de P12 e P15 continuam exigidos (deploy sozinho não prova)", () => {
  const m = new Map();
  applyDeployProof(m, [deploy()], SHA);
  assert.deepEqual(estado(m, "P12").blockers, ["workflow:zevanory-p12-observability-exact-release"]);
  assert.deepEqual(estado(m, "P15").blockers, ["workflow:zevanory-p15-provenance"]);
  const semSaude = evaluatePolicy({ signals: { "runtime:exact_sha": true, "runtime:health_ready": false }, workflows: (() => { const x = provasProprias(); applyDeployProof(x, [deploy()], SHA); return x; })(), releaseSha: SHA }).pillars.find((p) => p.id === "P12");
  assert.deepEqual(semSaude.blockers, ["runtime:health_ready"]);
});

test("vale o deploy válido concluído mais recente do SHA: falha depois de um sucesso não prova (inclui entrada geral)", () => {
  const m = provasProprias();
  m.set(DEPLOY_WORKFLOW_NAME, deploy({ id: 2, conclusion: "failure", updated_at: "2026-11-20T10:00:00Z" }));
  assert.equal(applyDeployProof(m, [deploy()], SHA).conclusion, "failure");
  assert.equal(estado(m, "P15").state, "PARTIAL");
  assert.equal(pickExactDeployRun([deploy(), deploy({ id: 3, conclusion: "failure", updated_at: "2026-11-21T00:00:00Z" })], SHA).id, 3);
});

test("filtros de origem: outro arquivo, branch, evento ou execução em andamento não contam", () => {
  for (const over of [{ path: ".github/workflows/outro.yml" }, { head_branch: "claude/x" }, { event: "pull_request" },
    { event: "schedule" }, { status: "in_progress", conclusion: null }])
    assert.equal(isValidDeployRun(deploy(over), SHA), false, JSON.stringify(over));
  assert.equal(isValidDeployRun(deploy({ event: "workflow_dispatch" }), SHA), true);
  assert.equal(isValidDeployRun(deploy(), "nao-e-sha"), false);
});

test("16/16 continua exigido: com P12/P15 provados, faltando outros pilares o total não fecha", () => {
  const m = provasProprias(); applyDeployProof(m, [deploy()], SHA);
  const s = evaluatePolicy({ signals: sinais, workflows: m, releaseSha: SHA });
  assert.ok(s.counts.proven < 16);
  assert.equal(s.counts.proven + s.counts.partial + s.counts.blocked, 16);
  const wf = readTextNormalized(new URL("../.github/workflows/zees16-control-reconciler.yml", import.meta.url));
  assert.match(wf, /requires exact 16\/16/);
});

test("o reconciliador passa toda evidência de deploy pela validação e pelo job deploy antes de avaliar a política", () => {
  const src = readTextNormalized(new URL("../scripts/reconcile_zees16_control.mjs", import.meta.url));
  assert.match(src, /import \{ proveExactDeploy \} from "\.\/zees16_deploy_proof\.mjs";/);
  const iApply = src.indexOf("await proveExactDeploy({jf,repo,sha,workflows});");
  const iEval = src.indexOf("evaluatePolicy({signals,workflows,releaseSha:sha,observedAt})");
  assert.ok(iApply > 0 && iEval > iApply);
  assert.equal(src.slice(iApply + 10).includes('workflows.set("ZEVANORY central production deploy"'), false);
});

// r3: job `deploy` da tentativa usada como evidência (referência real: run 44594956355, tentativa 1)
const JOBS_44594956355 = [
  { name: "p21_token / interruptor zevanory", status: "completed", conclusion: "success", run_attempt: 1 },
  { name: "guard", status: "completed", conclusion: "success", run_attempt: 1 },
  { name: "deploy", status: "completed", conclusion: "success", run_attempt: 1 }];
const comDeploy = (jobs, over = {}) => { const m = provasProprias(); applyDeployProof(m, [deploy({ run_attempt: 1, ...over })], SHA); requireDeployJob(m, jobs); return m; };

test("referência 44594956355: job deploy success na tentativa 1 → P12/P15 PROVADO", () => {
  const m = comDeploy(JOBS_44594956355);
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).deploy_job, "success");
  assert.equal(estado(m, "P12").state, "PROVADO");
  assert.equal(estado(m, "P15").state, "PROVADO");
});

test("workflow verde com job deploy PULADO não prova P12/P15", () => {
  const jobs = JOBS_44594956355.map((j) => j.name === "deploy" ? { ...j, conclusion: "skipped" } : j);
  const m = comDeploy(jobs);
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).conclusion, "deploy_job_skipped");
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).id, 44594956355);
  assert.deepEqual(estado(m, "P12").blockers, ["workflow:ZEVANORY central production deploy"]);
  assert.deepEqual(estado(m, "P15").blockers, ["workflow:ZEVANORY central production deploy"]);
});

test("job deploy ausente, falho, em andamento, de outra tentativa ou jobs ilegíveis: não prova", () => {
  const casos = [
    [JOBS_44594956355.filter((j) => j.name !== "deploy"), {}, "missing"],
    [JOBS_44594956355.map((j) => j.name === "deploy" ? { ...j, conclusion: "failure" } : j), {}, "failure"],
    [JOBS_44594956355.map((j) => j.name === "deploy" ? { ...j, status: "in_progress", conclusion: null } : j), {}, "in_progress"],
    [JOBS_44594956355, { run_attempt: 2 }, "missing"],
    [null, {}, "unverified"],
    [[{ name: "deploy-preview", status: "completed", conclusion: "success", run_attempt: 1 }], {}, "missing"]];
  for (const [jobs, over, esperado] of casos) {
    const m = comDeploy(jobs, over);
    assert.equal(m.get(DEPLOY_WORKFLOW_NAME).deploy_job, esperado, esperado);
    assert.notEqual(estado(m, "P15").state, "PROVADO", esperado);
  }
  assert.equal(deployJobState(JOBS_44594956355, null), "unverified");
});

test("deploy success no job não salva execução com conclusão de workflow falha", () => {
  const m = comDeploy(JOBS_44594956355, { conclusion: "failure" });
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).conclusion, "failure");
  const m0 = provasProprias(); applyDeployProof(m0, [deploy({ run_attempt: 1, conclusion: "failure" })], SHA);
  assert.equal(requireDeployJob(m0, JOBS_44594956355), false);
  assert.notEqual(estado(m, "P12").state, "PROVADO");
});

test("proveExactDeploy: consulta pelo arquivo + jobs da MESMA tentativa; jobs indisponíveis = não prova", async () => {
  const urls = [];
  const jf = async (u) => { urls.push(u);
    if (u.includes("/actions/workflows/")) return { workflow_runs: [deploy({ run_attempt: 1 })] };
    if (u.includes("/attempts/1/jobs")) return { jobs: JOBS_44594956355 };
    throw new Error("url inesperada " + u); };
  const m = provasProprias();
  assert.equal(await proveExactDeploy({ jf, repo: REPO, sha: SHA, workflows: m }), true);
  assert.match(urls[1], /\/actions\/runs\/44594956355\/attempts\/1\/jobs\?per_page=100$/);
  assert.equal(estado(m, "P12").state, "PROVADO");
  const m2 = provasProprias();
  const jf2 = async (u) => { if (u.includes("/actions/workflows/")) return { workflow_runs: [deploy({ run_attempt: 1 })] }; throw new Error("502"); };
  assert.equal(await proveExactDeploy({ jf: jf2, repo: REPO, sha: SHA, workflows: m2 }), false);
  assert.equal(m2.get(DEPLOY_WORKFLOW_NAME).conclusion, "deploy_job_unverified");
  assert.notEqual(estado(m2, "P12").state, "PROVADO");
  assert.equal(await fetchRunAttemptJobs({ jf: async () => ({ message: "x" }), repo: REPO, run: deploy() }), null);
  const visto = [];
  await fetchRunAttemptJobs({ jf: async (u) => { visto.push(u); return { jobs: [] }; }, repo: REPO, run: deploy({ run_attempt: 2 }) });
  assert.match(visto[0], /\/actions\/runs\/44594956355\/attempts\/2\/jobs\?per_page=100$/);
});

test("16/16 continua exigido com o job deploy verificado", () => {
  const s = evaluatePolicy({ signals: sinais, workflows: comDeploy(JOBS_44594956355), releaseSha: SHA });
  assert.ok(s.counts.proven < 16);
});
