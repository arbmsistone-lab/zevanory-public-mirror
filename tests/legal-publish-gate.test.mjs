// M1 + M-A (reauditoria do PR #946, rodadas 2 e 3): a revisão jurídica vale no momento da PUBLICAÇÃO, e as âncoras de
// confiança (cadastro de revisores, linha de base, registros de aprovação, legal_review) vêm do gh-pages já mesclado,
// conferidas no histórico do git. Cada cenário roda num repositório git temporário de verdade ("main" faz o papel do
// gh-pages). As duas forjas do auditor (rodada 3, m1/) são reproduzidas aqui e têm de falhar.
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
requireTool("git");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEGAL = join(REPO, "scripts/p23/legal_review.py");
const GUARD = join(REPO, "scripts/p23/trust_anchor_guard.py");
const FILES = ["sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html", "data/politica-unica.json", "data/p23/legal-published-baseline.json", "data/p23/legal-reviewers.json"];
const read = (p) => readTextNormalized(p);
const PYENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
const py = (script, args) => { const r = spawnSync(PYTHON, ["-I", script, ...args], { encoding: "utf8", env: PYENV }); return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }; };
const gate = (root, ref = "main") => py(LEGAL, ["--root", root, "--publish-gate", ...(ref ? ["--anchors-ref", ref] : [])]);
const fp = (root) => py(LEGAL, ["--root", root, "--fingerprint"]).out.trim();
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.invalid", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.invalid" };
const git = (root, ...args) => { const r = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", env: GIT_ENV }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const json = (root, rel, fn) => { const p = join(root, rel); const d = JSON.parse(read(p)); fn(d); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(d, null, 2)); };
const put = (root, rel, obj) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(obj, null, 2)); };
const commit = (root, msg) => { git(root, "add", "-A"); git(root, "commit", "-q", "--allow-empty", "-m", msg); return git(root, "rev-parse", "HEAD"); };
const word = (root, from, to) => { const p = join(root, "sales-public/termos.html"); writeFileSync(p, read(p).replace(from, to)); };
// Repositório com o texto atual do PR no "gh-pages" (main), revisão PENDENTE e cadastro vazio.
function repo() {
  const root = mkdtempSync(join(tmpdir(), "legal-anchor-"));
  for (const rel of FILES) { mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(REPO, rel), join(root, rel)); }
  git(root, "init", "-q", "-b", "main");
  return { root, text: commit(root, "texto da Release 2 (revisão pendente)") };
}
const REVIEWER = { id: "rev-msouza", name: "Maria Clara Souza, OAB/CE 12345", registro: "OAB/CE 12345", github_login: "msouza-adv", authorized_by: "proprietario", authorized_at: "2026-10-20" };
const register = (root, reviewer = REVIEWER) => { json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = [...(d.reviewers || []), reviewer]; }); return commit(root, "proprietário cadastra o revisor"); };
function approve(root, { textCommit, authCommit, over = {} }) {
  const sha = fp(root);
  const version = JSON.parse(read(join(root, "data/politica-unica.json"))).legal_document_version;
  json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = d.reviewers.map((r) => (r.id === REVIEWER.id && !r.authorization_commit ? { ...r, authorization_commit: authCommit } : r)); });
  const review = { status: "APPROVED", reviewer_id: REVIEWER.id, approved_by: REVIEWER.name, approved_at: "2026-10-27", reviewed_sha256: sha, reviewed_commit: textCommit, document_version: version, record: `docs/legal/reviews/${sha}.json`, ...over };
  json(root, "data/politica-unica.json", (d) => { d.legal_review = review; });
  put(root, review.record, { reviewer_id: review.reviewer_id, reviewed_sha256: review.reviewed_sha256, reviewed_commit: review.reviewed_commit, document_version: review.document_version, approved_at: review.approved_at, decision: "APPROVED" });
  return review;
}

