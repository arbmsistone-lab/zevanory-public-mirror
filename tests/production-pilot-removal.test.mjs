// R9 B (roteiro v4.7; auditoria Sol 164 §4): o piloto de certificação não existe no Worker de produção, provado pelo
// COMPORTAMENTO do código real (sonda tests/helpers/pilot-removal-probe.mjs):
//   B1 com TODO o piloto ligado (CERTIFICATION_PILOT_ENABLED=true, ENV=sandbox, PRODUCTION_ALLOWED=true, PAYMENT_MODE=sandbox,
//      APPROVER, credenciais de TESTE, MERCADOPAGO_ENV=sandbox, credencial de operador válida) a produção recusa todo
//      caminho de pagamento sandbox/sintético, nas quatro formas de injeção (vars, runtime config objeto/texto, process.env),
//      sem nenhuma chamada ao Mercado Pago.
//   B2 controles: os mesmos handlers sem a entrada de produção aceitam o piloto (o teste não é vazio) e o Worker de
//      certificação mantém o piloto dele.
//   B3 productionEnvView: esconde por get/has/ownKeys, filtra ZEVANORY_RUNTIME_CONFIG, limpa process.env, preserva o
//      perímetro de certificação.
//   B4 toda entrada do Worker de produção (fetch, scheduled, queue, email) passa pela vista.
//   B5-B7 deploy: o preparador real não grava piloto (e remove o herdado e keep_vars) e o verificador real exige a ausência.
// Sem rede, sem segredo real, sem banco. Cada asserção leva um marcador [Bn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTool } from "./helpers/toolchain.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/pilot-removal-probe.mjs"],
  { cwd: ROOT, encoding: "utf8", timeout: 150000, env: { ...process.env, NODE_OPTIONS: "" } });
