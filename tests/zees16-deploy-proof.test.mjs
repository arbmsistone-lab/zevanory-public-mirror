// Testes da prova exata do central production deploy no ZEES-16 (22/11/2026).
import test from "node:test";
import assert from "node:assert/strict";
import { pickExactDeployRun, findExactDeployRun, mergeDeployRun, DEPLOY_WORKFLOW_NAME } from "../scripts/zees16_deploy_proof.mjs";
import { evaluatePolicy } from "../worker/evidence-control-plane.mjs";

const SHA = "6c43535d1407333c1d3ad5871c20d416e36e9011";
const OUTRO = "d5e67df73cd3aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const deploy = (over = {}) => ({ id: 44594956355, name: DEPLOY_WORKFLOW_NAME, head_sha: SHA, head_branch: "gh-pages",
  path: ".github/workflows/central-production-deploy.yml", event: "push", status: "completed", conclusion: "success",
  created_at: "2026-11-19T19:07:00Z", updated_at: "2026-11-19T19:20:00Z", ...over });
const ok = (name, i) => ({ id: 1000 + i, name, head_sha: SHA, status: "completed", conclusion: "success",
  created_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22T10:00:00Z" });

// mapa como o reconciliador monta: só a 1ª página (100 execuções) da listagem geral do SHA
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

test("deploy válido fora da 1ª página da listagem geral é recuperado pelo arquivo do workflow e prova P12/P15", async () => {
  // 1ª página: 100 execuções horárias de outros workflows + as demais provas de P12/P15; o deploy está na página 17
  const pagina1 = Array.from({ length: 97 }, (_, i) => ok("ZEVANORY ZEES-16 control reconciler", i))
    .concat([ok("zevanory-p12-observability-exact-release", 900), ok("zevanory-p15-provenance", 901)]);
  const m = mapaPrimeiraPagina(pagina1);
  assert.equal(m.has(DEPLOY_WORKFLOW_NAME), false);
  assert.equal(estado(m, "P12").state, "PARTIAL");
  assert.deepEqual(estado(m, "P15").blockers, ["workflow:ZEVANORY central production deploy"]);
  const urls = [];
  const jf = async (url) => { urls.push(url); return { workflow_runs: [deploy()] }; };
  const run = await findExactDeployRun({ jf, repo: "arbmsistone-lab/zevanory-public-mirror", sha: SHA });
  assert.match(urls[0], /\/actions\/workflows\/central-production-deploy\.yml\/runs\?head_sha=6c43535d1407333c1d3ad5871c20d416e36e9011&per_page=100$/);
  assert.equal(mergeDeployRun(m, run), true);
  assert.equal(estado(m, "P12").state, "PROVADO");
  assert.equal(estado(m, "P15").state, "PROVADO");
});

test("execução de outro SHA é rejeitada, mesmo se a API ignorar o filtro head_sha", async () => {
  const jf = async () => ({ workflow_runs: [deploy({ head_sha: OUTRO, id: 1 })] });
  assert.equal(await findExactDeployRun({ jf, repo: "r/r", sha: SHA }), null);
  const m = new Map();
  assert.equal(mergeDeployRun(m, null), false);
  assert.equal(estado(m, "P12").state === "PROVADO", false);
});

test("requisitos próprios de P12 e P15 continuam exigidos (deploy sozinho não prova)", () => {
  const m = new Map();
  mergeDeployRun(m, deploy());
  assert.deepEqual(estado(m, "P12").blockers, ["workflow:zevanory-p12-observability-exact-release"]);
  assert.deepEqual(estado(m, "P15").blockers, ["workflow:zevanory-p15-provenance"]);
  const semSaude = evaluatePolicy({ signals: { "runtime:exact_sha": true, "runtime:health_ready": false },
    workflows: new Map([[DEPLOY_WORKFLOW_NAME, deploy()], ["zevanory-p12-observability-exact-release", ok("zevanory-p12-observability-exact-release", 1)]]),
    releaseSha: SHA }).pillars.find((p) => p.id === "P12");
  assert.deepEqual(semSaude.blockers, ["runtime:health_ready"]);
});

test("vale o deploy concluído mais recente do SHA: falha depois de um sucesso não prova", () => {
  const r = pickExactDeployRun([deploy(), deploy({ id: 2, conclusion: "failure", updated_at: "2026-11-20T10:00:00Z" })], SHA);
  assert.equal(r.conclusion, "failure");
  const m = new Map(); mergeDeployRun(m, r);
  m.set("zevanory-p15-provenance", ok("zevanory-p15-provenance", 2));
  assert.equal(estado(m, "P15").state, "PARTIAL");
});

test("filtros de origem: outro arquivo, branch, evento ou execução em andamento não contam", () => {
  for (const over of [{ path: ".github/workflows/outro.yml" }, { head_branch: "claude/x" }, { event: "pull_request" },
    { status: "in_progress", conclusion: null }])
    assert.equal(pickExactDeployRun([deploy(over)], SHA), null, JSON.stringify(over));
  assert.equal(pickExactDeployRun([deploy({ event: "workflow_dispatch" })], SHA).event, "workflow_dispatch");
  assert.equal(pickExactDeployRun([deploy()], "nao-e-sha"), null);
});

test("erro de rede/API: nada é acrescentado (falha fechada)", async () => {
  const jf = async () => { throw new Error("fetch 502"); };
  assert.equal(await findExactDeployRun({ jf, repo: "r/r", sha: SHA }), null);
});

test("não rebaixa execução mais nova já presente no mapa", () => {
  const m = new Map([[DEPLOY_WORKFLOW_NAME, deploy({ id: 9, conclusion: "failure", updated_at: "2026-11-21T00:00:00Z" })]]);
  assert.equal(mergeDeployRun(m, deploy()), false);
  assert.equal(m.get(DEPLOY_WORKFLOW_NAME).id, 9);
});

test("16/16 continua exigido: com P12/P15 provados, faltando outros pilares o total não fecha", () => {
  const m = new Map(); mergeDeployRun(m, deploy());
  const s = evaluatePolicy({ signals: sinais, workflows: m, releaseSha: SHA });
  assert.ok(s.counts.proven < 16);
  assert.equal(s.counts.proven + s.counts.partial + s.counts.blocked, 16);
});

test("o reconciliador aplica a busca exata do deploy antes de avaliar a política", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/reconcile_zees16_control.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ findExactDeployRun, mergeDeployRun \} from "\.\/zees16_deploy_proof\.mjs";/);
  const iMerge = src.indexOf("mergeDeployRun(workflows, await findExactDeployRun({jf,repo,sha}));");
  const iEval = src.indexOf("evaluatePolicy({signals,workflows,releaseSha:sha,observedAt})");
  assert.ok(iMerge > 0 && iEval > iMerge);
});