test("G1 produção: revisão PENDENTE, cadastro vazio e texto novo -> publicação bloqueada; sem âncoras do gh-pages também", () => {
  const pol = JSON.parse(read(join(REPO, "data/politica-unica.json")));
  assert.equal(pol.legal_review.status, "PENDING", "[G1.1] a configuração de produção continua PENDING");
  assert.equal(pol.legal_review.approved_by, null, "[G1.1a]");
  assert.deepEqual(JSON.parse(read(join(REPO, "data/p23/legal-reviewers.json"))).reviewers, [], "[G1.1b] nenhum revisor cadastrado ainda");
  const base = JSON.parse(read(join(REPO, "data/p23/legal-published-baseline.json")));
  assert.match(base.fingerprint, /^[0-9a-f]{64}$/, "[G1.2]");
  const { root } = repo();
  try {
    const r = gate(root);
    assert.equal(r.code, 1, "[G1.3] " + r.out);
    assert.match(r.out, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G1.4]");
    assert.match(r.out, /REVISÃO JURÍDICA PENDENTE/, "[G1.5]");
    const noAnchor = gate(root, null);
    assert.equal(noAnchor.code, 1, "[G1.6] sem --anchors-ref o portão não confia na árvore publicada");
    assert.match(noAnchor.out, /--anchors-ref ausente/, "[G1.6a]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G2 fluxo legítimo em dois passos: cadastro num commit do gh-pages, aprovação num commit seguinte; linha de base só com registro válido", () => {
  const { root, text } = repo();
  try {
    const auth = register(root);
    approve(root, { textCommit: text, authCommit: auth });
    commit(root, "aprovação jurídica registrada");
    const ok = gate(root);
    assert.equal(ok.code, 0, "[G2.1] " + ok.out);
    assert.match(ok.out, /PASS_APPROVED/, "[G2.1a]");
    // Depois de publicar, a linha de base passa a ser o texto aprovado: aceita porque é o hash de um registro válido.
    json(root, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = fp(root); });
    commit(root, "linha de base = texto aprovado e publicado");
    const unchanged = gate(root);
    assert.equal(unchanged.code, 0, "[G2.2] " + unchanged.out);
    assert.match(unchanged.out, /PASS_UNCHANGED/, "[G2.2a]");
    // Uma palavra mudada depois da revisão volta a bloquear.
    word(root, "devolução integral", "devolução parcial"); commit(root, "texto alterado");
    assert.equal(gate(root).code, 1, "[G2.3] texto alterado depois da revisão");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G3 forja 1 do auditor: linha de base reescrita com a impressão digital do texto novo -> bloqueada (mesmo mesclada)", () => {
  const { root } = repo();
  try {
    json(root, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = fp(root); });
    commit(root, "forja: linha de base = texto novo");
    const r = gate(root);
    assert.equal(r.code, 1, "[G3.1] " + r.out);
    assert.match(r.out, /linha de base não é o texto pré-Release 2 nem o hash de um registro de aprovação válido/, "[G3.2]");
    assert.doesNotMatch(r.out, /PASS_UNCHANGED/, "[G3.3]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G4 forja 2 do auditor: revisor autocadastrado + APPROVED + registro no mesmo PR -> bloqueada em todas as variantes", () => {
  // (a) exatamente a forja do auditor: authorization_commit = 'a'*40, tudo num commit.
  { const { root, text } = repo();
    try {
      json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = [{ ...REVIEWER, authorization_commit: "a".repeat(40) }]; });
      approve(root, { textCommit: text, authCommit: "a".repeat(40) });
      commit(root, "forja: revisor + aprovação + registro");
      const r = gate(root);
      assert.equal(r.code, 1, "[G4.1] " + r.out);
      assert.match(r.out, /authorization_commit aaaaaaaaaaaa não é o commit do gh-pages que cadastrou este revisor/, "[G4.1a]");
    } finally { rmSync(root, { recursive: true, force: true }); } }
  // (b) mesmo PR com squash: cadastro e aprovação entram no MESMO commit, citando o commit anterior (que não cadastrou ninguém).
  { const { root, text } = repo();
    try {
      json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = [{ ...REVIEWER, authorization_commit: text }]; });
      approve(root, { textCommit: text, authCommit: text });
      commit(root, "squash: revisor + aprovação");
      const r = gate(root);
      assert.equal(r.code, 1, "[G4.2] " + r.out);
      assert.match(r.out, /não é o commit do gh-pages que cadastrou este revisor/, "[G4.2a]");
    } finally { rmSync(root, { recursive: true, force: true }); } }
  // (c) PR ainda não mesclado: o commit publicado não está no gh-pages das âncoras.
  { const { root, text } = repo();
    try {
      git(root, "checkout", "-q", "-b", "pr");
      const auth = register(root);
      approve(root, { textCommit: text, authCommit: auth });
      commit(root, "PR com cadastro e aprovação");
      const r = gate(root, "main");
      assert.equal(r.code, 1, "[G4.3] " + r.out);
      assert.match(r.out, /não está contido no gh-pages das âncoras/, "[G4.3a]");
    } finally { rmSync(root, { recursive: true, force: true }); } }
  // (d) hash declarado sem o texto revisado: reviewed_commit cujo texto não tem aquela impressão digital.
  { const { root, text } = repo();
    try {
      const auth = register(root);
      word(root, "devolução integral", "devolução integral e imediata"); const other = commit(root, "outro texto");
      approve(root, { textCommit: text, authCommit: auth });
      commit(root, "aprovação citando o commit errado");
      const r = gate(root);
      assert.equal(r.code, 1, "[G4.4] " + r.out);
      assert.match(r.out, /o texto desse commit não tem a impressão digital/, "[G4.4a]");
      assert.ok(other);
    } finally { rmSync(root, { recursive: true, force: true }); } }
});

test("G5 approved_at: data futura reprovada; data e hora aceitam no máximo 5 min de diferença de relógio", () => {
  const { root, text } = repo();
  try {
    const auth = register(root);
    const future = new Date(Date.now() + 10 * 60e3).toISOString();
    approve(root, { textCommit: text, authCommit: auth, over: { approved_at: future } });
    commit(root, "aprovação 10 min no futuro");
    assert.match(gate(root).out, /approved_at .* está no futuro/, "[G5.1] 10 min no futuro");
    const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    approve(root, { textCommit: text, authCommit: auth, over: { approved_at: tomorrow } });
    commit(root, "aprovação amanhã");
    assert.match(gate(root).out, /approved_at .* está no futuro/, "[G5.2] dia seguinte");
    const skew = new Date(Date.now() + 2 * 60e3).toISOString();
    approve(root, { textCommit: text, authCommit: auth, over: { approved_at: skew } });
    commit(root, "aprovação com 2 min de diferença");
    assert.doesNotMatch(gate(root).out, /está no futuro/, "[G5.3] diferença de relógio tolerada");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G6 check protegido: PR que altera uma âncora reprova; PR comum passa; linha de base proposta conferida contra a base", () => {
  const { root, text } = repo();
  try {
    const base = text;
    git(root, "checkout", "-q", "-b", "pr-comum"); writeFileSync(join(root, "README.txt"), "x"); const comum = commit(root, "PR sem âncora");
    const ok = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", comum]);
    assert.equal(ok.code, 0, "[G6.1] " + ok.out); assert.match(ok.out, /TRUST_ANCHORS=UNCHANGED/, "[G6.1a]");
    for (const [label, edit] of [
      ["cadastro", (r) => json(r, "data/p23/legal-reviewers.json", (d) => { d.reviewers = [REVIEWER]; })],
      ["linha de base", (r) => json(r, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = "b".repeat(64); })],
      ["registro", (r) => put(r, "docs/legal/reviews/x.json", { decision: "APPROVED" })],
      ["política", (r) => json(r, "data/politica-unica.json", (d) => { d.legal_review.status = "APPROVED"; })],
      ["script do portão", (r) => { mkdirSync(join(r, "scripts/p23"), { recursive: true }); writeFileSync(join(r, "scripts/p23/legal_review.py"), "print('ok')"); }],
    ]) {
      git(root, "checkout", "-q", base); git(root, "checkout", "-q", "-B", "pr-ancora");
      edit(root); const head = commit(root, "PR altera " + label);
      const r = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", head, "--base-repo", REPO]);
      assert.equal(r.code, 1, `[G6.2] ${label}: ${r.out}`);
      assert.match(r.out, /TRUST_ANCHOR_CHANGED/, `[G6.2a] ${label}`);
      if (label === "linha de base") assert.match(r.out, /NÃO corresponde a nenhum registro de aprovação válido na base/, "[G6.3] linha de base proposta sem registro na base");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G7 os dois workflows de publicação leem as âncoras do gh-pages mesclado antes de qualquer deploy; o check protegido roda só código da base", () => {
  for (const [wf, firstMutation] of [
    [".github/workflows/zevanory-sales-public-release.yml", "Materialize release configs"],
    [".github/workflows/central-production-deploy.yml", "Reconstruct exact production candidate"],
  ]) {
    const y = read(join(REPO, wf));
    const body = y.slice(y.indexOf("  deploy:"));
    const gateAt = body.indexOf("scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages");
    assert.ok(gateAt > 0, `[G7.1] ${wf}: portão ancorado no job deploy`);
    assert.ok(body.lastIndexOf("git fetch --no-tags --quiet origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages", gateAt) > 0, `[G7.1a] ${wf}: busca o gh-pages`);
    assert.ok(gateAt < body.indexOf(firstMutation) && gateAt < body.indexOf("wrangler"), `[G7.2] ${wf}: antes de '${firstMutation}' e do wrangler`);
    const step = body.slice(body.lastIndexOf("- name:", gateAt), body.indexOf("- name:", gateAt + 1));
    assert.doesNotMatch(step, /continue-on-error|\|\|\s*true|\bif:/, `[G7.3] ${wf}: o passo não pode ser ignorado`);
  }
  const p = read(join(REPO, ".github/workflows/legal-trust-anchors-protected.yml"));
  assert.match(p, /on:\n  pull_request_target:\n\npermissions:\n  contents: read/, "[G7.4] pull_request_target, só leitura, sem filtro de caminho");
  assert.match(p, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "[G7.5] checkout da base");
  assert.match(p, /python3 -I base\/scripts\/p23\/trust_anchor_guard\.py/, "[G7.6] executa só o guarda da base");
  assert.doesNotMatch(p, /secrets\.|ref: \$\{\{ github\.event\.pull_request\.head|checkout-index|\.\/pr\//, "[G7.7] nenhum segredo, nenhum checkout ou execução do PR");
  assert.doesNotMatch(p.split("jobs:")[1], /^\s+if:/m, "[G7.8] sem if no job: sempre reporta resultado");
});
