// M1 (reauditoria do PR #946): a revisão jurídica vale no momento da PUBLICAÇÃO, não só no check de PR.
// scripts/p23/legal_review.py --publish-gate roda nos jobs que publicam /termos e /reembolso e é fail-closed:
// texto idêntico ao já publicado passa; texto novo exige aprovação no formato real para a impressão digital atual.
// Marcadores [Gn.k] identificam a asserção.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
requireTool(PYTHON);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGAL = join(REPO, "scripts/p23/legal_review.py");
const FILES = ["sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html", "data/politica-unica.json", "data/p23/legal-published-baseline.json", "data/p23/legal-reviewers.json"];
const read = (p) => readTextNormalized(p);
const run = (root, ...args) => { const r = spawnSync(PYTHON, ["-I", LEGAL, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
function tree(edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "legal-gate-"));
  for (const rel of FILES) { mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(REPO, rel), join(root, rel)); }
  edit(root);
  return root;
}
const json = (root, rel, fn) => { const p = join(root, rel); const d = JSON.parse(read(p)); fn(d); writeFileSync(p, JSON.stringify(d, null, 2)); };
const fp = (root) => run(root, "--fingerprint").out.trim();
const fingerprint = fp;
// Aprovação no formato real (M1): revisor cadastrado pelo proprietário, nome igual, data ISO, SHA-256 do texto revisado,
// commit, versão do documento e registro auditável versionado com os mesmos campos.
const REVIEWER = { id: "rev-msouza", name: "Maria Clara Souza, OAB/CE 12345", registro: "OAB/CE 12345", github_login: "msouza-adv", authorized_by: "proprietario", authorized_at: "2026-10-20", authorization_commit: "a098d8802a184df02b362d46f08fb6c81b7382f9" };
function approval(root, over = {}, { reviewer = REVIEWER, record = {} } = {}) {
  const sha = fingerprint(root);
  const version = JSON.parse(readTextNormalized(join(root, "data/politica-unica.json"))).legal_document_version;
  const review = { status: "APPROVED", reviewer_id: reviewer ? reviewer.id : "rev-nao-cadastrado", approved_by: reviewer ? reviewer.name : REVIEWER.name, approved_at: "2026-10-27", reviewed_sha256: sha,
    reviewed_commit: "b7671272b1c0b35d1bb7a20fa2489bd7c5a0f224", document_version: version, record: `docs/legal/reviews/${sha}.json`, ...over };
  mkdirSync(join(root, "data/p23"), { recursive: true });
  writeFileSync(join(root, "data/p23/legal-reviewers.json"), JSON.stringify({ schema: "zevanory-legal-reviewers/v1", reviewers: reviewer ? [reviewer] : [] }, null, 2));
  if (record !== null) {
    mkdirSync(join(root, "docs/legal/reviews"), { recursive: true });
    const r = { reviewer_id: review.reviewer_id, reviewed_sha256: review.reviewed_sha256, reviewed_commit: review.reviewed_commit, document_version: review.document_version, approved_at: review.approved_at, decision: "APPROVED", ...record };
    writeFileSync(join(root, `docs/legal/reviews/${sha}.json`), JSON.stringify(r, null, 2));
  }
  return review;
}

test("G1 produção: revisão PENDENTE e texto da Release 2 diferente do publicado -> publicação bloqueada", () => {
  const pol = JSON.parse(read(join(REPO, "data/politica-unica.json")));
  assert.equal(pol.legal_review.status, "PENDING", "[G1.1] a configuração de produção continua PENDING");
  assert.equal(pol.legal_review.approved_by, null, "[G1.1a]");
  assert.deepEqual(JSON.parse(read(join(REPO, "data/p23/legal-reviewers.json"))).reviewers, [], "[G1.1b] nenhum revisor cadastrado ainda: nenhuma aprovação passa");
  const base = JSON.parse(read(join(REPO, "data/p23/legal-published-baseline.json")));
  assert.match(base.fingerprint, /^[0-9a-f]{64}$/, "[G1.2]");
  assert.match(base.source_commit, /^[0-9a-f]{40}$/, "[G1.2a]");
  const r = run(REPO, "--publish-gate");
  assert.equal(r.code, 1, "[G1.3] " + r.out);
  assert.match(r.out, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G1.4]");
  assert.match(r.out, /REVISÃO JURÍDICA PENDENTE/, "[G1.5]");
});