const line = String(run.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
function probed() {
  assert.ok(probe && !probe.timeout && !probe.out?.error, "[B0.1] sonda sem resultado: " + String(probe?.out?.error || run.stderr || "").slice(-400));
  assert.deepEqual(probe.blocked, [], "[B0.2] chamada externa inesperada");
  return probe.out;
}
const VARIANTS = ["vars", "runtime_object", "runtime_string", "process_env"];
// Recusa esperada por caminho (motivo fail-closed do próprio código, não 401/404 genérico).
const REFUSAL = {
  pilot_checkout: [503, "certification_checkout_not_isolated"],
  certification_invite: [409, "certification_e2e_not_fail_closed"],
  sandbox_status: [409, "certification_e2e_not_fail_closed"],
  sandbox_checkout: [409, "certification_e2e_not_fail_closed"],
  operator_invite_event: [503, "certification_pilot_approver_not_configured"],
  asaas_pix_refund_authorization: [409, "fail_closed_environment_required"],
};

test("B1 produção com CERTIFICATION_PILOT_ENABLED=true recusa todo fluxo de pagamento sandbox/piloto (fail-closed)", () => {
  const out = probed();
  for (const variant of VARIANTS) {
    for (const [path, [status, error]] of Object.entries(REFUSAL)) {
      const r = out.production[variant]?.[path];
      assert.ok(r, "[B1.0] cenário ausente: " + variant + "/" + path);
      assert.deepEqual([r.status, r.error], [status, error], `[B1.1] ${variant}/${path}: recusa fail-closed (obtido ${r.status} ${r.error})`);
      assert.equal(r.mp_calls, 0, `[B1.2] ${variant}/${path}: nenhuma chamada ao Mercado Pago`);
    }
    assert.equal(out.production[variant].asaas_pix_refund_authorization.status_field, "REFUSED", `[B1.3] ${variant}: estorno Pix sintético do Asaas recusado`);
    assert.deepEqual(out.production[variant].process_env_after, [], `[B1.4] ${variant}: nenhuma CERTIFICATION_PILOT_* resta em process.env`);
  }
});

test("B2 controles: sem a entrada de produção o piloto existe; o Worker de certificação mantém o dele", () => {
  const c = probed().controls;
  assert.notEqual(c.sandbox_status_raw.error, "certification_e2e_not_fail_closed", "[B2.1] env cru passa a trava do sandbox v2 (o teste B1 não é vazio)");
  assert.equal(c.asaas_raw.status_field, "APPROVED", "[B2.2] env cru aprovaria o estorno Pix sintético");
  assert.equal(c.operator_invite_node_raw.error, "operational_storage_unavailable", "[B2.3] env cru passa do aprovador do convite (para no banco)");
  assert.equal(c.certification_status.status, 200, "[B2.4] certificação: status do piloto disponível");
  assert.notEqual(c.certification_checkout.error, "certification_e2e_not_fail_closed", "[B2.5] certificação: checkout sandbox não é recusado pela trava");
});

test("B3 productionEnvView esconde o piloto em todas as formas e preserva o resto", async () => {
  const { productionEnvView, scrubPilotFromProcessEnv, HIDDEN_PILOT_NAMES } = await import("../worker/production-pilot-guard.mjs");
  const env = { CERTIFICATION_PILOT_ENABLED: "true", CERTIFICATION_PILOT_ENV: "sandbox", KEEP: "1", CERTIFICATION_E2E_TOKEN: "x",
    ZEVANORY_RUNTIME_CONFIG: { CERTIFICATION_PILOT_APPROVER: "a", OTHER: "2" } };
  const v = productionEnvView(env);
  assert.equal(v.CERTIFICATION_PILOT_ENABLED, undefined, "[B3.1] get esconde");
  assert.equal("CERTIFICATION_PILOT_ENV" in v, false, "[B3.1] has esconde");
  assert.deepEqual(Object.keys(v).sort(), ["CERTIFICATION_E2E_TOKEN", "KEEP", "ZEVANORY_RUNTIME_CONFIG"], "[B3.2] ownKeys/Object.keys sem piloto");
  assert.deepEqual(Reflect.ownKeys(v).filter((k) => String(k).startsWith("CERTIFICATION_PILOT_")), [], "[B3.2] Reflect.ownKeys sem piloto");
  assert.equal(Object.getOwnPropertyDescriptor(v, "CERTIFICATION_PILOT_ENABLED"), undefined, "[B3.2] descritor escondido");
  assert.deepEqual({ ...v }.CERTIFICATION_PILOT_ENABLED, undefined, "[B3.2] spread sem piloto");
  assert.deepEqual(v.ZEVANORY_RUNTIME_CONFIG, { OTHER: "2" }, "[B3.3] runtime config objeto filtrado");
  assert.equal(v.KEEP, "1", "[B3.4] o resto passa");
  assert.deepEqual(v[HIDDEN_PILOT_NAMES], ["CERTIFICATION_PILOT_ENABLED", "CERTIFICATION_PILOT_ENV", "ZEVANORY_RUNTIME_CONFIG.CERTIFICATION_PILOT_APPROVER"], "[B3.5] só nomes escondidos");
  const s = productionEnvView({ ZEVANORY_RUNTIME_CONFIG: JSON.stringify({ CERTIFICATION_PILOT_ENABLED: "true", A: "1" }) });
  assert.deepEqual(JSON.parse(s.ZEVANORY_RUNTIME_CONFIG), { A: "1" }, "[B3.3] runtime config texto filtrado");
  assert.equal(productionEnvView({ ZEVANORY_RUNTIME_CONFIG: "not-json" }).ZEVANORY_RUNTIME_CONFIG, "not-json", "[B3.4] texto não JSON passa intacto");
  process.env.CERTIFICATION_PILOT_ENV = "sandbox";
  productionEnvView({ KEEP: "1" });
  assert.equal(process.env.CERTIFICATION_PILOT_ENV, undefined, "[B3.6] restos em process.env são apagados na entrada de produção");
  process.env.CERTIFICATION_PILOT_X = "1";
  assert.equal(scrubPilotFromProcessEnv(), 1, "[B3.6] limpeza conta o que removeu");
  const cert = { ZEVANORY_DEPLOYMENT_ENV: "certification", CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_PILOT_ENV: "sandbox" };
  assert.equal(productionEnvView(cert) === cert, true, "[B3.7] perímetro de certificação: env intacto (piloto legítimo)");
  const polluted = { ...cert, MERCADOPAGO_ACCESS_TOKEN: "APP_USR-x" };
  assert.equal(productionEnvView(polluted).CERTIFICATION_PILOT_ENV, undefined, "[B3.8] marcas de certificação com credencial de produção: piloto escondido");
});

test("B4 toda entrada do Worker de produção passa pela vista antes do runtime", () => {
  const src = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
  const all = src.match(/normalizeEnv\(/g) || [];
  const wrapped = src.match(/normalizeEnv\(productionEnvView\(/g) || [];
  assert.ok(all.length >= 4, "[B4.1] entradas encontradas: " + all.length);
  assert.equal(wrapped.length, all.length, `[B4.1] ${all.length - wrapped.length} chamada(s) a normalizeEnv sem productionEnvView`);
  for (const entry of ["async processFetch(request, env, ctx)", "wrapped.scheduled = async", "wrapped.queue = async", "wrapped.email = async"]) {
    const at = src.indexOf(entry);
    assert.ok(at >= 0, "[B4.2] entrada ausente: " + entry);
    assert.match(src.slice(at, at + 600), /normalizeEnv\(productionEnvView\(/, "[B4.2] vista aplicada em " + entry);
  }
});

test("B5 deploy de produção: não grava piloto e exige a ausência", () => {
  const prep = readTextNormalized(new URL("../scripts/deploy/prepare-central-candidate.py", import.meta.url));
  const verify = readTextNormalized(new URL("../scripts/deploy/verify-financial-boundary.py", import.meta.url));
  assert.doesNotMatch(prep, /\[\s*["']vars["']\s*\]\s*\[\s*["']CERTIFICATION_PILOT_/, "[B5.1] preparador não grava CERTIFICATION_PILOT_*");
  assert.match(verify, /NO_PRODUCTION_PILOT_BINDING/, "[B5.2] verificador exige ausência");
  assert.doesNotMatch(verify, /CERTIFICATION_PILOT_MUST_BE_SANDBOX|== "sandbox", "CERTIFICATION_PILOT/, "[B5.2] não exige mais sandbox/false");
});

const PYENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const CLOSED = { SALE_GLOBALLY_ENABLED: "false", WHATSAPP_SALES_ENABLED: "false", ASAAS_ENV: "sandbox", PAYMENT_PROVIDER: "mercadopago",
  MERCADOPAGO_ENV: "sandbox", ABSOLUTE_RELEASE_APPROVED: "false", PRE_SALE_GATES_APPROVED: "false", ZEVANORY_RUNTIME_CONFIG: {} };
const LAUNCH = { ZEVANORY_LAUNCH_AUTHORIZATION: "AUTORIZO COMPRA REAL", MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16: "e".repeat(16), MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED: "true" };
function verify(config, extraEnv = {}) {
  requireTool("python3");
  const dir = mkdtempSync(join(tmpdir(), "zev-r9-boundary-"));
  try {
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify(config));
    const r = spawnSync("python3", [join(ROOT, "scripts", "deploy", "verify-financial-boundary.py")], { cwd: dir, encoding: "utf8", env: { ...PYENV, ZEVANORY_LAUNCH_AUTHORIZATION: "", ...extraEnv } });
    return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("B6 verificador real de fronteira: exige AUSÊNCIA de CERTIFICATION_PILOT_* e proíbe keep_vars", () => {
  const ok = verify({ vars: { ...CLOSED } });
  assert.equal(ok.code, 0, "[B6.1] configuração fechada sem piloto passa: " + ok.out.slice(-200));
  assert.match(ok.out, /PRODUCTION_PILOT_BINDINGS=ABSENT/, "[B6.1] ausência relatada");
  for (const [name, value] of [["CERTIFICATION_PILOT_ENV", "sandbox"], ["CERTIFICATION_PILOT_PRODUCTION_ALLOWED", "false"], ["CERTIFICATION_PILOT_ENABLED", "true"], ["CERTIFICATION_PILOT_APPROVER", "x"]]) {
    const r = verify({ vars: { ...CLOSED, [name]: value } });
    assert.notEqual(r.code, 0, "[B6.2] piloto na configuração de produção reprova: " + name);
    assert.match(r.out, new RegExp("NO_PRODUCTION_PILOT_BINDING:" + name), "[B6.2] motivo com o nome: " + name);
  }
  const nested = verify({ vars: { ...CLOSED, ZEVANORY_RUNTIME_CONFIG: { CERTIFICATION_PILOT_ENABLED: "true" } } });
  assert.match(nested.out, /NO_PRODUCTION_PILOT_BINDING:ZEVANORY_RUNTIME_CONFIG\.CERTIFICATION_PILOT_ENABLED/, "[B6.3] piloto dentro do runtime config reprova");
  const keep = verify({ keep_vars: true, vars: { ...CLOSED } });
  assert.notEqual(keep.code, 0, "[B6.4] keep_vars manteria a var do painel: reprova");
  assert.match(keep.out, /DASHBOARD_VARS_MUST_NOT_SURVIVE_DEPLOY/, "[B6.4] motivo");
});

test("B7 preparador real: não grava piloto, remove o herdado e keep_vars; a saída passa no verificador", () => {
  requireTool("python3");
  const dir = mkdtempSync(join(tmpdir(), "zev-r9-prepare-"));
  try {
    mkdirSync(join(dir, "worker")); mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify({ keep_vars: true, kv_namespaces: [],
      vars: { CERTIFICATION_PILOT_ENABLED: "true", CERTIFICATION_PILOT_ENV: "sandbox", ZEVANORY_RUNTIME_CONFIG: { CERTIFICATION_PILOT_APPROVER: "a", KEEP: "1" } } }));
    writeFileSync(join(dir, "worker", "binding-aliases.mjs"), "return Reflect.get(target, prop, receiver);\nreturn Reflect.has(target, prop);\n");
    writeFileSync(join(dir, "worker", "cloudflare-worker.recovered.mjs"), '    }\n    if (provider === "stripe") {\nconst pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE || "").toLowerCase() === "sandbox";\nconst commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;\n');
    writeFileSync(join(dir, "public", "solucoes.html"), "<!doctype html><title>Solucoes</title>");
    writeFileSync(join(dir, "public", "sitemap.xml"), "<urlset></urlset>");
    const r = spawnSync("python3", [join(ROOT, "scripts", "deploy", "prepare-central-candidate.py")], { cwd: dir, encoding: "utf8",
      env: { ...PYENV, PUBLIC_OWNER_ACCOUNT_ID: "f".repeat(32), TARGET_RUNTIME_SHA: "a".repeat(40), ...LAUNCH } });
    assert.equal(r.status, 0, "[B7.0] preparador roda: " + String(r.stderr).slice(-300));
    const config = JSON.parse(readTextNormalized(join(dir, "wrangler.central-fix.jsonc")));
    assert.deepEqual(Object.keys(config.vars).filter((k) => k.startsWith("CERTIFICATION_PILOT_")), [], "[B7.1] nenhuma CERTIFICATION_PILOT_* nas vars de produção");
    assert.deepEqual(Object.keys(config.vars.ZEVANORY_RUNTIME_CONFIG).filter((k) => k.startsWith("CERTIFICATION_PILOT_")), [], "[B7.2] nem no runtime config");
    assert.equal(config.vars.ZEVANORY_RUNTIME_CONFIG.KEEP, "1", "[B7.2] o resto do runtime config fica");
    assert.equal("keep_vars" in config, false, "[B7.3] keep_vars removido: o deploy apaga as vars do painel");
    // Mesmo modo do deploy real (o preparador liga o atendimento WhatsApp, que o verificador só aceita com a ordem do dono).
    const v = verify(config, LAUNCH);
    assert.equal(v.code, 0, "[B7.4] a saída do preparador passa no verificador: " + v.out.slice(-200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
