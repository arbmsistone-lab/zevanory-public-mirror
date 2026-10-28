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
const FILES = ["sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html", "sales-public/privacidade.html", "sales-public/afiliados.html", "privacidade/index.html", "afiliados/index.html", "data/politica-unica.json", "data/p23/legal-published-baseline.json", "data/p23/legal-reviewers.json",
  ".github/workflows/zevanory-sales-public-release.yml", ".github/workflows/central-production-deploy.yml", "data/p23/ecommerce-legal-checklist.json",
  ...["sales-worker.mjs", "worker/sales-public-worker.mjs", "worker/politica-unica.mjs", "wrangler.sales.toml"]];
// Rodada 5: a impressão digital cobre os bytes dos assets das páginas jurídicas (CSS, fontes, imagens): as fixtures copiam.
{ const r = spawnSync(PYTHON, ["-I", LEGAL, "--root", REPO, "--artifact-files"], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  for (const rel of r.stdout.split("\n").map((x) => x.trim()).filter(Boolean)) if (!FILES.includes(rel)) FILES.push(rel); }
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
    assert.match(ok.out, /LEGAL_APPROVAL_LEVEL=PROFESSIONAL \(revisão de advogado\(a\) com registro na OAB\)/, "[G2.1b] nível profissional impresso");
    assert.doesNotMatch(ok.out, /INTERNAL_OWNER/, "[G2.1c]");
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
  // (e) registro de aprovação gravado ANTES do cadastro do revisor (fora de ordem): bloqueada.
  { const { root, text } = repo();
    try {
      const sha = fp(root);
      put(root, `docs/legal/reviews/${sha}.json`, { placeholder: true }); commit(root, "registro antes do cadastro");
      const auth = register(root);
      approve(root, { textCommit: text, authCommit: auth });
      commit(root, "aprovação");
      const r = gate(root);
      assert.equal(r.code, 1, "[G4.5] " + r.out);
      assert.match(r.out, /tem de entrar no gh-pages num commit posterior ao authorization_commit/, "[G4.5a]");
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
    // MED-1 (rodada 4): os workflows de deploy são âncoras; qualquer neutralização do passo do portão reprova, e um
    // workflow NOVO que publica também. Variantes do auditor (tools/ma-attacks.sh): coe, ift, ortrue, newwf.
    const SALES = ".github/workflows/zevanory-sales-public-release.yml", CENTRAL = ".github/workflows/central-production-deploy.yml";
    const GATE_NAME = "      - name: Legal artifact gate (fail fast)";
    const GL = "--anchors-ref refs/remotes/origin/gh-pages";
    const edit = (rel, fn) => { const f = join(root, rel); writeFileSync(f, fn(read(f))); };
    for (const [label, change, title] of [
      ["coe", () => edit(SALES, (t) => t.replace(GATE_NAME, GATE_NAME + "\n        continue-on-error: true")), /LEGAL_GATE_INVALID/],
      ["ift", () => edit(SALES, (t) => t.replace(GATE_NAME, GATE_NAME + "        if: ${{ false }}\n")), /LEGAL_GATE_INVALID/],
      ["ortrue", () => edit(SALES, (t) => t.replace(GL + "\n", GL + " || true\n")), /LEGAL_GATE_INVALID/],
      ["newwf", () => { mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/x.yml"), "name: x\non: {push: {branches: [gh-pages]}}\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: python3 scripts/build_sales_public.py && npx --yes wrangler@4.143.0 deploy --config wrangler.sales.deploy.toml\n"); }, /TRUST_ANCHOR_CHANGED::\.github\/workflows\/x\.yml/],
      ["newwf-env", () => { mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/y.yml"), "name: y\non: push\njobs:\n  d:\n    environment: producao-critica\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/qualquer.sh\n"); }, /TRUST_ANCHOR_CHANGED::\.github\/workflows\/y\.yml/],
    ]) {
      git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-wf");
      change(); const head = commit(root, "PR " + label);
      const r = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", head]);
      assert.equal(r.code, 1, `[G6.4] ${label}: ${r.out}`);
      assert.match(r.out, /TRUST_ANCHORS=CHANGED/, `[G6.4a] ${label}`);
      assert.match(r.out, title, `[G6.4b] ${label}`);
    }
    // Mudança inócua num workflow de deploy (só um comentário): é âncora, reprova como TRUST_ANCHOR_CHANGED.
    git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-wf-comment");
    edit(CENTRAL, (t) => t.replace("\njobs:\n", "\n# comentário inócuo\njobs:\n"));
    const cHead = commit(root, "PR comenta o workflow de deploy");
    const c = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", cHead]);
    assert.equal(c.code, 1, "[G6.6] " + c.out);
    assert.match(c.out, /TRUST_ANCHOR_CHANGED::\.github\/workflows\/central-production-deploy\.yml/, "[G6.6a] workflow de deploy é âncora");
    assert.doesNotMatch(c.out, /LEGAL_GATE_INVALID/, "[G6.6b] a estrutura continua válida");
    // Rodada 5: QUALQUER workflow novo ou alterado é âncora, mesmo sem deploy (a detecção de deploy é só informativa).
    git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-wf-ok");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/z.yml"), "name: z\non: pull_request\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx --yes wrangler@4.143.0 deploy --dry-run --config wrangler.sales.toml\n");
    const okHead = commit(root, "PR workflow sem deploy real");
    const ok2 = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", okHead]);
    assert.equal(ok2.code, 1, "[G6.5] " + ok2.out);
    assert.match(ok2.out, /TRUST_ANCHOR_CHANGED::\.github\/workflows\/z\.yml/, "[G6.5a]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G7 rodadas 6 e 7: build sem segredo, deploy sem código de build; o portão vem do gh-pages e roda antes de qualquer segredo", () => {
  for (const [wf, builds] of [
    [".github/workflows/zevanory-sales-public-release.yml", ["worker-bundle", "site-build"]],
    [".github/workflows/central-production-deploy.yml", ["build"]],
  ]) {
    const y = read(join(REPO, wf));
    const job = (name) => { const i = y.indexOf(`\n  ${name}:\n`); assert.ok(i > 0, `[G7.0] ${wf}: job ${name}`); const rest = y.slice(i + 1); const j = rest.slice(3).search(/\n  [a-z][\w-]*:\n/); return j < 0 ? rest : rest.slice(0, j + 3); };
    for (const b of builds) {
      const t = job(b);
      assert.doesNotMatch(t, /secrets\./, `[G7.1] ${wf}: o job ${b} não recebe segredo`);
      assert.doesNotMatch(t, /environment:/, `[G7.1a] ${wf}: o job ${b} não usa o Environment`);
      assert.match(t, /permissions:\n      contents: read\n/, `[G7.1b] ${wf}: ${b} só lê`);
    }
    const d = job("deploy");
    if (wf.includes("central")) {
      // Sol ORDEM 312: o deploy central nunca é bloqueado pelo portão jurídico.
      assert.doesNotMatch(y, /legal_review\.py|legal_gate\.py|--publish-gate|--apply-snapshot/, `[G7.22] ${wf}: nenhum portão jurídico no central`);
      assert.ok(d.indexOf("sha256sum --strict -c") > 0 && d.indexOf("sha256sum --strict -c") < d.indexOf("secrets."), `[G7.23] ${wf}: manifesto antes de qualquer segredo`);
      const reproC = d.indexOf('/usr/bin/python3 -I "$RUNNER_TEMP/clean_bundle.py" central --repo base');
      assert.ok(reproC > 0 && reproC < d.indexOf("secrets."), `[G7.24] ${wf}: reconstrução limpa antes de qualquer segredo`);
      continue;
    }
    assert.doesNotMatch(d.split("steps:")[0], /secrets\./, `[G7.2] ${wf}: nenhum segredo no env do job deploy`);
    assert.match(d, /path: base\n          fetch-depth: 0\n          persist-credentials: false/, `[G7.3] ${wf}: checkout confiável em base/ sem credencial`);
    const gateAt = d.indexOf('/usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root base --publish-gate --anchors-ref refs/remotes/origin/gh-pages');
    assert.ok(gateAt > 0, `[G7.4] ${wf}: portão no job deploy`);
    assert.ok(d.lastIndexOf('/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"', gateAt) > 0, `[G7.5] ${wf}: código do portão vem do gh-pages`);
    assert.ok(gateAt < d.indexOf("secrets."), `[G7.6] ${wf}: portão antes de qualquer segredo`);
    assert.doesNotMatch(d, /git fetch[^\n]*origin|remote\.origin\.url/, `[G7.7] ${wf}: o deploy não confia em remote.origin.url`);
    const deployLines = d.split("\n").filter((x) => /wrangler@4\.143\.0 deploy/.test(x));
    assert.ok(deployLines.length >= 1, `[G7.8] ${wf}: há deploy no job deploy`);
    for (const l of deployLines) assert.match(l, /--no-bundle/, `[G7.8a] ${wf}: deploy sem rebuild: ${l.trim()}`);
    assert.doesNotMatch(d, /build_sales_public|prepare-central-candidate|materialize|--dry-run|--outdir/, `[G7.9] ${wf}: nenhum código de build nem empacotamento no deploy`);
    // Rodada 7 (M-1): reconstrução limpa no deploy, com o código do gh-pages, comparada byte a byte com o artefato,
    // antes do portão; npm sem configuração herdada.
    const kind = wf.includes("sales") ? "sales" : "central";
    const reproAt = d.indexOf(`/usr/bin/python3 -I "$RUNNER_TEMP/clean_bundle.py" ${kind} --repo base --rev "$GITHUB_SHA"`);
    assert.ok(reproAt > 0 && reproAt < gateAt, `[G7.15] ${wf}: reconstrução limpa antes do portão`);
    const snapAt = d.indexOf('/usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root base --apply-snapshot art/site/sales-public --anchors-ref refs/remotes/origin/gh-pages');
    assert.ok(snapAt > reproAt && snapAt < gateAt, `[G7.25] ${wf}: snapshot jurídico aprovado aplicado antes do portão`);
    assert.ok(d.lastIndexOf('/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/deploy/clean_bundle.py > "$RUNNER_TEMP/clean_bundle.py"', reproAt) > 0, `[G7.16] ${wf}: clean_bundle.py vem do gh-pages`);
    assert.match(d.slice(reproAt).split("\n")[0], / --verify art\/(worker|central)$/, `[G7.17] ${wf}: compara com o artefato`);
    assert.match(d, /\n      npm_config_userconfig: \/dev\/null\n      npm_config_registry: https:\/\/registry\.npmjs\.org\n/, `[G7.18] ${wf}: npm sem configuração herdada`);
    const b = job(builds[0]);
    const firstRun = b.indexOf("run: |");
    assert.ok(firstRun > 0 && b.slice(firstRun, firstRun + 200).includes(`/usr/bin/python3 -I scripts/deploy/clean_bundle.py ${kind} --repo . --rev "$GITHUB_SHA"`), `[G7.19] ${wf}: o primeiro passo run do build é o empacotamento limpo`);
    assert.ok(b.indexOf("actions/upload-artifact@") > firstRun && b.indexOf("actions/upload-artifact@") < b.indexOf("run: |", firstRun + 6) || b.indexOf("run: |", firstRun + 6) < 0, `[G7.20] ${wf}: upload logo depois do empacotamento limpo`);
    assert.doesNotMatch(b.slice(0, b.indexOf("actions/upload-artifact@")), /npx|node --test|npm /, `[G7.21] ${wf}: nada de npx/testes antes do upload`);
  }
  const p = read(join(REPO, ".github/workflows/legal-trust-anchors-protected.yml"));
  assert.match(p, /on:\n  pull_request_target:\n\npermissions:\n  contents: read/, "[G7.10] pull_request_target, só leitura, sem filtro de caminho");
  assert.match(p, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, "[G7.11] checkout da base");
  assert.match(p, /python3 -I base\/scripts\/p23\/trust_anchor_guard\.py/, "[G7.12] executa só o guarda da base");
  assert.doesNotMatch(p, /secrets\.|ref: \$\{\{ github\.event\.pull_request\.head|checkout-index|\.\/pr\//, "[G7.13] nenhum segredo, nenhum checkout ou execução do PR");
  assert.doesNotMatch(p.split("jobs:")[1], /^\s+if:/m, "[G7.14] sem if no job: sempre reporta resultado");
});

test("G8 MED-2: a impressão digital cobre TODO o texto visível; isca em comentário, texto depois de </main> e dois <main> não passam", () => {
  const { root } = repo();
  try {
    const fp0 = fp(root);
    const termos = join(root, "termos/index.html");
    const original = read(termos);
    const swap = (fn) => { writeFileSync(termos, fn(original)); const v = py(LEGAL, ["--root", root, "--fingerprint"]); writeFileSync(termos, original); return v; };
    // A1 do auditor: o <main> antigo dentro de um comentário e um <main> novo com cláusula não revisada.
    const a1 = swap((h) => h.replace(/<main\b[^>]*>[\s\S]*?<\/main>/, (m) => "<!--" + m + "--><main><h1>Termos</h1><p>CLÁUSULA NOVA NÃO REVISADA: nenhum reembolso.</p></main>"));
    assert.equal(a1.code, 0, "[G8.1] " + a1.out);
    assert.notEqual(a1.out.trim(), fp0, "[G8.1a] isca em comentário muda a impressão digital");
    // A1b: texto visível depois de </main>.
    const a1b = swap((h) => h.replace("</main>", "</main><section><h2>11. Nova</h2><p>Sem reembolso.</p></section>"));
    assert.notEqual(a1b.out.trim(), fp0, "[G8.2] texto depois de </main> muda a impressão digital");
    // Texto antes de <main> também conta.
    const pre = swap((h) => h.replace(/<main\b/, "<p>Aviso novo fora do main.</p><main"));
    assert.notEqual(pre.out.trim(), fp0, "[G8.3] texto antes de <main> muda a impressão digital");
    // Dois <main> (fora de comentário) reprovam com erro explícito.
    // Dois <main> (fora de comentário) numa página SERVIDA reprovam com erro explícito.
    const served = join(root, "sales-public/termos.html"), servedOrig = read(served);
    writeFileSync(served, servedOrig.replace("</main>", "</main><main><p>x</p></main>"));
    const two = py(LEGAL, ["--root", root, "--fingerprint"]);
    writeFileSync(served, servedOrig);
    assert.notEqual(two.code, 0, "[G8.4] dois <main> reprovam");
    assert.match(two.out, /LEGAL_FINGERPRINT_MAIN_INVALID sales-public\/termos.html/, "[G8.4a]");
    // Rodada 5: a impressão digital é por BYTES; até um comentário muda (nada passa sem revisão).
    const com = swap((h) => h.replace("</main>", "<!-- nota interna --></main>"));
    assert.notEqual(com.out.trim(), fp0, "[G8.5] qualquer byte muda a impressão digital");
    // Portão: a isca A1 mesclada no gh-pages não passa como texto publicado.
    writeFileSync(termos, original.replace(/<main\b[^>]*>[\s\S]*?<\/main>/, (m) => "<!--" + m + "--><main><p>CLÁUSULA NOVA</p></main>"));
    commit(root, "isca A1");
    const g = gate(root);
    assert.equal(g.code, 1, "[G8.6] " + g.out);
    assert.doesNotMatch(g.out, /PASS_UNCHANGED/, "[G8.6a]");
    // P23: o visible() do checklist também ignora a isca em comentário.
    const vis = spawnSync(PYTHON, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import ecommerce_legal_gate as g; print(g.visible(sys.argv[2]))", join(REPO, "scripts/p23"), "<!--<main><p>ISCA</p></main>--><main><p>REAL</p></main>"], { encoding: "utf8", env: PYENV });
    assert.equal(vis.status, 0, "[G8.7] " + vis.stderr);
    assert.equal(vis.stdout.trim(), "REAL", "[G8.7a] P23 visible() sem o texto do comentário");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G9 reviewed_commit tem de estar no gh-pages: commit de outro branch com o MESMO texto não serve", () => {
  const { root, text } = repo();
  try {
    git(root, "checkout", "-q", "-b", "outro"); writeFileSync(join(root, "README.txt"), "x"); const side = commit(root, "outro branch, mesmo texto");
    git(root, "checkout", "-q", "main");
    const auth = register(root);
    approve(root, { textCommit: side, authCommit: auth });
    commit(root, "aprovação citando commit fora do gh-pages");
    const r = gate(root);
    assert.equal(r.code, 1, "[G9.1] " + r.out);
    assert.match(r.out, /reviewed_commit [0-9a-f]{12} não é um commit do gh-pages/, "[G9.2]");
    assert.ok(text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G10 linha de base e legal_review vêm das âncoras (gh-pages à frente), nunca da árvore em publicação", () => {
  const { root, text: c0 } = repo();
  try {
    const auth = register(root);
    approve(root, { textCommit: c0, authCommit: auth });
    json(root, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = fp(root); });
    const c1 = commit(root, "T1 aprovado e publicado");
    assert.equal(gate(root).code, 0, "[G10.0] T1 publicado passa");
    word(root, "devolução integral", "devolução integral e imediata"); const c2 = commit(root, "T2");
    approve(root, { textCommit: c2, authCommit: auth }); commit(root, "T2 aprovado");
    json(root, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = fp(root); }); commit(root, "T2 publicado");
    assert.equal(gate(root).code, 0, "[G10.1] T2 publicado passa");
    // Deploy da árvore antiga (c1: T1, linha de base T1 e legal_review T1 NA ÁRVORE) com o gh-pages já em T2.
    // Sol ORDEM 312: T1 tem registro de aprovação válido NO gh-pages, então a árvore antiga serve um snapshot aprovado.
    git(root, "checkout", "-q", c1);
    const r = gate(root, "main");
    assert.equal(r.code, 0, "[G10.2] T1 aprovado no gh-pages: " + r.out);
    assert.match(r.out, /LEGAL_SERVED=APPROVED_SNAPSHOT/, "[G10.2a] servido como snapshot aprovado, pela âncora do gh-pages");
    // Sem o registro de T1 no gh-pages, a árvore antiga não se autoriza com a própria linha de base/legal_review.
    git(root, "checkout", "-q", "main");
    const t1 = JSON.parse(read(join(root, "data/politica-unica.json"))).legal_review; void t1;
    const recs = spawnSync("git", ["-C", root, "ls-tree", "--name-only", "c1:docs/legal/reviews".replace("c1", c1)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    for (const n of recs) git(root, "rm", "-q", `docs/legal/reviews/${n}`);
    commit(root, "gh-pages sem o registro de T1");
    git(root, "checkout", "-q", c1);
    const r2 = gate(root, "main");
    assert.equal(r2.code, 1, "[G10.3] a árvore antiga não se autoriza sozinha: " + r2.out);
    assert.match(r2.out, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G10.3a]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G11 validação estrutural (rodadas 6 e 7): o real passa; segredo no build, código no deploy, rebuild e cada neutralização reprovam", () => {
  const dir = mkdtempSync(join(tmpdir(), "legal-wf-"));
  try {
    const SALES = ".github/workflows/zevanory-sales-public-release.yml", CENTRAL = ".github/workflows/central-production-deploy.yml";
    const orig = { [SALES]: read(join(REPO, SALES)), [CENTRAL]: read(join(REPO, CENTRAL)) };
    const run = (over = {}) => {
      for (const [rel, text] of Object.entries({ ...orig, ...over })) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); }
      return py(GUARD, ["--validate-workflows", "--root", dir]);
    };
    const real = run();
    assert.equal(real.code, 0, "[G11.1] " + real.out);
    assert.match(real.out, /LEGAL_GATE_WORKFLOWS=VALID/, "[G11.1a]");
    const GATE_NAME = "      - name: Legal artifact gate (fail fast)\n";
    const GL = "--anchors-ref refs/remotes/origin/gh-pages";
    const DEPLOY_SALES = "      - name: Deploy isolated candidate\n";
    const TOKEN = "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}\n";
    for (const [label, rel, fn] of [
      // Mutações pedidas pela rodada 6.
      ["segredo no job de build (site-build)", SALES, (t) => t.replace("      - name: Build exact release assets\n", "      - name: Build exact release assets\n        env:\n" + TOKEN)],
      ["segredo no job de build (central)", CENTRAL, (t) => t.replace("      - name: Zero-cost guard (owner rule, fail closed before any deploy)\n", "      - name: Zero-cost guard (owner rule, fail closed before any deploy)\n        env:\n" + TOKEN)],
      ["segredo no env do job deploy", SALES, (t) => t.replace('      SCRIPT_NAME: "zevanory-sales-public"\n', '      SCRIPT_NAME: "zevanory-sales-public"\n' + TOKEN.replace("          ", "      "))],
      ["código do repositório no deploy (build)", SALES, (t) => t.replace(GATE_NAME, "      - name: Rebuild\n        run: python3 scripts/build_sales_public.py\n" + GATE_NAME)],
      ["código não âncora no deploy", CENTRAL, (t) => t.replace("/usr/bin/python3 -I base/scripts/deploy/inspect-kv.py", "/usr/bin/python3 -I base/scripts/sales_policy.py")],
      ["código de worker/ no deploy", CENTRAL, (t) => t.replace("/usr/bin/python3 -I base/scripts/deploy/inspect-kv.py", "node base/worker/funnel.mjs")],
      ["rebuild no deploy (sem --no-bundle)", SALES, (t) => t.replace("deploy --config wrangler.sales.preview.toml --no-bundle", "deploy --config wrangler.sales.preview.toml")],
      ["rebuild no deploy (central)", CENTRAL, (t) => t.replace('deploy --no-bundle "$@"', 'deploy "$@"')],
      ["empacotar no deploy (--dry-run --outdir)", SALES, (t) => t.replace('npx --yes wrangler@4.143.0 deploy --config wrangler.sales.preview.toml --no-bundle', 'npx --yes wrangler@4.143.0 deploy --config wrangler.sales.preview.toml --no-bundle --dry-run --outdir x')],
      ["wrangler fora do diretório limpo (repositório)", SALES, (t) => t.replace('cd "$RUNNER_TEMP/release"\n          npx --yes wrangler@4.143.0 deploy --config wrangler.sales.preview.toml --no-bundle', 'cd base\n          npx --yes wrangler@4.143.0 deploy --config wrangler.sales.preview.toml --no-bundle')],
      ["npx de outro pacote no deploy", CENTRAL, (t) => t.replace("npx --yes wrangler@4.143.0 whoami", "npx --yes some-tool@1.0.0 whoami")],
      ["wrangler sem versão fixada no deploy", CENTRAL, (t) => t.replace("npx --yes wrangler@4.143.0 whoami", "npx --yes wrangler whoami")],
      ["npm de dependência do repositório no deploy", CENTRAL, (t) => t.replace('npm install --no-save --no-audit --no-fund --prefix "$RUNNER_TEMP/pw" playwright@1.55.0', "npm ci")],
      ["checkout do deploy sem path base", SALES, (t) => t.replace("          ref: ${{ github.sha }}\n          path: base\n", "          ref: ${{ github.sha }}\n")],
      ["checkout do deploy guardando credencial", CENTRAL, (t) => { const a = "          path: base\n          fetch-depth: 0\n          persist-credentials: false\n      - uses: actions/download-artifact", i = t.lastIndexOf(a); return i < 0 ? t : t.slice(0, i) + a.replace("          persist-credentials: false\n", "") + t.slice(i + a.length); }],
      ["action sem SHA fixado", SALES, (t) => t.replace("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "actions/download-artifact@v4")],
      ["setup-python no deploy", CENTRAL, (t) => t.replace("      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n        with:\n          name: central-release-${{ github.sha }}\n          path: art/central\n      - name: Verify the release manifest", "      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065\n      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n        with:\n          name: central-release-${{ github.sha }}\n          path: art/central\n      - name: Verify the release manifest")],
      ["build sem permissions só de leitura", SALES, (t) => t.replace("    timeout-minutes: 10\n    permissions:\n      contents: read\n    outputs:\n      manifest: ${{ steps.pack.outputs.manifest }}\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: false\n\n      - uses: actions/setup-python", "    timeout-minutes: 10\n    permissions:\n      contents: write\n    outputs:\n      manifest: ${{ steps.pack.outputs.manifest }}\n    steps:\n      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\n        with:\n          persist-credentials: false\n\n      - uses: actions/setup-python")],
      ["worker-bundle executa código não âncora", SALES, (t) => t.replace('--out "$GITHUB_WORKSPACE/worker-artifact"\n', '--out "$GITHUB_WORKSPACE/worker-artifact"\n          python3 scripts/build_sales_public.py\n')],
      // Rodada 7 (M-1): o bundle publicado fica preso às fontes ancoradas do commit.
      ["r7 bundle no checkout com npx (forma da rodada 6)", SALES, (t) => t.replace('/usr/bin/python3 -I scripts/deploy/clean_bundle.py sales --repo . --rev "$GITHUB_SHA" --tools "$RUNNER_TEMP" --work "$RUNNER_TEMP/clean" --out "$GITHUB_WORKSPACE/worker-artifact"', 'npx --yes wrangler@4.143.0 deploy --dry-run --strict --config wrangler.sales.deploy.toml --outdir "$GITHUB_WORKSPACE/worker-artifact"')],
      ["r7 teste antes do empacotamento limpo (central)", CENTRAL, (t) => t.replace("      - name: Build the release in a clean directory from the commit (before any test)\n", "      - name: Tests first\n        run: node --test tests/funnel.test.mjs\n      - name: Build the release in a clean directory from the commit (before any test)\n")],
      ["r7 upload depois dos testes (central)", CENTRAL, (t) => t.replace("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: central-release-", "      - name: Tests before upload\n        run: node --test tests/funnel.test.mjs\n      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: central-release-")],
      ["r7 deploy sem reconstrução limpa", SALES, (t) => t.replace(/      - name: Rebuild the Worker from base in a clean directory and compare byte for byte\n        run: \|\n(?:          [^\n]*\n)+\n/, "")],
      ["r7 reconstrução sem --verify", SALES, (t) => t.replace('--out "$RUNNER_TEMP/repro" --verify art/worker\n', '--out "$RUNNER_TEMP/repro"\n')],
      ["r7 clean_bundle.py lido da árvore no deploy", CENTRAL, (t) => t.replace('/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/deploy/clean_bundle.py > "$RUNNER_TEMP/clean_bundle.py"', 'cp base/scripts/deploy/clean_bundle.py "$RUNNER_TEMP/clean_bundle.py"')],
      ["r7 reconstrução depois do primeiro segredo (central)", CENTRAL, (t) => { const m = t.match(/      - name: Rebuild the release from base in a clean directory and compare byte for byte\n(?:        [^\n]*\n)+/); return m ? t.replace(m[0], "").replace("      - name: Authenticate Cloudflare\n", m[0] + "      - name: Authenticate Cloudflare\n") : t; }],
      ["r7 segredo no passo de reconstrução", CENTRAL, (t) => t.replace("      - name: Rebuild the release from base in a clean directory and compare byte for byte\n        env:\n", "      - name: Rebuild the release from base in a clean directory and compare byte for byte\n        env:\n" + TOKEN)],
      ["r7 npm com configuração do usuário no deploy", SALES, (t) => t.replace("      npm_config_userconfig: /dev/null\n", "")],
      // Rodada 8 (LOW-2): o ensaio também compara com o artefato.
      ["r8 ensaio central sem --verify", CENTRAL, (t) => t.replace('/usr/bin/python3 -I base/scripts/deploy/clean_bundle.py central --repo base --rev "$GITHUB_SHA" --tools "$RUNNER_TEMP" --work "$RUNNER_TEMP/clean" --out "$RUNNER_TEMP/repro" --verify art/central', '/usr/bin/python3 -I base/scripts/deploy/clean_bundle.py central --repo base --rev "$GITHUB_SHA" --tools "$RUNNER_TEMP" --work "$RUNNER_TEMP/clean" --out "$RUNNER_TEMP/repro"')],
      ["r9 --rehearsal no portão do deploy", SALES, (t) => t.replace(GL + "\n", GL + " --rehearsal\n")],
      ["r9 ensaio central sem checar o resultado do build", CENTRAL, (t) => t.replace("if: ${{ !cancelled() && needs.build.result == 'success' && github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run' }}", "if: ${{ always() && github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run' }}")],
      // Sol ORDEM 312.
      ["o12 portão jurídico bloqueando o central", CENTRAL, (t) => t.replace("      - name: Assemble the release directory (pre-built bundle, assets; no repository code)\n", "      - name: Legal artifact gate (fail fast)\n        run: |\n          set -euo pipefail\n          test \"$(/usr/bin/git -C base rev-parse HEAD)\" = \"$GITHUB_SHA\"\n          /usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > \"$RUNNER_TEMP/legal_gate.py\"\n          /usr/bin/python3 -I \"$RUNNER_TEMP/legal_gate.py\" --root base --publish-gate --anchors-ref refs/remotes/origin/gh-pages\n      - name: Assemble the release directory (pre-built bundle, assets; no repository code)\n")],
      ["o12 vendas sem aplicar o snapshot aprovado", SALES, (t) => t.replace(/      - name: Serve the last approved legal snapshot when the commit's legal text is not approved\n        run: \|\n(?:          [^\n]*\n)+\n/, "")],
      ["o12 snapshot depois do portão", SALES, (t) => { const m = t.match(/      - name: Serve the last approved legal snapshot when the commit's legal text is not approved\n        run: \|\n(?:          [^\n]*\n)+\n/); return m ? t.replace(m[0], "").replace("      - name: Assemble the release directory (pre-built bundles, gated site; no repository code)\n", m[0] + "      - name: Assemble the release directory (pre-built bundles, gated site; no repository code)\n") : t; }],
      ["r10 upload do central sem arquivos ocultos", CENTRAL, (t) => t.replace("          include-hidden-files: true\n", "")],
      ["r8 ensaio de vendas sem --verify", SALES, (t) => t.replace('/usr/bin/python3 -I base/scripts/deploy/clean_bundle.py sales --repo base --rev "$GITHUB_SHA" --tools "$RUNNER_TEMP" --work "$RUNNER_TEMP/clean" --out "$RUNNER_TEMP/repro" --verify art/worker', '/usr/bin/python3 -I base/scripts/deploy/clean_bundle.py sales --repo base --rev "$GITHUB_SHA" --tools "$RUNNER_TEMP" --work "$RUNNER_TEMP/clean" --out "$RUNNER_TEMP/repro"')],
      ["manifesto não conferido", SALES, (t) => t.replace("          (cd art/worker && sha256sum --strict -c --quiet MANIFEST.sha256)\n          (cd art/site && sha256sum --strict -c --quiet MANIFEST.sha256)\n", "")],
      // Neutralizações do portão.
      ["continue-on-error no portão", SALES, (t) => t.replace(GATE_NAME, GATE_NAME + "        continue-on-error: true\n")],
      ["if no portão", SALES, (t) => t.replace(GATE_NAME, GATE_NAME + "        if: ${{ false }}\n")],
      ["|| true no portão", SALES, (t) => t.split(GL + "\n").join(GL + " || true\n")],
      ["portão lido da árvore", SALES, (t) => t.split('/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"').join('cp base/scripts/p23/legal_review.py "$RUNNER_TEMP/legal_gate.py"')],
      ["sem portão antes do candidato", SALES, (t) => t.replace(/      - name: Legal artifact gate before the candidate deploy\n        run: \|\n(?:          [^\n]*\n)+\n/, "")],
      ["V1: deploy com wrangler entre aspas e if: always()", SALES, (t) => t.replace(DEPLOY_SALES, '      - name: Deploy anyway\n        if: always()\n        run: npx --yes "wrangler@4.143.0" deploy --config wrangler.sales.deploy.toml\n' + DEPLOY_SALES)],
      ["outro job publica", SALES, (t) => t.replace("npx --yes wrangler@4.143.0 deploy --dry-run --strict --config wrangler.sales.toml --outdir /tmp/zevanory-sales-public", "npx --yes wrangler@4.143.0 deploy --strict --config wrangler.sales.toml")],
      ["defaults no workflow", CENTRAL, (t) => t.replace("\njobs:\n", "\ndefaults:\n  run:\n    shell: sh\njobs:\n")],
      ["segredo no env do workflow", SALES, (t) => t.replace("env:\n  ZEVANORY_SALES_PUBLIC_MODE: closed\n", "env:\n  ZEVANORY_SALES_PUBLIC_MODE: closed\n  X: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n")],
    ]) {
      const mutated = fn(orig[rel]);
      assert.notEqual(mutated, orig[rel], `[G11.2] âncora do mutante ausente: ${label}`);
      const r = run({ [rel]: mutated });
      assert.equal(r.code, 1, `[G11.3] ${label} não reprovou: ${r.out}`);
      assert.match(r.out, /LEGAL_GATE_WORKFLOWS=INVALID/, `[G11.3a] ${label}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Rodada 5: cada reprodução do auditor (scratchpad/audit-v12/pr946-r5/tools) falha fechada ----------
test("G12 MED-2 r5: atributo, elemento escondido, input, srcdoc, attr()/::after e CSS externo mudam a impressão digital", () => {
  const { root } = repo();
  try {
    const fp0 = fp(root);
    const pages = ["sales-public/reembolso.html", "reembolso/index.html"];
    const css = FILES.filter((f) => /^sales-public\/assets\/legal\.[0-9a-f]+\.css$/.test(f));
    assert.ok(css.length === 1, "[G12.0] CSS das páginas jurídicas entra na impressão digital: " + css);
    const snapshot = () => Object.fromEntries([...pages, ...css].map((f) => [f, read(join(root, f))]));
    const orig = snapshot();
    const restore = () => { for (const [f, t] of Object.entries(orig)) writeFileSync(join(root, f), t); };
    for (const [label, fn] of [
      ["hide", () => { for (const f of pages) { const p = join(root, f); writeFileSync(p, read(p).replace("<h2>", '<h2 style="display:none">').replace(/(<h2 style="display:none">[\s\S]*?<\/h2>)\s*<p>/, "$1<p hidden>")); } }],
      ["input", () => { for (const f of pages) { const p = join(root, f); writeFileSync(p, read(p).replace("</main>", '<input readonly value="CLÁUSULA NOVA: nenhum reembolso após o download."></main>')); } }],
      ["srcdoc", () => { for (const f of pages) { const p = join(root, f); writeFileSync(p, read(p).replace("</main>", '<iframe srcdoc="&lt;p&gt;CLÁUSULA NOVA: nenhum reembolso.&lt;/p&gt;"></iframe></main>')); } }],
      ["attr", () => { for (const f of pages) { const p = join(root, f); writeFileSync(p, read(p).replace(/<h1([^>]*)>/, '<h1$1 data-c=" — CLÁUSULA NOVA: nenhum reembolso">')); } for (const c of css) writeFileSync(join(root, c), read(join(root, c)) + "h1[data-c]::after{content:attr(data-c)}\n"); }],
      ["css", () => { for (const c of css) writeFileSync(join(root, c), read(join(root, c)) + 'main h1::after{content:" — CLÁUSULA NOVA: nenhum reembolso"} main h2:nth-of-type(2){display:none}\n'); }],
    ]) {
      fn();
      const v = fp(root);
      assert.notEqual(v, fp0, `[G12.1] ${label}: a impressão digital tem de mudar`);
      restore();
    }
    // Merge do ataque CSS: o portão bloqueia (texto publicado ≠ artefato).
    writeFileSync(join(root, css[0]), read(join(root, css[0])) + 'main h1::after{content:"CLÁUSULA NOVA"}\n');
    commit(root, "PR só CSS");
    const g = gate(root);
    assert.equal(g.code, 1, "[G12.2] " + g.out);
    assert.match(g.out, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G12.2a]");
    // Asset referenciado ausente ou externo reprova (fail-closed).
    const pg = join(root, "sales-public/termos.html");
    writeFileSync(pg, read(pg).replace("</head>", '<link rel="stylesheet" href="/assets/nao-existe.css"></head>'));
    assert.match(py(LEGAL, ["--root", root, "--fingerprint"]).out, /LEGAL_ASSET_MISSING/, "[G12.3] asset ausente");
    writeFileSync(pg, read(pg).replace('/assets/nao-existe.css', "https://cdn.example/x.css"));
    assert.match(py(LEGAL, ["--root", root, "--fingerprint"]).out, /LEGAL_ASSET_EXTERNAL/, "[G12.4] asset externo");
    writeFileSync(pg, read(pg).replace('<link rel="stylesheet" href="https://cdn.example/x.css">', ""));
    // Rodada 6 (L-2): <base href> e meta refresh são recusados numa página jurídica.
    for (const [label, tag] of [["base", '<base href="https://outro.example/">'], ["meta refresh", '<meta http-equiv="refresh" content="0;url=/outra">']]) {
      const before = read(pg);
      writeFileSync(pg, before.replace("</head>", tag + "</head>"));
      assert.match(py(LEGAL, ["--root", root, "--fingerprint"]).out, /LEGAL_PAGE_FORBIDDEN sales-public\/termos\.html/, `[G12.5] ${label} recusado`);
      writeFileSync(pg, before);
    }
    // Rodada 6 (H-1 MODE=worker): o código que serve as rotas jurídicas e a configuração entram na impressão digital.
    const base0 = fp(root);
    for (const f of ["worker/sales-public-worker.mjs", "sales-worker.mjs", "worker/politica-unica.mjs", "wrangler.sales.toml"]) {
      const orig = read(join(root, f));
      writeFileSync(join(root, f), orig + "\n// mudança\n");
      assert.notEqual(fp(root), base0, `[G12.6] ${f} muda a impressão digital`);
      writeFileSync(join(root, f), orig);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G13 H-1 r6: o portão do job deploy (corpo exato do workflow) roda sobre o artefato baixado; build malicioso não o engana", () => {
  requireTool("bash");
  // Corpo exato do passo do portão do vendas, tirado do guarda (o mesmo que o workflow tem de ter, validado no G11).
  const out = spawnSync(PYTHON, ["-I", "-c", "import sys, json; sys.path.insert(0, sys.argv[1]); import trust_anchor_guard as g; print(json.dumps(g.gate_body(g.SPECS['.github/workflows/zevanory-sales-public-release.yml']['artifact_copy'])))", join(REPO, "scripts/p23")], { encoding: "utf8", env: PYENV });
  const lines = JSON.parse(out.stdout).map((l) => l.replaceAll("/usr/bin/git", "git").replaceAll("/usr/bin/python3", PYTHON));
  const { root: trusted } = repo();
  const job = mkdtempSync(join(tmpdir(), "r6-job-"));
  try {
    // O gh-pages confiável traz o código do portão (como no repositório real).
    mkdirSync(join(trusted, "scripts/p23"), { recursive: true }); copyFileSync(LEGAL, join(trusted, "scripts/p23/legal_review.py"));
    const sha = commit(trusted, "gh-pages com o portão");
    git(trusted, "update-ref", "refs/remotes/origin/gh-pages", sha);
    // Job deploy: base/ = checkout confiável do commit do evento; art/site = artefato do site-build.
    git(job, "init", "-q"); git(job, "clone", "-q", trusted, join(job, "base"));
    git(join(job, "base"), "checkout", "-q", sha); git(join(job, "base"), "update-ref", "refs/remotes/origin/gh-pages", sha);
    const art = join(job, "art/site/sales-public");
    const runGate = () => spawnSync("bash", ["-c", lines.join("\n")], { cwd: job, encoding: "utf8", env: { ...GIT_ENV, ...PYENV, GITHUB_SHA: sha, RUNNER_TEMP: job } });
    const fresh = () => { rmSync(join(job, "art"), { recursive: true, force: true }); mkdirSync(art, { recursive: true }); for (const f of FILES.filter((x) => x.startsWith("sales-public/"))) { mkdirSync(dirname(join(job, "art/site", f)), { recursive: true }); copyFileSync(join(trusted, f), join(job, "art/site", f)); } };
    fresh();
    const clean = runGate();
    assert.match(clean.stdout + clean.stderr, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G13.0] texto da Release 2 sem aprovação continua bloqueado (controle)");
    // Estado aprovado: linha de base = artefato atual (fixture; o gate aceita só a gênese ou um registro, então
    // usamos o próprio fluxo de aprovação do G2 no repositório confiável).
    const auth = register(trusted); approve(trusted, { textCommit: sha, authCommit: auth }); const s2 = commit(trusted, "aprovação");
    git(trusted, "update-ref", "refs/remotes/origin/gh-pages", s2);
    rmSync(join(job, "base"), { recursive: true, force: true }); git(job, "clone", "-q", trusted, join(job, "base")); git(join(job, "base"), "checkout", "-q", s2); git(join(job, "base"), "update-ref", "refs/remotes/origin/gh-pages", s2);
    const runAt = (c) => spawnSync("bash", ["-c", lines.join("\n")], { cwd: job, encoding: "utf8", env: { ...GIT_ENV, ...PYENV, GITHUB_SHA: c, RUNNER_TEMP: job } });
    fresh();
    const ok = runAt(s2);
    assert.equal(ok.status, 0, "[G13.1] artefato aprovado passa: " + ok.stdout + ok.stderr);
    assert.match(ok.stdout, /PASS_APPROVED/, "[G13.1a]");
    // MODE=origin do r6-job: o build troca o CSS e aponta remote.origin.url para um gh-pages falso. No job novo o
    // build roda em outro job; o artefato chega com o CSS trocado e o portão (do checkout confiável) bloqueia.
    fresh();
    const css = FILES.find((f) => /^sales-public\/assets\/legal\.[0-9a-f]+\.css$/.test(f));
    writeFileSync(join(job, "art/site", css), read(join(job, "art/site", css)) + '\nmain h1::after{content:" CLÁUSULA NOVA: nenhum reembolso."}\n');
    const bad = runAt(s2);
    assert.notEqual(bad.status, 0, "[G13.2] artefato com CSS trocado bloqueia");
    assert.match(bad.stdout + bad.stderr, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G13.2a]");
    // Reescrita de página no artefato também bloqueia.
    fresh();
    const pg = join(job, "art/site/sales-public/reembolso.html");
    writeFileSync(pg, read(pg).replace("<h1>", "<h1>CLÁUSULA NOVA: nenhum reembolso. "));
    assert.notEqual(runAt(s2).status, 0, "[G13.3] página trocada no artefato bloqueia");
  } finally { rmSync(trusted, { recursive: true, force: true }); rmSync(job, { recursive: true, force: true }); }
});

test("G14 r5: Worker de vendas (W1), premerge (V2) e workflows novos (r5-newwf) são âncoras: CHANGED", () => {
  const { root, text: base } = repo();
  try {
    const wf = (name, body) => { mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows", name), body); };
    const fileEdit = (rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
    const HDR = "name: n\non:\n  push:\n    branches: [gh-pages]\njobs:\n  d:\n    runs-on: ubuntu-latest\n";
    for (const [label, change, path] of [
      ["W1 Worker de vendas", () => fileEdit("worker/sales-public-worker.mjs", "export default {};\n"), "worker/sales-public-worker.mjs"],
      ["W1 entrada do Worker", () => fileEdit("sales-worker.mjs", "export default {};\n"), "sales-worker.mjs"],
      ["config wrangler de vendas", () => fileEdit("wrangler.sales.toml", "name = \"x\"\n"), "wrangler.sales.toml"],
      ["V2 premerge", () => wf("product-pages-premerge.yml", "name: p\non: pull_request\njobs: {}\n"), ".github/workflows/product-pages-premerge.yml"],
      ["newwf quoted", () => wf("n.yml", HDR + "    environment:\n      name: producao-critica\n    steps:\n      - run: npx --yes \"wrangler@4.143.0\" deploy\n"), ".github/workflows/n.yml"],
      ["newwf varcmd", () => wf("n.yml", HDR + "    environment: { name: producao-critica }\n    steps:\n      - run: W=wrangler; npx --yes $W deploy\n"), ".github/workflows/n.yml"],
      ["newwf npmscript", () => wf("n.yml", HDR + "    steps:\n      - run: node scripts/deploy/any.mjs\n"), ".github/workflows/n.yml"],
      ["newwf apicurl", () => wf("n.yml", HDR + "    steps:\n      - run: curl -X PUT https://api.cloudflare.com/client/v4/accounts/x/workers/scripts/y -F m=@m\n"), ".github/workflows/n.yml"],
      ["action local", () => fileEdit(".github/actions/x/action.yml", "runs: {using: composite, steps: []}\n"), ".github/actions/x/action.yml"],
    ]) {
      git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-r5");
      change(); const head = commit(root, "PR " + label);
      const r = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", head]);
      assert.equal(r.code, 1, `[G14.1] ${label}: ${r.out}`);
      assert.match(r.out, /TRUST_ANCHORS=CHANGED/, `[G14.2] ${label}`);
      assert.ok(r.out.includes("TRUST_ANCHOR_CHANGED::" + path), `[G14.3] ${label}: ${path} citado`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G15 r7 M-1c: configuração npm/yarn, pacotes e configurações wrangler em qualquer pasta são âncoras: CHANGED", () => {
  const { root, text: base } = repo();
  try {
    for (const path of ["node_modules/.bin/wrangler", ".npmrc", "worker/.npmrc", ".yarnrc.yml", ".yarnrc", "package.json", "package-lock.json",
      "tools/package.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "sub/node_modules/wrangler/index.js", "wrangler.toml",
      "wrangler.extra.toml", "sandbox/x/wrangler.jsonc", "wrangler.json", "scripts/deploy/wrangler-pin/package-lock.json",
      ".gitattributes", "worker/.gitattributes"]) {
      git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-r7");
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), path.endsWith("wrangler") ? "#!/bin/sh\necho stub\n" : "registry=https://evil.invalid/\n");
      const head = commit(root, "PR " + path);
      const r = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", head]);
      assert.equal(r.code, 1, `[G15.1] ${path}: ${r.out}`);
      assert.match(r.out, /TRUST_ANCHORS=CHANGED/, `[G15.2] ${path}`);
      assert.ok(r.out.includes("TRUST_ANCHOR_CHANGED::" + path), `[G15.3] ${path} citado`);
    }
    for (const path of ["docs/package-notes.md", "worker/funnel.mjs", "assets/npmrc-guide.txt"]) {
      git(root, "checkout", "-q", "-f", base); git(root, "checkout", "-q", "-B", "pr-r7-ok");
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "x\n");
      const head = commit(root, "PR comum " + path);
      const r = py(GUARD, ["--pr-repo", root, "--base-sha", base, "--head-sha", head]);
      assert.equal(r.code, 0, `[G15.4] ${path} não é âncora: ${r.out}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G16 r9 ensaio (--rehearsal): commit fora do gh-pages continua BLOCKED, mas imprime o veredito da impressão digital; sem a flag nada muda", () => {
  const { root, text: base } = repo();
  const rehearse = (r) => py(LEGAL, ["--root", r, "--publish-gate", "--anchors-ref", "main", "--rehearsal"]);
  try {
    // No gh-pages (main) o portão normal e o de ensaio dão a mesma saída.
    const a = gate(root), b = rehearse(root);
    assert.equal(a.code, b.code, "[G16.1]"); assert.equal(a.out, b.out, "[G16.1a] a flag não muda nada quando o commit está no gh-pages");
    // Commit despachado num branch (ainda não está no gh-pages), com texto jurídico alterado.
    git(root, "checkout", "-q", "-B", "pr-branch"); word(root, "Termos", "Termos e Condições"); commit(root, "texto alterado no branch");
    const plain = gate(root);
    assert.equal(plain.code, 1, "[G16.2] " + plain.out);
    assert.doesNotMatch(plain.out, /LEGAL_REHEARSAL_/, "[G16.3] sem --rehearsal, nenhuma linha de ensaio (produção inalterada)");
    const r = rehearse(root);
    assert.equal(r.code, 1, "[G16.4] o ensaio continua recusando: " + r.out);
    assert.match(r.out, /não está contido no gh-pages/, "[G16.5]");
    assert.match(r.out, /LEGAL_PUBLISH_GATE=BLOCKED/, "[G16.6]");
    assert.match(r.out, /LEGAL_REHEARSAL_PENDING=[^\n]*sales-public\/termos\.html/, "[G16.7] arquivo alterado listado: " + r.out);
    assert.match(r.out, /LEGAL_REHEARSAL_VERDICT=BLOCKED/, "[G16.8] veredito impresso");
    assert.match(r.out, /::notice title=LEGAL_REHEARSAL_VERDICT::BLOCKED/, "[G16.8a] veredito também como anotação");
    assert.ok(r.out.indexOf("LEGAL_REHEARSAL_VERDICT") < r.out.indexOf("LEGAL_PUBLISH_GATE=BLOCKED"), "[G16.9] veredito antes da recusa");
    // gh-pages ainda sem a linha de base (antes do merge da Release 2): o ensaio usa a do commit despachado e diz isso.
    git(root, "checkout", "-q", "main"); git(root, "rm", "-q", "data/p23/legal-published-baseline.json"); commit(root, "gh-pages antigo, sem linha de base");
    git(root, "checkout", "-q", "pr-branch");
    const old = rehearse(root);
    assert.equal(old.code, 1, "[G16.10]");
    assert.match(old.out, /LEGAL_REHEARSAL_PUBLISHED_BASELINE=[0-9a-f]{64} source_commit=\S* origem=commit despachado/, "[G16.11] " + old.out);
    assert.match(old.out, /LEGAL_REHEARSAL_VERDICT=BLOCKED/, "[G16.12]");
    void base;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- Sol ORDEM 312 ----------
const INTERNAL = { id: "int-renan", name: "Renan Bitu", type: "internal_owner", github_login: "arbmsistone-lab", authorized_by: "proprietario", authorized_at: "2026-10-20" };
const DISCLAIMER = "Aprovação interna do proprietário: controle temporário; não constitui parecer jurídico.";
const AUDIT = "docs/legal/audits/auditoria-independente.md";
const sha256 = (buf) => spawnSync(PYTHON, ["-I", "-c", "import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())"], { input: buf }).stdout.toString().trim();
function approveInternal(root, { textCommit, authCommit, rec = (r) => r, rev = (r) => r }) {
  const sha = fp(root);
  const version = JSON.parse(read(join(root, "data/politica-unica.json"))).legal_document_version;
  json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = d.reviewers.map((r) => (r.id === INTERNAL.id && !r.authorization_commit ? { ...r, authorization_commit: authCommit } : r)); });
  mkdirSync(join(root, "docs/legal/audits"), { recursive: true });
  writeFileSync(join(root, AUDIT), "# Auditoria independente (fixture)\n\nAprovado no código.\n");
  const audit = { ref: AUDIT, sha256: sha256(Buffer.from("# Auditoria independente (fixture)\n\nAprovado no código.\n")), auditor: "Auditoria Externa Independente" };
  const ids = JSON.parse(read(join(root, "data/p23/ecommerce-legal-checklist.json"))).items.map((i) => i.id);
  const checklist = Object.fromEntries(ids.map((id) => [id, { answer: "conforme", evidence: `conferido em sales-public (${id})` }]));
  const review = rev({ status: "APPROVED_INTERNAL", type: "internal_owner", reviewer_id: INTERNAL.id, approved_by: INTERNAL.name, approved_at: "2026-10-27",
    reviewed_sha256: sha, reviewed_commit: textCommit, document_version: version, record: `docs/legal/reviews/${sha}.json`, disclaimer: DISCLAIMER });
  json(root, "data/politica-unica.json", (d) => { d.legal_review = review; });
  put(root, `docs/legal/reviews/${sha}.json`, rec({ reviewer_id: INTERNAL.id, reviewed_sha256: sha, reviewed_commit: textCommit, document_version: version,
    approved_at: "2026-10-27", decision: "APPROVED_INTERNAL", type: "internal_owner", disclaimer: DISCLAIMER, checklist, audit_report: audit }));
  return sha;
}

test("G17 o12 aprovação INTERNA (proprietário): aceita com checklist P23 e auditoria; impressa como interna, nunca como parecer", () => {
  const { root, text } = repo();
  try {
    const auth = register(root, INTERNAL);
    approveInternal(root, { textCommit: text, authCommit: auth }); const ok1 = commit(root, "aprovação interna");
    const ok = gate(root);
    assert.equal(ok.code, 0, "[G17.1] " + ok.out);
    assert.match(ok.out, /LEGAL_PUBLISH_GATE=PASS_APPROVED/, "[G17.1a]");
    assert.match(ok.out, /LEGAL_APPROVAL_LEVEL=INTERNAL_OWNER \(Aprovação interna do proprietário: controle temporário; não constitui parecer jurídico\./, "[G17.2] nível interno com o aviso");
    assert.doesNotMatch(ok.out, /PROFESSIONAL/, "[G17.3] nunca rotulada como profissional");
    for (const line of ok.out.split("\n")) if (/parecer jur/i.test(line)) assert.match(line, /não constitui parecer jurídico/, "[G17.4] 'parecer' só na negação: " + line);
    const variants = [
      ["checklist incompleto", { rec: (r) => { const c = { ...r.checklist }; delete c[Object.keys(c)[0]]; return { ...r, checklist: c }; } }, /checklist P23 item/],
      ["item não conforme", { rec: (r) => ({ ...r, checklist: { ...r.checklist, [Object.keys(r.checklist)[0]]: { answer: "nao_conforme", evidence: "x" } } }) }, /checklist P23 item/],
      ["auditoria com hash errado", { rec: (r) => ({ ...r, audit_report: { ...r.audit_report, sha256: "0".repeat(64) } }) }, /audit_report/],
      ["auditor é quem aprova", { rec: (r) => ({ ...r, audit_report: { ...r.audit_report, auditor: INTERNAL.name } }) }, /audit_report/],
      ["registro se apresenta como parecer", { rec: (r) => ({ ...r, nota: "parecer jurídico favorável" }) }, /não pode se apresentar como parecer/],
      ["sem o aviso", { rec: (r) => ({ ...r, disclaimer: "ok" }), rev: (r) => ({ ...r, disclaimer: "ok" }) }, /disclaimer/],
      ["APPROVED com registro interno", { rev: (r) => ({ ...r, status: "APPROVED", type: undefined }), rec: (r) => ({ ...r, decision: "APPROVED", type: undefined }) }, /cadastro incompleto, de outro nível|decision|type/],
    ];
    for (const [label, opt, msg] of variants) {
      git(root, "checkout", "-q", "-f", auth); git(root, "checkout", "-q", "-B", "v-" + label.replace(/\W+/g, "-"));
      approveInternal(root, { textCommit: text, authCommit: auth, ...opt }); commit(root, label);
      const r = gate(root, "HEAD");
      assert.equal(r.code, 1, `[G17.5] ${label}: ${r.out}`);
      assert.match(r.out, msg, `[G17.5a] ${label}: ${r.out}`);
    }
    // Aprovação interna citando OAB não vale (confere a aprovação declarada na árvore, como o P23 de PR).
    git(root, "checkout", "-q", "-f", auth); git(root, "checkout", "-q", "-B", "v-oab");
    approveInternal(root, { textCommit: text, authCommit: auth, rev: (r) => ({ ...r, approved_by: "Renan Bitu, OAB/CE 12345" }) });
    const oab = py(LEGAL, ["--root", root, "--check-approval"]);
    assert.equal(oab.code, 1, "[G17.7] " + oab.out);
    assert.match(oab.out, /não pode citar OAB/, "[G17.7a]");
    // Duas etapas também para o interno: cadastro e aprovação no MESMO commit não valem.
    git(root, "checkout", "-q", "-f", text); git(root, "checkout", "-q", "-B", "same-pr");
    json(root, "data/p23/legal-reviewers.json", (d) => { d.reviewers = [INTERNAL]; });
    const same = git(root, "rev-parse", "HEAD");
    approveInternal(root, { textCommit: text, authCommit: same }); commit(root, "cadastro e aprovação juntos");
    const r = gate(root, "HEAD");
    assert.equal(r.code, 1, "[G17.6] cadastro e aprovação no mesmo PR: " + r.out);
    void ok1;
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function publishedApproved(root, text) {
  const auth = register(root);
  approve(root, { textCommit: text, authCommit: auth }); commit(root, "aprovação jurídica");
  const approved = fp(root);
  json(root, "data/p23/legal-published-baseline.json", (d) => { d.fingerprint = approved; d.source_commit = text; });
  commit(root, "linha de base = texto aprovado e publicado");
  return approved;
}
const applySnapshot = (root, ref = "main") => py(LEGAL, ["--root", root, "--apply-snapshot", join(root, "sales-public"), "--anchors-ref", ref]);

test("G18 o12 snapshot aprovado: texto novo não aprovado nunca é servido; o deploy segue com o último texto aprovado", () => {
  const { root, text } = repo();
  try {
    const approved = publishedApproved(root, text);
    const before = git(root, "show", `${text}:sales-public/termos.html`);
    word(root, "Termos", "Termos Novos");
    writeFileSync(join(root, "termos/index.html"), read(join(root, "termos/index.html")) + "\n<!-- fonte nova -->\n");
    commit(root, "texto novo, sem aprovação");
    const raw = gate(root);
    assert.equal(raw.code, 1, "[G18.1] texto não aprovado servido = reprova: " + raw.out);
    assert.match(raw.out, /LEGAL_UNAPPROVED_TEXT_SERVED/, "[G18.1a]");
    const a = applySnapshot(root);
    assert.equal(a.code, 0, "[G18.2] " + a.out);
    assert.match(a.out, new RegExp(`LEGAL_SNAPSHOT_APPLIED=${approved} commit=${text}`), "[G18.2a]");
    assert.equal(read(join(root, "sales-public/termos.html")).trim(), before, "[G18.3] os bytes servidos são os do texto aprovado");
    const g = gate(root);
    assert.equal(g.code, 0, "[G18.4] " + g.out);
    assert.match(g.out, new RegExp(`LEGAL_SERVED=APPROVED_SNAPSHOT ${approved}`), "[G18.4a]");
    assert.match(g.out, /LEGAL_PENDING=[^\n]*sales-public\/termos\.html/, "[G18.4b] o texto novo fica pendente");
    assert.match(g.out, /LEGAL_PUBLISH_GATE=PASS_APPROVED_SNAPSHOT/, "[G18.4c]");
    assert.match(g.out, /LEGAL_APPROVAL_LEVEL=PROFESSIONAL/, "[G18.4d]");
    // O código que serve as rotas mudou sem aprovação: só o Worker de vendas fica bloqueado.
    git(root, "checkout", "-q", "-f", "main");
    writeFileSync(join(root, "worker/sales-public-worker.mjs"), read(join(root, "worker/sales-public-worker.mjs")) + "\n// mudança no código que serve\n");
    commit(root, "código que serve alterado");
    assert.equal(applySnapshot(root).code, 0, "[G18.5]");
    const sc = gate(root);
    assert.equal(sc.code, 1, "[G18.6] " + sc.out);
    assert.match(sc.out, /LEGAL_SERVING_UNAPPROVED[^\n]*Só o deploy do Worker de vendas fica bloqueado; o central não usa este portão/, "[G18.6a]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G19 o12 emergência: só o dono, com motivo, e só com os textos do snapshot aprovado; nunca troca texto jurídico", () => {
  const { root, text } = repo();
  const dir = mkdtempSync(join(tmpdir(), "legal-ev-"));
  const em = (event, ref = "refs/heads/gh-pages") => {
    writeFileSync(join(dir, "event.json"), JSON.stringify(event));
    const r = spawnSync(PYTHON, ["-I", LEGAL, "--root", root, "--publish-gate", "--anchors-ref", "main"],
      { encoding: "utf8", env: { ...PYENV, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_REF: ref } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  const ev = (over = {}) => ({ inputs: { mode: "emergency", reason: "correção urgente de checkout quebrado em produção" }, sender: { login: "dono" }, repository: { owner: { login: "dono" } }, ...over });
  try {
    publishedApproved(root, text);
    writeFileSync(join(root, "worker/sales-public-worker.mjs"), read(join(root, "worker/sales-public-worker.mjs")) + "\n// correção urgente\n");
    commit(root, "correção urgente no Worker");
    assert.equal(applySnapshot(root).code, 0, "[G19.0]");
    assert.equal(gate(root).code, 1, "[G19.1] sem emergência, bloqueado");
    const ok = em(ev());
    assert.equal(ok.code, 0, "[G19.2] " + ok.out);
    assert.match(ok.out, /LEGAL_SERVED=EMERGENCY_SNAPSHOT/, "[G19.2a]");
    assert.match(ok.out, /::warning title=LEGAL_EMERGENCY::deploy de emergência por dono[^\n]*Motivo: correção urgente/, "[G19.2b] registro com autor e motivo");
    assert.equal(em(ev({ sender: { login: "outra-conta" } })).code, 1, "[G19.3] só o dono");
    assert.equal(em(ev({ inputs: { mode: "emergency", reason: "curto" } })).code, 1, "[G19.4] motivo obrigatório");
    assert.equal(em(ev(), "refs/heads/outro").code, 1, "[G19.5] só no gh-pages");
    // Texto de consumo alterado: a emergência não o publica.
    json(root, "data/politica-unica.json", (d) => { d.rule_7d = String(d.rule_7d) + " (alterado)"; }); commit(root, "texto de consumo alterado");
    assert.equal(applySnapshot(root).code, 0, "[G19.6]");
    const t = em(ev());
    assert.equal(t.code, 1, "[G19.7] emergência nunca troca texto jurídico: " + t.out);
    assert.match(t.out, /nunca troca texto jurídico/, "[G19.7a]");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test("G20 o12 snapshot de origem reproduzível (b7671272/a6068e6a); snapshot não reproduzível reprova", () => {
  const base = JSON.parse(read(join(REPO, "data/p23/legal-published-baseline.json")));
  const consts = spawnSync(PYTHON, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import legal_review as l; print(l.GENESIS_BASELINE, l.GENESIS_COMMIT)", join(REPO, "scripts/p23")], { encoding: "utf8" }).stdout.trim().split(" ");
  assert.deepEqual([base.fingerprint, base.source_commit], consts, "[G20.1] a linha de base aponta para o snapshot de origem");
  const have = ["b7671272b1c0b35d1bb7a20fa2489bd7c5a0f224", "a6068e6a5aba2e2062a418086586dbc711e3cfc4"].every((c) => spawnSync("git", ["-C", REPO, "cat-file", "-e", c + "^{commit}"]).status === 0);
  if (have) {  // no CI com checkout raso os commits antigos não existem; no deploy (fetch-depth 0) existem
    const r = spawnSync(PYTHON, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import legal_review as l\nfor c in sys.argv[2:]:\n  g=l.GitRef(sys.argv[1]+'/../..', c); print(l.legal_fingerprint_src(g), l.served_fingerprint(g), l.texts_fingerprint(g))",
      join(REPO, "scripts/p23"), "b7671272b1c0b35d1bb7a20fa2489bd7c5a0f224", "a6068e6a5aba2e2062a418086586dbc711e3cfc4"], { encoding: "utf8" });
    const [x, y] = r.stdout.trim().split("\n");
    assert.equal(x.split(" ")[0], consts[0], "[G20.2] b7671272 reproduz a gênese " + r.stderr);
    assert.equal(x, y, "[G20.3] a6068e6a (publicado) é byte a byte o mesmo snapshot");
  }
  // Sem o commit de origem (fixture), o snapshot não é reproduzível: aplicar reprova e o portão bloqueia.
  const { root } = repo();
  try {
    word(root, "Termos", "Termos Novos"); commit(root, "texto novo");
    const a = applySnapshot(root);
    assert.equal(a.code, 1, "[G20.4] " + a.out);
    assert.match(a.out, /LEGAL_SNAPSHOT_NOT_REPRODUCIBLE/, "[G20.4a]");
    assert.equal(gate(root).code, 1, "[G20.5]");
    // Linha de base aprovada apontando para um commit cujo texto NÃO é o declarado: não reproduzível.
    json(root, "data/p23/legal-published-baseline.json", (d) => { d.source_commit = git(root, "rev-parse", "HEAD"); }); commit(root, "origem errada");
    assert.match(applySnapshot(root).out, /LEGAL_SNAPSHOT_NOT_REPRODUCIBLE/, "[G20.6]");
  } finally { rmSync(root, { recursive: true, force: true }); }
  // A linha de base aprovada aponta para um commit com OUTRO texto (não aprovado): esse snapshot não se reproduz e
  // nunca é servido; vale o registro de aprovação, cujo commit reproduz a impressão digital.
  const r2 = repo();
  try {
    const approved = publishedApproved(r2.root, r2.text);
    const good = git(r2.root, "show", `${r2.text}:sales-public/termos.html`);
    word(r2.root, "Termos", "Termos Falsos"); const evil = commit(r2.root, "texto não aprovado");
    json(r2.root, "data/p23/legal-published-baseline.json", (d) => { d.source_commit = evil; }); commit(r2.root, "linha de base aponta para o texto não aprovado");
    const a = applySnapshot(r2.root);
    assert.match(a.out, new RegExp(`LEGAL_SNAPSHOT_NOT_REPRODUCIBLE ${approved.slice(0, 12)}@${evil.slice(0, 12)}`), "[G20.7] " + a.out);
    assert.equal(read(join(r2.root, "sales-public/termos.html")).trim(), good, "[G20.8] o texto não aprovado nunca é servido");
  } finally { rmSync(r2.root, { recursive: true, force: true }); }
});