test("G2 texto idêntico ao já publicado passa mesmo com a revisão pendente (nada no ar fica preso)", () => {
  const root = tree((r) => json(r, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = fp(r); }));
  try {
    const r = run(root, "--publish-gate");
    assert.equal(r.code, 0, "[G2.1] " + r.out);
    assert.match(r.out, /LEGAL_PUBLISH_GATE=PASS_UNCHANGED/, "[G2.2]");
    // Uma palavra a mais no texto publicado já é texto novo.
    writeFileSync(join(root, "sales-public/reembolso.html"), read(join(root, "sales-public/reembolso.html")).replace("devolução integral", "devolução quase integral"));
    assert.equal(run(root, "--publish-gate").code, 1, "[G2.3] texto alterado volta a exigir revisão");
    // HTML em volta (nome de asset) não muda a impressão digital.
    const before = fp(root);
    writeFileSync(join(root, "termos/index.html"), read(join(root, "termos/index.html")).replace("</head>", '<link rel="preload" href="/x.css"></head>'));
    assert.equal(fp(root), before, "[G2.4] só o texto conta");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G3 texto novo só publica com aprovação real para a impressão digital atual", () => {
  const cases = [
    [(r) => approval(r), 0, /PASS_APPROVED/, "[G3.1] aprovação válida"],
    [(r) => approval(r, { approved_by: "fixture-jurista" }), 1, /não identifica uma pessoa/, "[G3.2] marcador de teste"],
    [(r) => approval(r, { approved_by: "  " }), 1, /não identifica uma pessoa/, "[G3.3] vazio"],
    [(r) => approval(r, { approved_at: null }), 1, /não é uma data ISO/, "[G3.4] sem data"],
    [(r) => approval(r, { reviewed_sha256: "a".repeat(64) }), 1, /o texto mudou depois da revisão/, "[G3.5] outro texto"],
    [(r) => approval(r, { reviewed_commit: null }), 1, /reviewed_commit/, "[G3.6] sem commit"],
    [(r) => ({ ...approval(r), status: "PENDING" }), 1, /PENDENTE/, "[G3.7] pendente"],
    [(r) => approval(r, {}, { reviewer: null }), 1, /cadastro de revisores autorizados/, "[G3.8] revisor não cadastrado"],
    [(r) => approval(r, {}, { record: null }), 1, /record ausente/, "[G3.9] sem registro auditável"],
    [(r) => approval(r, { document_version: "outra" }), 1, /document_version/, "[G3.10] outra versão"],
  ];
  for (const [review, code, re, label] of cases) {
    const root = tree((r) => json(r, "data/politica-unica.json", (d) => { d.legal_review = review(r); }));
    try {
      const r = run(root, "--publish-gate");
      assert.equal(r.code, code, label + " " + r.out);
      assert.match(r.out, re, label);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("G4 os dois workflows que publicam /termos e /reembolso rodam o portão antes de qualquer deploy, sem desvio", () => {
  for (const [wf, job, firstMutation] of [
    [".github/workflows/zevanory-sales-public-release.yml", "  deploy:", "Materialize release configs"],
    [".github/workflows/central-production-deploy.yml", "  deploy:", "Reconstruct exact production candidate"],
  ]) {
    const y = read(join(REPO, wf));
    const body = y.slice(y.indexOf(job));
    const gate = body.indexOf("scripts/p23/legal_review.py --root . --publish-gate");
    assert.ok(gate > 0, `[G4.1] ${wf}: portão no job deploy`);
    assert.ok(gate < body.indexOf(firstMutation), `[G4.2] ${wf}: portão antes de '${firstMutation}'`);
    assert.ok(gate < body.indexOf("wrangler"), `[G4.3] ${wf}: portão antes do wrangler`);
    const step = body.slice(body.lastIndexOf("- name:", gate), body.indexOf("- name:", gate + 1));
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true|if:/, `[G4.4] ${wf}: o passo não pode ser ignorado`);
  }
});
