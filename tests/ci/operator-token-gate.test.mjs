// Fora de tests/*.test.mjs de propósito: depende de PyYAML (o gate lê YAML), instalado pelo job r9-operator-token.
// R9 (roteiro v4.7; Sol 164 §4): o gate scripts/ci/operator_token_gate.py, o readback
// scripts/ci/credential_identity_readback.py e scripts/ci/operator-token-github-presence.sh executados de verdade sobre o
// repositório e sobre fixtures em diretório temporário. Cada asserção leva [Kn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "../helpers/toolchain.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATE = join(ROOT, "scripts", "ci", "operator_token_gate.py");
const READBACK = join(ROOT, "scripts", "ci", "credential_identity_readback.py");
const PRESENCE = join(ROOT, "scripts", "ci", "operator-token-github-presence.sh");
const PYENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const RESOLVER_ON = 'export const OPERATOR_TOKEN_LEGACY_FALLBACK = true;\nexport const x = (env) => env.CERTIFICATION_E2E_TOKEN;\n';
const RESOLVER_OFF = 'export const OPERATOR_TOKEN_LEGACY_FALLBACK = false;\n';

function gate(root, extra = []) {
  requireTool("python3");
  const r = spawnSync("python3", [GATE, "--root", root, "--json", ...extra], { encoding: "utf8", env: PYENV });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, "[K0.1] gate sem JSON: " + String(r.stderr || r.stdout).slice(-400));
  return { code: r.status, ...JSON.parse(line) };
}
function fixtures(files, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "zev-optoken-"));
  const all = { "worker/operator-credential.mjs": RESOLVER_ON, ...files };
  for (const [name, text] of Object.entries(all)) { if (text === null) continue; mkdirSync(join(dir, dirname(name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  let res;
  try { res = gate(dir, extra); } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(res.errors, [], "[K0.2] fixture ilegível (o teste não pode passar vazio)");
  return res;
}
const wf = ({ env = "gh-pages-automacao", vars = "", steps = "      - run: echo ok\n", cond = "" } = {}) =>
  `name: f\non: workflow_dispatch\njobs:\n  j:\n${env ? `    environment: ${env}\n` : ""}${cond ? `    if: ${cond}\n` : ""}    runs-on: ubuntu-latest\n${vars ? `    env:\n${vars}` : ""}    steps:\n${steps}`;
const W = (name) => `.github/workflows/${name}`;
const of = (res, file) => res.violations.filter((v) => v.workflow === file).map((v) => v.rule).sort();
const FALLBACK = "      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN }}\n";

test("K1 repositório: transição sem violação; inventário cobre os consumidores", () => {
  const r = gate(ROOT);
  assert.deepEqual(r.violations.map((v) => `${v.workflow}#${v.job}:${v.rule}`), [], "[K1.1] nenhuma violação no repositório");
  assert.equal(r.code, 0, "[K1.1] código 0");
  const forms = Object.fromEntries(r.inventory.map((x) => [`${x.workflow}#${x.job}`, x.form]));
  for (const k of ["central-production-deploy.yml#deploy", "data-backup.yml#backup", "voice-eval.yml#eval", "whatsapp-operational-audit.yml#audit",
    "order12a-financial-proof-renewal.yml#signed-renewal", "zevanory-first-order-watch.yml#first-order-watch"]) {
    assert.equal(forms[k], "new+fallback", "[K1.2] consumidor de produção usa o nome novo com queda: " + k);
  }
  assert.equal(forms["certification-isolated-deploy.yml#certification"], "certification", "[K1.3] certificação mantém a credencial própria");
  assert.deepEqual(r.waived, ["financial-e2e-stripe.yml#stripe-financial-e2e: #910 (4b73b1ee) aponta o job para o Worker de certificação; mover o job para sandbox-financial-approved é o item R9-D6 de ops/r9-debt.json"], "[K1.4] dispensa única, nominal e impressa");
  const strict = gate(ROOT, ["--strict"]);
  assert.equal(strict.code, 1, "[K1.5] modo estrito ainda reprova: a queda só sai depois do readback");
  assert.ok(strict.violations.some((v) => v.rule === "FALLBACK_STILL_ENABLED" && v.workflow === "worker/operator-credential.mjs"), "[K1.5] resolvedor com queda ligada");
});

test("K2 segredo antigo só como queda depois do novo, fora da sandbox", () => {
  const r = fixtures({
    [W("a.yml")]: wf({ vars: "      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
    [W("b.yml")]: wf({ vars: "      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.CERTIFICATION_E2E_TOKEN || secrets.ZEVANORY_OPERATOR_TOKEN }}\n" }),
    [W("c.yml")]: wf({ vars: FALLBACK }),
    [W("d.yml")]: wf({ vars: "      T: ${{ secrets['CERTIFICATION_E2E_TOKEN'] }}\n" }),
    [W("e.yml")]: wf({ vars: "      T: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n", cond: "${{ false }}" }),
    [W("f.yml")]: wf({ vars: "      T: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n", cond: "false && github.event_name == 'x'" }),
    [W("g.yml")]: wf({ env: "sandbox-financial-approved", vars: "      CERTIFICATION_E2E_TOKEN: ${{ secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
  });
  assert.deepEqual(of(r, "a.yml"), ["LEGACY_SECRET_NOT_FALLBACK"], "[K2.1] antigo sozinho sob o nome novo");
  assert.deepEqual(of(r, "b.yml"), ["LEGACY_SECRET_NOT_FALLBACK"], "[K2.2] ordem invertida: o antigo teria prioridade");
  assert.deepEqual(of(r, "c.yml"), [], "[K2.3] forma de transição aceita");
  assert.deepEqual(of(r, "d.yml"), ["LEGACY_SECRET_NOT_FALLBACK"], "[K2.4] sintaxe secrets['X']");
  assert.deepEqual([...of(r, "e.yml"), ...of(r, "f.yml")], [], "[K2.5] job aposentado (if literalmente falso) não é consumidor");
  assert.deepEqual(of(r, "g.yml"), [], "[K2.6] na sandbox o nome antigo é a credencial de certificação");
});

test("K3 nome antigo como variável de job, no run ou em script chamado pelo job", () => {
  const r = fixtures({
    [W("a.yml")]: wf({ vars: "      CERTIFICATION_E2E_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN || secrets.CERTIFICATION_E2E_TOKEN }}\n" }),
    [W("b.yml")]: wf({ vars: FALLBACK, steps: '      - run: |\n          curl -H "x-token: $CERTIFICATION_E2E_TOKEN" https://x\n' }),
    [W("c.yml")]: wf({ vars: FALLBACK, steps: "      - run: python3 scripts/legacy.py\n" }),
    [W("d.yml")]: wf({ vars: FALLBACK, steps: "      - run: python3 scripts/names.py && node scripts/new.mjs\n" }),
    [W("e.yml")]: wf({ vars: FALLBACK, steps: "      - env:\n          CERTIFICATION_E2E_TOKEN: x\n        run: echo\n" }),
    [W("f.yml")]: wf({ env: null, steps: "      - run: python3 scripts/legacy.py\n" }),
    "scripts/legacy.py": 'import os\nT=os.environ.get("CERTIFICATION_E2E_TOKEN","")\n',
    "scripts/names.py": 'NAMES=["CERTIFICATION_E2E_TOKEN"]  # dado, não leitura\n',
    "scripts/new.mjs": 'const t=process.env.ZEVANORY_OPERATOR_TOKEN;\n',
  });
  assert.deepEqual(r.errors, [], "[K3.0] fixtures legíveis");
  assert.deepEqual(of(r, "a.yml"), ["LEGACY_ENV_NAME_IN_PRODUCTION"], "[K3.1] variável de job com o nome antigo");
  assert.deepEqual(of(r, "b.yml"), ["LEGACY_READ_IN_PRODUCTION_RUN"], "[K3.2] run lê a variável antiga");
  assert.deepEqual(of(r, "c.yml"), ["PRODUCTION_SCRIPT_READS_LEGACY"], "[K3.3] script do job lê o nome antigo (descoberta automática)");
  assert.deepEqual(of(r, "d.yml"), [], "[K3.4] citar o nome como dado não é leitura");
  assert.deepEqual(of(r, "e.yml"), ["LEGACY_ENV_NAME_IN_PRODUCTION"], "[K3.5] env de passo");
  assert.deepEqual(of(r, "f.yml"), [], "[K3.6] job sem acesso a nenhum dos dois segredos não é consumidor");
});

test("K4 credencial de produção nunca em job sandbox; Worker só lê pelo resolvedor", () => {
  const r = fixtures({
    [W("a.yml")]: wf({ env: "sandbox-financial-approved", vars: "      T: ${{ secrets.ZEVANORY_OPERATOR_TOKEN }}\n" }),
    [W("b.yml")]: wf({ env: "sandbox-financial-approved", vars: "      ZEVANORY_OPERATOR_TOKEN: x\n" }),
    "worker/consumer.mjs": "export const a=(env)=>env.CERTIFICATION_E2E_TOKEN;\n",
    "worker/fine.mjs": 'import { operatorToken } from "./operator-credential.mjs";\n',
  });
  assert.deepEqual(of(r, "a.yml"), ["OPERATOR_TOKEN_IN_SANDBOX"], "[K4.1] segredo de operador num job sandbox");
  assert.deepEqual(of(r, "b.yml"), ["OPERATOR_TOKEN_IN_SANDBOX"], "[K4.2] chave de env com o nome novo num job sandbox");
  assert.deepEqual(of(r, "worker/consumer.mjs"), ["WORKER_READS_LEGACY"], "[K4.3] módulo do Worker lendo o nome antigo");
  assert.deepEqual([...of(r, "worker/fine.mjs"), ...of(r, "worker/operator-credential.mjs")], [], "[K4.4] o resolvedor é o único leitor");
  const missing = fixtures({ "worker/operator-credential.mjs": null, [W("c.yml")]: wf({ vars: FALLBACK }) });
  assert.deepEqual(of(missing, "worker/operator-credential.mjs"), ["WORKER_READS_LEGACY"], "[K4.5] resolvedor ausente reprova");
});

test("K5 modo estrito (seguimento): nenhuma queda resta", () => {
  const files = { [W("a.yml")]: wf({ vars: FALLBACK }), [W("b.yml")]: wf({ vars: "      ZEVANORY_OPERATOR_TOKEN: ${{ secrets.ZEVANORY_OPERATOR_TOKEN }}\n" }) };
  const on = fixtures(files, ["--strict"]);
  assert.deepEqual(of(on, "a.yml"), ["FALLBACK_STILL_ENABLED"], "[K5.1] queda no workflow reprovada no estrito");
  assert.deepEqual(of(on, "worker/operator-credential.mjs"), ["FALLBACK_STILL_ENABLED"], "[K5.2] queda no resolvedor reprovada no estrito");
  const off = fixtures({ [W("b.yml")]: files[W("b.yml")], "worker/operator-credential.mjs": RESOLVER_OFF }, ["--strict"]);
  assert.deepEqual([off.code, off.violations], [0, []], "[K5.3] só o nome novo e queda desligada passam no estrito");
});

function serve(body, status = 200) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => { seen.push({ path: req.url, token: req.headers["x-certification-e2e-token"] }); res.writeHead(status, { "content-type": "application/json" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
function readback(base, args = [], token = "synthetic-readback-token-0123456789abcdef") {
  return new Promise((resolve) => {
    const env = { ...PYENV, ZEVANORY_OPERATOR_TOKEN: token };
    if (token === null) delete env.ZEVANORY_OPERATOR_TOKEN;
    const p = spawn("python3", [READBACK, base, "--attempts", "1", ...args], { env });
    let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
const BODY = (over = {}) => ({ schema: "zevanory.audit.credential-identity/v1", operator_token_source: "primary", operator_token_fallback_uses_in_isolate: 0,
  stripe_key_mode: "live", certification_perimeter: false, release_sha: null, ...over });

test("K6 readback: só categorias; chave Stripe de teste, perímetro e resposta inválida reprovam", async () => {
  requireTool("python3");
  const cases = [
    [BODY(), [], 0, ["OPERATOR_TOKEN_SOURCE=primary", "STRIPE_KEY_MODE=live", "CERTIFICATION_PERIMETER=false", "R9_CREDENTIAL_IDENTITY=PASS"]],
    [BODY({ stripe_key_mode: "absent", operator_token_source: "legacy_fallback" }), [], 0, ["STRIPE_KEY_MODE=absent", "OPERATOR_TOKEN_SOURCE=legacy_fallback"]],
    [BODY({ stripe_key_mode: "test" }), [], 1, ["STRIPE_KEY_MODE=test", "STRIPE_KEY_NOT_LIVE_OR_ABSENT"]],
    [BODY({ stripe_key_mode: "unrecognized" }), [], 1, ["STRIPE_KEY_MODE=unrecognized"]],
    [BODY({ stripe_key_mode: "sk_test_leak" }), [], 1, ["STRIPE_KEY_MODE=unverified"]],
    [BODY({ certification_perimeter: true }), [], 1, ["PRODUCTION_PERIMETER_UNPROVEN"]],
    [BODY({ schema: "other" }), [], 1, ["STRIPE_KEY_MODE=unverified", "READBACK_UNVERIFIED"]],
    [BODY({ operator_token_source: "legacy_fallback" }), ["--require-primary"], 1, ["OPERATOR_TOKEN_NOT_PRIMARY"]],
    [BODY(), ["--require-primary"], 0, ["R9_CREDENTIAL_IDENTITY=PASS"]],
  ];
  for (const [i, [body, args, code, expect]] of cases.entries()) {
    const s = await serve(body);
    try {
      const r = await readback(s.base, args);
      assert.equal(r.code, code, `[K6.1] caso ${i}: código ${r.code} :: ${r.out}`);
      for (const e of expect) assert.ok(r.out.includes(e), `[K6.2] caso ${i}: saída contém ${e} :: ${r.out}`);
      assert.ok(!r.out.includes("synthetic-readback-token") && !r.out.includes("sk_test_leak"), `[K6.3] caso ${i}: nenhum valor na saída`);
      assert.deepEqual(s.seen.map((x) => x.path), ["/api/internal/audit/credential-identity"], `[K6.4] caso ${i}: só a rota de auditoria`);
    } finally { s.server.close(); }
  }
  const denied = await serve({ error: "unauthorized" }, 401);
  try {
    const r = await readback(denied.base);
    assert.equal(r.code, 1, "[K6.5] 401 reprova");
    assert.ok(r.out.includes("STRIPE_KEY_MODE=unverified") && r.out.includes("READBACK_HTTP=401"), "[K6.5] categoria unverified");
  } finally { denied.server.close(); }
  const r = await readback("http://127.0.0.1:9", [], null);
  assert.equal(r.code, 2, "[K6.6] sem credencial no runner: uso inválido");
});

test("K7 presença no Environment do GitHub: só present/absent e igualdade booleana", () => {
  requireTool("bash");
  const sh = (env) => spawnSync("bash", [PRESENCE, "producao-critica"], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  const same = sh({ R9_NEW: "value-A", R9_LEGACY: "value-A" });
  assert.equal(same.status, 0, "[K7.1] mesmo valor passa");
  assert.match(same.stdout, /GITHUB_PRODUCAO_CRITICA_ZEVANORY_OPERATOR_TOKEN=present\nGITHUB_PRODUCAO_CRITICA_CERTIFICATION_E2E_TOKEN=present\nGITHUB_PRODUCAO_CRITICA_OPERATOR_TOKEN_VALUES_EQUAL=true/, "[K7.1] categorias");
  const diff = sh({ R9_NEW: "value-A", R9_LEGACY: "value-B" });
  assert.equal(diff.status, 1, "[K7.2] valores diferentes na transição reprovam");
  const legacyOnly = sh({ R9_LEGACY: "value-B" });
  assert.equal(legacyOnly.status, 0, "[K7.3] só o antigo: passa sem exigência");
  assert.match(legacyOnly.stdout, /ZEVANORY_OPERATOR_TOKEN=absent/, "[K7.3] novo ausente relatado");
  assert.equal(sh({ R9_LEGACY: "value-B", REQUIRE_PRIMARY: "true" }).status, 1, "[K7.4] com require_primary o novo é obrigatório");
  for (const r of [same, diff, legacyOnly]) assert.ok(!(r.stdout + r.stderr).includes("value-"), "[K7.5] nenhum valor na saída");
});
