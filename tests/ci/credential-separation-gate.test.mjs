// Fora de tests/*.test.mjs de propósito: depende de PyYAML (o gate lê YAML), que o job credential-separation-gate
// instala; a suíte Node completa (Windows/setup-python) não tem PyYAML.
// F2 item 9 (roteiro 3.1 seção 7): o gate estático scripts/ci/credential_separation_gate.py executado de verdade
// (python3) sobre o repositório e sobre workflows-fixture em diretório temporário. Cada asserção leva [Gn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "../helpers/toolchain.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATE = join(ROOT, "scripts", "ci", "credential_separation_gate.py");

function gate(dir, { configRoot = dir } = {}) {
  requireTool("python3");
  const r = spawnSync("python3", [GATE, "--workflows", dir, ...(configRoot ? ["--config-root", configRoot] : []), "--json"], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, "[G0.1] gate sem JSON: " + String(r.stderr || r.stdout).slice(-400));
  return { code: r.status, ...JSON.parse(line) };
}
// Registro de dívida real (ops/r9-debt.json) sem a lista de aposentados (os arquivos não existem na fixture).
const REAL_DEBT = JSON.parse(readFileSync(join(ROOT, "ops", "r9-debt.json"), "utf8"));
const debtWith = (over = {}) => JSON.stringify({ ...REAL_DEBT, retired_workflows: [], ...over });
const CLEANUP = readFileSync(join(ROOT, ".github", "workflows", "production-test-secret-cleanup.yml"), "utf8").replace(/\r\n/g, "\n");
function fixtures(files, { allowErrors = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "zev-credgate-"));
  if (!("ops/r9-debt.json" in files)) files = { ...files, "ops/r9-debt.json": debtWith() };
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  let res;
  try { res = gate(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  if (!allowErrors) assert.deepEqual(res.errors, [], "[G0.2] fixture ilegível (o teste não pode passar vazio)");
  return res;
}
const job = ({ env = "producao-critica", vars = "", steps = "      - run: echo ok\n", top = "" } = {}) =>
  `name: fixture\non: workflow_dispatch\n${top}jobs:\n  j:\n${env === null ? "" : typeof env === "string" ? `    environment: ${env}\n` : `    environment:\n      name: ${env.name}\n`}` +
  `    runs-on: ubuntu-latest\n${vars ? `    env:\n${vars}` : ""}    steps:\n${steps}`;
const run = (script) => `      - shell: bash\n        run: |\n${script.split("\n").map((l) => "          " + l).join("\n")}\n`;
const of = (res, wf) => res.violations.filter((v) => v.workflow === wf).map((v) => `${v.rule}:${v.name}`).sort();

test("G1 repositório: os workflows reais passam no gate", () => {
  const r = gate(join(ROOT, ".github", "workflows"), { configRoot: null });
  assert.deepEqual(r.violations.map((v) => `${v.workflow}#${v.job}:${v.rule}:${v.name}`), [], "[G1.1] nenhuma violação no repositório");
  assert.equal(r.code, 0, "[G1.1] código 0");
});

test("G2 segredo de sandbox só em job sandbox-financial-approved", () => {
  const r = fixtures({
    "a.yml": job({ vars: "      T: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\n" }),
    "b.yml": job({ env: "gh-pages-automacao", vars: "      T: ${{ secrets['SANDBOX_INBOX_READ_TOKEN'] }}\n" }),
    "c.yml": job({ env: null, steps: run('echo "${{ secrets.CERTIFICATION_DATABASE_URL }}" >/dev/null') }),
    "d.yml": job({ vars: "      MERCADOPAGO_TEST_WEBHOOK_SECRET: ${{ secrets.OTHER_VALUE }}\n" }),
    "e.yml": `name: fixture\non: workflow_dispatch\nenv:\n  T: \${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\njobs:\n  j1:\n    environment: producao-critica\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n  j2:\n    environment: sandbox-financial-approved\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`,
    "f.yml": job({ env: "sandbox-financial-approved", vars: "      T: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\n      S: ${{ secrets['SANDBOX_INBOX_READ_TOKEN'] }}\n" }),
    "g.yml": job({ env: { name: "sandbox-financial-approved" }, vars: "      C: ${{ secrets.CERTIFICATION_DATABASE_URL }}\n" }),
  });
  assert.deepEqual(of(r, "a.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:MERCADOPAGO_TEST_ACCESS_TOKEN"], "[G2.1] producao-critica");
  assert.deepEqual(of(r, "b.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:SANDBOX_INBOX_READ_TOKEN"], "[G2.2] gh-pages-automacao e secrets['X']");
  assert.deepEqual(of(r, "c.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:CERTIFICATION_DATABASE_URL"], "[G2.3] job sem Environment, referência no run");
  assert.deepEqual(of(r, "d.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[G2.4] variável de nome sandbox carregando segredo");
  assert.deepEqual(r.violations.filter((v) => v.workflow === "e.yml").map((v) => v.job), ["j1"], "[G2.5] env do workflow vale para cada job");
  assert.deepEqual([...of(r, "f.yml"), ...of(r, "g.yml")], [], "[G2.6] em sandbox-financial-approved (texto ou {name:}) é permitido");
});

test("G3 segredo de produção nunca em job sandbox-financial-approved", () => {
  const sb = "sandbox-financial-approved";
  const r = fixtures({
    "a.yml": job({ env: sb, vars: "      T: ${{ secrets.MERCADOPAGO_ACCESS_TOKEN }}\n" }),
    "b.yml": job({ env: sb, vars: "      T: ${{ secrets.MERCADOPAGO_PROD_ACCESS_TOKEN }}\n      W: ${{ secrets.MERCADOPAGO_WEBHOOK_SECRET }}\n" }),
    "c.yml": job({ env: sb, steps: run('x="${{ secrets.ASAAS_API_KEY }}${{ secrets.STRIPE_SECRET_KEY }}${{ secrets.DATABASE_URL }}"') }),
    "d.yml": job({ env: sb, vars: "      MP_TOKEN: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\n" }),
    "e.yml": job({ vars: "      T: ${{ secrets.MERCADOPAGO_ACCESS_TOKEN }}\n" }),
  });
  assert.deepEqual(of(r, "a.yml"), ["PRODUCTION_SECRET_IN_SANDBOX:MERCADOPAGO_ACCESS_TOKEN"], "[G3.1] token de produção do Mercado Pago");
  assert.deepEqual(of(r, "b.yml"), ["PRODUCTION_SECRET_IN_SANDBOX:MERCADOPAGO_PROD_ACCESS_TOKEN", "PRODUCTION_SECRET_IN_SANDBOX:MERCADOPAGO_WEBHOOK_SECRET"], "[G3.2] nomes reais de produção");
  assert.deepEqual(of(r, "c.yml"), ["PRODUCTION_SECRET_IN_SANDBOX:ASAAS_API_KEY", "PRODUCTION_SECRET_IN_SANDBOX:DATABASE_URL", "PRODUCTION_SECRET_IN_SANDBOX:STRIPE_SECRET_KEY"], "[G3.3] outros provedores e banco de produção");
  assert.deepEqual([...of(r, "d.yml"), ...of(r, "e.yml")], [], "[G3.4] apelido MP_TOKEN de segredo de teste e produção em producao-critica são permitidos");
});

test("G4 nenhuma gravação de segredo de teste/certificação no Worker de produção", () => {
  const sb = "sandbox-financial-approved";
  const r = fixtures({
    "a.yml": job({ env: sb, steps: run("printf x | npx wrangler@4.143.0 secret put MERCADOPAGO_TEST_ACCESS_TOKEN --name zevanory") }),
    "b.yml": job({ steps: run("printf x | npx wrangler secret put MERCADOPAGO_TEST_WEBHOOK_SECRET") }),
    "c.yml": job({ steps: run("printf x | npx wrangler secret put SANDBOX_INBOX_READ_TOKEN --config wrangler.central-fix.jsonc") }),
    "d.yml": job({ steps: run("printf x | npx wrangler versions secret put CERTIFICATION_DATABASE_URL --name zevanory") }),
    "e.yml": job({ steps: run('for name in VOICE_FLAG MERCADOPAGO_TEST_PUBLIC_KEY; do\n  printf x | npx wrangler secret put "$name" --name zevanory\ndone') }),
    "f.yml": job({ steps: run('printf x | npx wrangler secret put "$DYNAMIC" --name zevanory') }),
    "g.yml": job({ steps: run("python3 -c 'import json;json.dump({\"MERCADOPAGO_TEST_ACCESS_TOKEN\":\"x\"},open(\"s.json\",\"w\"))'\nnpx wrangler secret bulk s.json --name zevanory") }),
    "h.yml": job({ steps: run("printf x | npx wrangler secret put \\\n  MERCADOPAGO_TEST_ACCESS_TOKEN \\\n  --name zevanory") }),
    "ok.yml": job({ env: sb, steps: run([
      "printf x | npx wrangler secret put MERCADOPAGO_TEST_ACCESS_TOKEN --config wrangler.certification.generated.jsonc",
      "printf x | npx wrangler secret put CERTIFICATION_E2E_TOKEN --name zevanory-certification",
      "npx wrangler secret bulk /tmp/c.json --config wrangler.certification.generated.jsonc"].join("\n")) }),
    "ok2.yml": job({ steps: run("printf x | npx wrangler secret put MERCADOPAGO_ACCESS_TOKEN --name zevanory\nnpx wrangler secret delete MERCADOPAGO_TEST_ACCESS_TOKEN --name zevanory") }),
  });
  assert.deepEqual(of(r, "a.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:MERCADOPAGO_TEST_ACCESS_TOKEN"], "[G4.1] --name zevanory (mesmo em job sandbox)");
  assert.deepEqual(of(r, "b.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:MERCADOPAGO_TEST_WEBHOOK_SECRET"], "[G4.2] sem --name/--config = configuração padrão de produção");
  assert.deepEqual(of(r, "c.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:SANDBOX_INBOX_READ_TOKEN"], "[G4.3] --config sem 'certification'");
  assert.deepEqual(of(r, "d.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:CERTIFICATION_DATABASE_URL"], "[G4.4] versions secret put");
  assert.deepEqual(of(r, "e.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:MERCADOPAGO_TEST_PUBLIC_KEY"], "[G4.5] nome dinâmico resolvido pelo for");
  assert.deepEqual(of(r, "f.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:$DYNAMIC"], "[G4.6] nome dinâmico não resolvido falha");
  assert.deepEqual(of(r, "g.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:MERCADOPAGO_TEST_ACCESS_TOKEN"], "[G4.7] secret bulk com nome de teste");
  assert.deepEqual(of(r, "h.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:MERCADOPAGO_TEST_ACCESS_TOKEN"], "[G4.8] comando quebrado com barra invertida");
  assert.deepEqual([...of(r, "ok.yml"), ...of(r, "ok2.yml")], [], "[G4.9] Worker de certificação, nome de produção e delete não são gravação proibida");
});

test("G5 exceção nominal única: CERTIFICATION_E2E_TOKEN (token de operador da produção)", () => {
  const r = fixtures({
    "a.yml": job({ vars: "      C: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
    "b.yml": job({ env: "gh-pages-automacao", vars: "      C: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
    "c.yml": job({ vars: "      C: ${{ secrets.CERTIFICATION_OPERATOR_TOKEN }}\n" }),
    "d.yml": job({ steps: run("printf x | npx wrangler secret put CERTIFICATION_E2E_TOKEN --name zevanory") }),
  });
  assert.deepEqual([...of(r, "a.yml"), ...of(r, "b.yml")], [], "[G5.1] permitido em Environment de produção");
  assert.deepEqual(of(r, "c.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:CERTIFICATION_OPERATOR_TOKEN"], "[G5.2] a exceção não é curinga");
  assert.deepEqual(of(r, "d.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:CERTIFICATION_E2E_TOKEN"], "[G5.3] a exceção não autoriza gravar no Worker de produção");
  const noExc = fixtures({ "a.yml": job({ vars: "      C: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
    "ops/r9-debt.json": debtWith({ pending: REAL_DEBT.pending.map((e) => ({ ...e, github_secret_exception: false })) }) });
  assert.deepEqual(of(noExc, "a.yml"), ["SANDBOX_SECRET_OUTSIDE_SANDBOX:CERTIFICATION_E2E_TOKEN"], "[G5.4] a exceção vem só de ops/r9-debt.json");
});

test("G6 fail-closed: Environment por expressão, YAML ilegível, diretório vazio", () => {
  const r = fixtures({ "a.yml": job({ env: "${{ inputs.target }}", vars: "      T: ${{ secrets.MERCADOPAGO_ACCESS_TOKEN }}\n" }) });
  assert.deepEqual(of(r, "a.yml"), ["ENVIRONMENT_NOT_LITERAL:MERCADOPAGO_ACCESS_TOKEN"], "[G6.1] Environment não provado");
  const bad = fixtures({ "a.yml": "jobs: [\n  : :" }, { allowErrors: true });
  assert.equal(bad.code, 2, "[G6.2] YAML ilegível => código 2");
  const dir = mkdtempSync(join(tmpdir(), "zev-credgate-empty-"));
  try { assert.equal(gate(dir).code, 2, "[G6.3] sem workflows => código 2"); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("G7 reprodução do incidente de 05/10 (run 37365806405, sandbox-worker-secret-audit no producao-critica)", () => {
  const incident = job({ vars: "      TEST_WEBHOOK_SECRET: ${{ secrets.MERCADOPAGO_TEST_WEBHOOK_SECRET }}\n      TEST_ACCESS_TOKEN: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\n",
    steps: run('printf \'%s\' "$TEST_ACCESS_TOKEN" | npx --yes wrangler@4.143.0 secret put MERCADOPAGO_TEST_ACCESS_TOKEN --name zevanory\nprintf \'%s\' "$TEST_WEBHOOK_SECRET" | npx --yes wrangler@4.143.0 secret put MERCADOPAGO_TEST_WEBHOOK_SECRET --name zevanory') });
  const r = fixtures({ "audit.yml": incident });
  const got = of(r, "audit.yml");
  for (const n of ["MERCADOPAGO_TEST_ACCESS_TOKEN", "MERCADOPAGO_TEST_WEBHOOK_SECRET"]) {
    assert.ok(got.includes("SANDBOX_SECRET_OUTSIDE_SANDBOX:" + n), "[G7.1] referência no producao-critica: " + n);
    assert.ok(got.includes("TEST_SECRET_PUT_TO_PRODUCTION:" + n), "[G7.2] gravação no zevanory: " + n);
  }
  assert.equal(r.code, 1, "[G7.2] gate falha");
});

test("G8 configuração de produção não ganha var de teste/certificação (dívida congelada) nem --var no deploy", () => {
  const r = fixtures({
    "w.yml": job({ steps: run("npx wrangler deploy --config wrangler.central-fix.jsonc --var CERTIFICATION_PILOT_ENABLED:true\nnpx wrangler deploy --config wrangler.certification.generated.jsonc --var CERTIFICATION_X:1\nnpx wrangler deploy --var PUBLIC_FLAG:1") }),
    "scripts/deploy/prepare-central-candidate.py": 'c={"vars":{}}\nc["vars"]["CERTIFICATION_PILOT_ENV"]="sandbox"\nc["vars"]["CERTIFICATION_PILOT_APPROVER"]="x"\nc["vars"]["CERTIFICATION_PILOT_PRODUCTION_ALLOWED"]="false"\nc["vars"]["CERTIFICATION_PILOT_ENABLED"]="true"\nruntime={}\nruntime["MERCADOPAGO_TEST_ACCESS_TOKEN"]="x"\nc["vars"]["CHECKOUT_ENABLED"]="true"\n',
    "wrangler.prod.toml": 'name = "zevanory"\n[vars]\nSANDBOX_MODE = "1"\nPUBLIC = "1"\n',
    "wrangler.certification.toml": '[vars]\nCERTIFICATION_ONLY = "1"\n',
    "wrangler.extra.jsonc": '{ "name": "zevanory", "vars": { "STRIPE_TEST_FLAG": "1", "OK": "1" } }\n',
  });
  assert.deepEqual(of(r, "w.yml"), ["TEST_SECRET_PUT_TO_PRODUCTION:CERTIFICATION_PILOT_ENABLED"], "[G8.1] --var para produção; certificação e nome comum passam");
  assert.deepEqual(of(r, "scripts/deploy/prepare-central-candidate.py"), ["PRODUCTION_CONFIG_TEST_BINDING:CERTIFICATION_PILOT_ENABLED", "PRODUCTION_CONFIG_TEST_BINDING:MERCADOPAGO_TEST_ACCESS_TOKEN"], "[G8.2] só a dívida congelada (3 vars) passa no prepare-central-candidate");
  assert.deepEqual([...of(r, "wrangler.prod.toml"), ...of(r, "wrangler.extra.jsonc")], ["PRODUCTION_CONFIG_TEST_BINDING:SANDBOX_MODE", "PRODUCTION_CONFIG_TEST_BINDING:STRIPE_TEST_FLAG"], "[G8.3] wrangler toml/jsonc de produção");
  assert.deepEqual(of(r, "wrangler.certification.toml"), [], "[G8.3] config de certificação fora do escopo");
});

const retiredJob = (cond) => `name: r\non: workflow_dispatch\njobs:\n  a:\n${cond}    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
const MARK = "    if: ${{ false }} # Permanently retired: teste\n";
test("G9 aposentado não volta em silêncio: if: false e marcador por job, registro em ops/r9-debt.json", () => {
  const reg = debtWith({ retired_workflows: ["ok", "noif", "nomark", "twojobs", "gone"].map((n) => ({ file: n + ".yml", reason: "teste" })) });
  const r = fixtures({
    "ok.yml": retiredJob(MARK),
    "noif.yml": retiredJob("    # Permanently retired: alguém tirou o if\n"),
    "nomark.yml": retiredJob("    if: ${{ false }}\n"),
    "twojobs.yml": retiredJob(MARK) + "  b:\n    if: github.ref == 'refs/heads/gh-pages' # Permanently retired: reativado\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
    "stray.yml": retiredJob(MARK),
    "ops/r9-debt.json": reg,
  });
  assert.deepEqual(of(r, "ok.yml"), [], "[G9.1] aposentado íntegro passa");
  assert.ok(r.violations.some((v) => v.workflow === "noif.yml" && v.job === "a" && /if: \$\{\{ false \}\}/.test(v.detail)), "[G9.2] job sem if: false");
  assert.deepEqual(of(r, "nomark.yml"), ["RETIRED_WORKFLOW_REENABLED:nomark.yml"], "[G9.3] if: false sem marcador");
  assert.ok(r.violations.some((v) => v.workflow === "twojobs.yml" && v.job === "b"), "[G9.4] um segundo job reativado é pego");
  assert.deepEqual(of(r, "gone.yml"), ["RETIRED_WORKFLOW_REENABLED:gone.yml"], "[G9.5] registrado e apagado sem atualizar o registro");
  assert.deepEqual(of(r, "stray.yml"), ["RETIRED_WORKFLOW_REENABLED:stray.yml"], "[G9.6] marcador fora do registro");
});

test("G10 remoção só por workflow_dispatch, confirmação obrigatória, só zevanory e só os 2 nomes", () => {
  const variant = (from, to) => { assert.ok(CLEANUP.includes(from), "[G0.3] âncora: " + from.slice(0, 40)); return CLEANUP.replace(from, to); };
  const run1 = (text) => of(fixtures({ "production-test-secret-cleanup.yml": text }), "production-test-secret-cleanup.yml");
  assert.deepEqual(run1(CLEANUP), [], "[G10.1] o workflow real cumpre o contrato");
  assert.equal(run1(variant("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [gh-pages]\n  workflow_dispatch:")).length, 1, "[G10.2] gatilho de push (merge) é recusado");
  assert.equal(run1(variant("        required: true\n", "        required: false\n")).length, 1, "[G10.3] confirmação opcional é recusada");
  assert.equal(run1(variant('secret delete "$name" --name zevanory', 'secret delete "$name" --name zevanory-sales')).length, 1, "[G10.4] outro Worker é recusado");
  assert.equal(run1(variant("MERCADOPAGO_TEST_ACCESS_TOKEN|MERCADOPAGO_TEST_WEBHOOK_SECRET)", "MERCADOPAGO_TEST_ACCESS_TOKEN|MERCADOPAGO_TEST_WEBHOOK_SECRET|CERTIFICATION_E2E_TOKEN)")).length, 1, "[G10.5] allowlist maior é recusada");
});

test("G11 registro de dívida inválido ou ausente falha", () => {
  const bad = fixtures({ "a.yml": job(), "ops/r9-debt.json": debtWith({ pending: [
    { ...REAL_DEBT.pending[0], planned_pr: "" }, { ...REAL_DEBT.pending[1], status: "CLOSED" }, { ...REAL_DEBT.pending[2], id: REAL_DEBT.pending[3].id }, REAL_DEBT.pending[3]] }) });
  const got = bad.violations.filter((v) => v.rule === "DEBT_REGISTRY_INVALID").map((v) => v.detail).sort();
  assert.deepEqual(got, ["campo obrigatório vazio: planned_pr", "id repetido", "status deve ser OPEN (item resolvido sai da lista)"], "[G11.1] campo vazio, status e id repetido");
  const dir = mkdtempSync(join(tmpdir(), "zev-credgate-nodebt-"));
  try { writeFileSync(join(dir, "a.yml"), job()); const r = gate(dir); assert.equal(r.code, 2, "[G11.2] sem ops/r9-debt.json => código 2"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
