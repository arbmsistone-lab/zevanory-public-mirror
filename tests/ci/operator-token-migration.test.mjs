// Fora de tests/*.test.mjs de propósito: depende de bash (com `date` substituível no PATH) e de PyYAML não, mas roda no
// job r9-operator-token junto com o gate. Sol 233: janela TEMPORÁRIA de dupla aceitação da credencial de operador.
// O proprietário cria um valor NOVO para ZEVANORY_OPERATOR_TOKEN (não é cópia de CERTIFICATION_E2E_TOKEN). Provado pelo
// COMPORTAMENTO do código real:
//   M1 resolvedor (worker/operator-credential.mjs): primária aceita; antiga aceita só DENTRO da janela; fora dela
//      (ausente, vencida, malformada, acima do teto em código) recusada; desconhecida recusada; nada configurado = recusa;
//      fim da janela exato (23:59:59.999Z); comportamento de hoje preservado sem a flag.
//   M2 registro só por categoria: nenhum valor, tamanho ou hash nos logs.
//   M3 Worker REAL de produção (sonda tests/helpers/operator-token-migration-probe.mjs): toda rota de operador segue M1.
//   M4 handlers diretos (voz, pós-venda, reembolso, sandbox v2, auditoria, sonda assinada HMAC) seguem M1.
//   M5 presença no GitHub (operator-token-github-presence.sh): valores diferentes só com a janela aberta.
//   M6 readback --require-primary: exige que a credencial do runner autentique como PRIMÁRIA (não como antiga).
//   M7 deploy: o preparador grava a flag só válida e <= teto, dentro de ZEVANORY_RUNTIME_CONFIG; o verificador confere.
//   M8 o teto em código é o mesmo no Worker, no script de presença, no preparador e no verificador.
// Sem rede, sem segredo real, sem banco. Cada asserção leva [Mn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "../helpers/toolchain.mjs";
import { readTextNormalized } from "../helpers/text.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NEW = "synthetic-NEW-operator-token-0123456789abcdef0123";
const OLD = "synthetic-OLD-operator-token-fedcba9876543210fedc";
const UNKNOWN = "synthetic-UNK-operator-token-a1b2c3d4e5f6a7b8c9d0";
const PYENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

async function resolver(tag) {
  return import(new URL("../../worker/operator-credential.mjs?" + tag, import.meta.url).href);
}
const ceilingOf = async () => (await resolver("ceiling")).MIGRATION_CODE_CEILING;
// Data "aberta" para os testes que usam o relógio real: hoje + 7 dias, limitada ao teto em código.
async function openDay() {
  const ceiling = await ceilingOf();
  const today = iso(Date.now());
  assert.ok(today <= ceiling, `[M0.1] o teto em código (${ceiling}) já passou: o PR A2 precisa remover a janela de migração`);
  const plus7 = iso(Date.now() + 7 * DAY);
  return plus7 <= ceiling ? plus7 : ceiling;
}

test("M1 resolvedor: primária sempre; antiga só dentro da janela; desconhecida e nada configurado recusam", async () => {
  const m = await resolver("m1");
  const quiet = { info() {}, warn() {} };
  const now = Date.parse("2026-11-10T12:00:00Z");
  const both = { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD };
  const open = { ...both, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" };
  const v = (env, token, extra = {}) => m.verifyOperatorToken(env, token, { now, log: quiet, ...extra });
  assert.equal(v(both, NEW), "primary", "[M1.1] primária aceita sem janela");
  assert.equal(v(open, NEW), "primary", "[M1.1] primária aceita dentro da janela");
  assert.equal(v(open, OLD), "legacy", "[M1.2] antiga aceita dentro da janela");
  assert.equal(v({ ...both, ZEVANORY_RUNTIME_CONFIG: { OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" } }, OLD), "legacy", "[M1.2] flag em ZEVANORY_RUNTIME_CONFIG (objeto)");
  assert.equal(v({ ...both, ZEVANORY_RUNTIME_CONFIG: JSON.stringify({ OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }) }, OLD), "legacy", "[M1.2] flag em ZEVANORY_RUNTIME_CONFIG (texto JSON)");
  for (const [label, flag] of [["ausente", undefined], ["vazia", ""], ["vencida", "2026-11-09"], ["malformada", "2026-11-31"], ["formato livre", "20 nov 2026"],
    ["com hora", "2026-11-20T00:00:00Z"], ["acima do teto", "2027-01-15"]]) {
    const env = flag === undefined ? both : { ...both, OPERATOR_TOKEN_MIGRATION_UNTIL: flag };
    assert.equal(v(env, OLD), "", `[M1.3] antiga recusada fora da janela (${label})`);
    assert.equal(v(env, NEW), "primary", `[M1.3] primária continua aceita (${label})`);
  }
  assert.equal(v(open, UNKNOWN), "", "[M1.4] valor desconhecido recusado dentro da janela");
  assert.equal(v(both, UNKNOWN), "", "[M1.4] valor desconhecido recusado fora da janela");
  assert.equal(v(open, ""), "", "[M1.4] credencial vazia recusada");
  assert.equal(v({ OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, ""), "", "[M1.5] nada configurado: recusa (fail-closed)");
  assert.equal(v({ OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, NEW), "", "[M1.5] nada configurado: nenhum valor autentica");
  assert.equal(v({}, OLD), "", "[M1.5] env vazio: recusa");
  const end = Date.parse("2026-11-20T23:59:59.999Z");
  assert.equal(m.verifyOperatorToken(open, OLD, { now: end, log: quiet }), "legacy", "[M1.6] último milissegundo do dia da flag: aberta");
  assert.equal(m.verifyOperatorToken(open, OLD, { now: end + 1, log: quiet }), "", "[M1.6] um milissegundo depois: fechada");
  assert.deepEqual({ ...m.operatorTokenMigration(open, { now: end + 1 }) }, { open: false, state: "expired" }, "[M1.6] estado vencido");
  assert.equal(m.operatorTokenMigration({ OPERATOR_TOKEN_MIGRATION_UNTIL: m.MIGRATION_CODE_CEILING }, { now: Date.parse(m.MIGRATION_CODE_CEILING + "T12:00:00Z") }).open, true, "[M1.6] o próprio teto ainda abre");
  assert.equal(m.operatorTokenMigration({ OPERATOR_TOKEN_MIGRATION_UNTIL: "2027-01-01" }, { now }).state, "beyond_code_ceiling", "[M1.6] acima do teto não abre");
  assert.equal(v({ CERTIFICATION_E2E_TOKEN: OLD }, OLD), "legacy_fallback", "[M1.7] sem o nome novo: queda de hoje (inalterada)");
  assert.equal(v({ CERTIFICATION_E2E_TOKEN: OLD, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, NEW), "", "[M1.7] sem o nome novo o valor novo não autentica");
  assert.equal(v({ ZEVANORY_OPERATOR_TOKEN: "short", CERTIFICATION_E2E_TOKEN: OLD, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, "short"), "", "[M1.8] primária curta recusada (mínimo do consumidor)");
  assert.equal(v({ ZEVANORY_OPERATOR_TOKEN: "short", CERTIFICATION_E2E_TOKEN: OLD, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, OLD), "legacy", "[M1.8] na janela a antiga vale mesmo com a nova curta");
  const cert = { ZEVANORY_DEPLOYMENT_ENV: "certification", CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_E2E_TOKEN: OLD, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" };
  assert.equal(v(cert, OLD), "certification", "[M1.9] perímetro de certificação inalterado");
  assert.equal(v(cert, NEW), "", "[M1.9] perímetro não aceita outro valor");
});

test("M2 registro só por categoria: nenhum valor, tamanho ou hash", async () => {
  const m = await resolver("m2");
  const lines = [];
  const log = { info: (...a) => lines.push(a.map(String).join(" ")), warn: (...a) => lines.push(a.map(String).join(" ")) };
  const now = Date.parse("2026-11-10T12:00:00Z");
  const open = { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" };
  for (const t of [NEW, OLD, UNKNOWN, NEW, OLD]) m.verifyOperatorToken(open, t, { now, log });
  assert.deepEqual(lines, ['operator_token_auth {"category":"primary"}', 'operator_token_auth {"category":"legacy"}', 'operator_token_auth {"category":"none"}'],
    "[M2.1] uma linha por categoria por isolate, só a categoria");
  const counts = m.operatorAuthCounts();
  assert.deepEqual([counts.primary, counts.legacy, counts.none], [2, 2, 1], "[M2.2] contadores por categoria");
  const all = lines.join("\n") + JSON.stringify(counts);
  for (const secret of [NEW, OLD, UNKNOWN]) assert.ok(!all.includes(secret) && !all.includes(String(secret.length)), "[M2.1] nenhum valor ou tamanho");
  assert.doesNotMatch(all, /[0-9a-f]{16,}/, "[M2.1] nenhum hash");
});

let probeCache = null;
async function probed() {
  if (probeCache) return probeCache;
  const day = await openDay();
  const run = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/operator-token-migration-probe.mjs", day],
    { cwd: ROOT, encoding: "utf8", timeout: 150000, env: { ...process.env, NODE_OPTIONS: "" } });
  const line = String(run.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
  assert.ok(probe && !probe.timeout && !probe.out?.error, "[M3.0] sonda sem resultado: " + String(probe?.out?.error || run.stderr || "").slice(-400));
  assert.deepEqual(probe.blocked, [], "[M3.0] chamada externa inesperada");
  probeCache = { out: probe.out, text: String(run.stdout || "") + String(run.stderr || "") };
  return probeCache;
}
const ROUTES = ["backup_run", "funnel_run", "voice_eval_run", "audit_credential_identity", "telegram_proof", "channel_evidence",
  "whatsapp_stats_refresh", "voice_audit", "node_e2e_status"];
const OPEN_VARIANTS = ["open_var", "open_runtime_object", "open_runtime_string"];
const CLOSED_VARIANTS = ["expired", "malformed", "beyond_ceiling", "absent"];

test("M3 Worker real de produção: janela aberta aceita as duas; fechada só a primária; desconhecida e nada configurado recusam", async () => {
  const { out, text } = await probed();
  for (const variant of [...OPEN_VARIANTS, ...CLOSED_VARIANTS]) {
    for (const route of ROUTES) {
      const r = out[variant]?.[route];
      assert.ok(r, "[M3.0] cenário ausente: " + variant + "/" + route);
      assert.notEqual(r.new.status, 401, `[M3.1] ${variant}/${route}: primária autentica (${r.new.status} ${r.new.error})`);
      assert.equal(r.unknown.status, 401, `[M3.4] ${variant}/${route}: valor desconhecido recusado (${r.unknown.status})`);
      if (OPEN_VARIANTS.includes(variant)) assert.notEqual(r.old.status, 401, `[M3.2] ${variant}/${route}: antiga aceita dentro da janela (${r.old.status} ${r.old.error})`);
      else assert.equal(r.old.status, 401, `[M3.3] ${variant}/${route}: antiga recusada fora da janela (${r.old.status})`);
    }
  }
  for (const route of ROUTES) {
    const r = out.none_configured[route];
    assert.deepEqual([r.new.status, r.old.status, r.unknown.status], [401, 401, 401], `[M3.5] ${route}: sem nenhum dos dois nomes, recusa (fail-closed)`);
  }
  const id = out.open_var.audit_credential_identity;
  assert.deepEqual([id.new.presented, id.old.presented, id.new.migration], ["primary", "legacy", "open"], "[M3.6] readback: categoria apresentada e estado da janela");
  assert.equal(out.expired.audit_credential_identity.new.migration, "expired", "[M3.6] janela vencida relatada");
  for (const secret of [NEW, OLD, UNKNOWN]) assert.ok(!text.includes(secret), "[M3.7] nenhum valor de credencial na saída do Worker");
  assert.ok(text.includes('operator_token_auth {"category":"legacy"}'), "[M3.7] uso da antiga registrado por categoria");
});

const kv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
};
async function statusOf(fn) {
  try { const r = await fn(); return r ? r.status : null; } catch (e) { return "throw:" + String(e?.message || e).slice(0, 60); }
}

test("M4 handlers diretos e sonda assinada seguem a janela", async () => {
  const day = await openDay();
  const { handleVoiceEncodeAudit } = await import("../../worker/voice-chunks.mjs");
  const { handlePostSale } = await import("../../worker/post-sale.mjs");
  const { handleRefundFlow } = await import("../../worker/refund-flow.mjs");
  const { handleInternalFinancialAudit } = await import("../../worker/internal-financial-audit.mjs");
  const { handleSandboxProofV2 } = await import("../../worker/sandbox-proof-v2.mjs");
  const { verifySignedAuditProbe } = await import("../../worker/signed-audit-probe.mjs");
  const sqlFactory = () => () => { throw new Error("no database in test"); };
  const cases = {
    voice_encode_audit: (env, t) => handleVoiceEncodeAudit(new Request("https://x/api/admin/voice/encode-audit", { headers: { authorization: "Bearer " + t } }), env),
    post_sale_certification: (env, t) => handlePostSale(new Request("https://x/api/internal/certification/e2e/post-sale", { method: "POST", headers: { "x-certification-e2e-token": t }, body: "{}" }), env, { sqlFactory: sqlFactory() }),
    refund_approve: (env, t) => handleRefundFlow(new Request("https://x/api/internal/certification/e2e/refund-approve?order_id=x", { method: "POST", headers: { "x-certification-e2e-token": t } }), env, { sqlFactory: sqlFactory() }),
    internal_audit: (env, t) => handleInternalFinancialAudit(new Request("https://x/api/internal/audit/credential-identity", { headers: { "x-certification-e2e-token": t, "cf-connecting-ip": "10.5." + Math.floor(Math.random() * 250) + ".1" } }), env, {}),
    // Handler cru (sem a entrada de produção, que esconde o piloto): só a trava de autenticação está em teste aqui.
    sandbox_v2_status: (env, t) => handleSandboxProofV2(new Request("https://x/api/internal/certification/e2e/status", { headers: { "x-certification-e2e-token": t } }),
      { ...env, CERTIFICATION_PILOT_ENV: "sandbox", MERCADOPAGO_ENV: "sandbox", SALE_GLOBALLY_ENABLED: "false" }, { waitUntil() {} }, null, () => null),
  };
  const both = { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD };
  const envs = { open: { ...both, OPERATOR_TOKEN_MIGRATION_UNTIL: day }, closed: { ...both } };
  for (const [mode, binding] of Object.entries(envs)) {
    for (const [name, fn] of Object.entries(cases)) {
      const env = { ...binding, ZEVANORY_PRIVATE_ARTIFACTS: kv() };
      const n = await statusOf(() => fn(env, NEW)), o = await statusOf(() => fn(env, OLD)), u = await statusOf(() => fn(env, UNKNOWN));
      assert.ok(n !== 401 && n !== null && !String(n).startsWith("throw:"), `[M4.1] ${mode}/${name}: primária autentica (${n})`);
      if (mode === "open") assert.ok(o !== 401 && o !== null && !String(o).startsWith("throw:"), `[M4.2] ${mode}/${name}: antiga aceita na janela (${o})`);
      else assert.equal(o, 401, `[M4.3] ${mode}/${name}: antiga recusada fora da janela (${o})`);
      assert.equal(u, 401, `[M4.4] ${mode}/${name}: desconhecida recusada (${u})`);
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/api/internal/audit/credential-identity";
    const req = (secret) => new Request("https://zevanory.api.br" + path, { headers: { "x-zevanory-audit-ts": ts,
      "x-zevanory-audit-signature": createHmac("sha256", secret).update("GET\n" + path + "\n" + ts).digest("hex") } });
    assert.equal(await verifySignedAuditProbe(req(NEW), binding), true, `[M4.5] ${mode}: sonda assinada com a primária`);
    assert.equal(await verifySignedAuditProbe(req(OLD), binding), mode === "open", `[M4.5] ${mode}: sonda assinada com a antiga só na janela`);
    assert.equal(await verifySignedAuditProbe(req(UNKNOWN), binding), false, `[M4.5] ${mode}: sonda assinada com valor desconhecido recusada`);
  }
});

// Script de presença com `date` substituído no PATH (dia fixo): sem relógio real, sem afrouxar o script de produção.
function presence(env, today) {
  requireTool("bash");
  const realDate = String(spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout || "").trim();
  assert.ok(realDate, "[M5.0] date ausente");
  const dir = mkdtempSync(join(tmpdir(), "zev-r9-date-"));
  try {
    const shim = join(dir, "date");
    writeFileSync(shim, `#!/usr/bin/env bash\nif [ "$*" = "-u +%F" ]; then echo ${today}; else exec "${realDate}" "$@"; fi\n`);
    chmodSync(shim, 0o755);
    const r = spawnSync("bash", [join(ROOT, "scripts", "ci", "operator-token-github-presence.sh"), "gh-pages-automacao"],
      { encoding: "utf8", env: { PATH: dir + ":" + process.env.PATH, ...env } });
    return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("M5 presença no GitHub: valores diferentes só com a janela aberta; presença e require_primary mantidos", () => {
  const diff = { R9_NEW: "value-NEW", R9_LEGACY: "value-OLD" };
  const today = "2026-11-10";
  const open = presence({ ...diff, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, today);
  assert.equal(open.code, 0, "[M5.1] valores diferentes com janela aberta passam: " + open.out);
  assert.match(open.out, /GITHUB_GH_PAGES_AUTOMACAO_OPERATOR_TOKEN_VALUES_EQUAL=false\nGITHUB_OPERATOR_TOKEN_MIGRATION=open/, "[M5.1] categorias relatadas");
  assert.equal(presence({ ...diff, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-10" }, today).code, 0, "[M5.1] o próprio dia da flag ainda é aberto");
  for (const [label, flag, state] of [["ausente", "", "absent"], ["vencida", "2026-11-09", "expired"], ["malformada", "2026-11-31", "invalid"],
    ["formato livre", "next-week", "invalid"], ["acima do teto", "2027-02-01", "beyond_code_ceiling"]]) {
    const r = presence({ ...diff, OPERATOR_TOKEN_MIGRATION_UNTIL: flag }, today);
    assert.equal(r.code, 1, `[M5.2] valores diferentes fora da janela (${label}) reprovam: ${r.out}`);
    assert.match(r.out, new RegExp("GITHUB_OPERATOR_TOKEN_MIGRATION=" + state + "\\n[\\s\\S]*R9_OPERATOR_TOKEN_MISMATCH"), `[M5.2] estado ${state} e motivo`);
  }
  assert.equal(presence({ R9_NEW: "value-A", R9_LEGACY: "value-A" }, today).code, 0, "[M5.3] valores iguais passam sem janela (como hoje)");
  const legacyOnly = presence({ R9_LEGACY: "value-OLD", REQUIRE_PRIMARY: "true", OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" }, today);
  assert.equal(legacyOnly.code, 1, "[M5.4] require_primary continua exigindo o nome novo, mesmo com a janela aberta");
  assert.match(legacyOnly.out, /ZEVANORY_OPERATOR_TOKEN=absent/, "[M5.4] presença relatada");
  for (const r of [open, legacyOnly]) assert.ok(!r.out.includes("value-"), "[M5.5] nenhum valor na saída");
});

function serve(body, status = 200) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: "http://127.0.0.1:" + server.address().port }));
  });
}
function readback(base, args) {
  requireTool("python3");
  return new Promise((resolve) => {
    const p = spawn("python3", [join(ROOT, "scripts", "ci", "credential_identity_readback.py"), base, ...args, "--attempts", "1"],
      { env: { ...PYENV, ZEVANORY_OPERATOR_TOKEN: "synthetic-readback-token" } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
const BODY = (over = {}) => ({ schema: "zevanory.audit.credential-identity/v1", operator_token_source: "primary", operator_token_fallback_uses_in_isolate: 0,
  operator_token_presented: "primary", operator_token_migration: "open", stripe_key_mode: "live", certification_perimeter: false, release_sha: null, ...over });

test("M6 readback --require-primary: a credencial do runner precisa autenticar como primária", async () => {
  const cases = [
    [BODY(), ["--require-primary"], 0, ["OPERATOR_TOKEN_PRESENTED=primary", "OPERATOR_TOKEN_MIGRATION=open", "R9_CREDENTIAL_IDENTITY=PASS"]],
    [BODY({ operator_token_presented: "legacy" }), ["--require-primary"], 1, ["OPERATOR_TOKEN_PRESENTED=legacy", "RUNNER_TOKEN_NOT_PRIMARY"]],
    [BODY({ operator_token_presented: "legacy" }), [], 0, ["OPERATOR_TOKEN_PRESENTED=legacy", "R9_CREDENTIAL_IDENTITY=PASS"]],
    [BODY({ operator_token_presented: undefined }), ["--require-primary"], 1, ["OPERATOR_TOKEN_PRESENTED=unverified", "RUNNER_TOKEN_NOT_PRIMARY"]],
    [BODY({ operator_token_presented: "synthetic-readback-token", operator_token_migration: "2026-11-20" }), [], 0, ["OPERATOR_TOKEN_PRESENTED=unverified", "OPERATOR_TOKEN_MIGRATION=unverified"]],
  ];
  for (const [i, [body, args, code, expect]] of cases.entries()) {
    const s = await serve(body);
    try {
      const r = await readback(s.base, args);
      assert.equal(r.code, code, `[M6.1] caso ${i}: código ${r.code} :: ${r.out}`);
      for (const e of expect) assert.ok(r.out.includes(e), `[M6.2] caso ${i}: saída contém ${e} :: ${r.out}`);
      assert.ok(!r.out.includes("synthetic-readback-token"), `[M6.3] caso ${i}: nenhum valor na saída`);
    } finally { s.server.close(); }
  }
});

function prepare(migration) {
  requireTool("python3");
  const dir = mkdtempSync(join(tmpdir(), "zev-r9-mig-prepare-"));
  try {
    mkdirSync(join(dir, "worker")); mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify({ kv_namespaces: [],
      vars: { OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-01", ZEVANORY_RUNTIME_CONFIG: { KEEP: "1", OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-02" } } }));
    writeFileSync(join(dir, "worker", "binding-aliases.mjs"), "return Reflect.get(target, prop, receiver);\nreturn Reflect.has(target, prop);\n");
    writeFileSync(join(dir, "worker", "cloudflare-worker.recovered.mjs"), '    }\n    if (provider === "stripe") {\nconst pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE || "").toLowerCase() === "sandbox";\nconst commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;\n');
    writeFileSync(join(dir, "public", "solucoes.html"), "<!doctype html><title>Solucoes</title>");
    writeFileSync(join(dir, "public", "sitemap.xml"), "<urlset></urlset>");
    const env = { ...PYENV, PUBLIC_OWNER_ACCOUNT_ID: "f".repeat(32), TARGET_RUNTIME_SHA: "a".repeat(40), ZEVANORY_LAUNCH_AUTHORIZATION: "" };
    if (migration !== null) env.OPERATOR_TOKEN_MIGRATION_UNTIL = migration;
    const r = spawnSync("python3", [join(ROOT, "scripts", "deploy", "prepare-central-candidate.py")], { cwd: dir, encoding: "utf8", env });
    const config = r.status === 0 ? JSON.parse(readTextNormalized(join(dir, "wrangler.central-fix.jsonc"))) : null;
    return { code: r.status, out: String(r.stdout || "") + String(r.stderr || ""), config };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function verify(config) {
  requireTool("python3");
  const dir = mkdtempSync(join(tmpdir(), "zev-r9-mig-verify-"));
  try {
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify(config));
    const r = spawnSync("python3", [join(ROOT, "scripts", "deploy", "verify-financial-boundary.py")], { cwd: dir, encoding: "utf8", env: { ...PYENV, ZEVANORY_LAUNCH_AUTHORIZATION: "" } });
    return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("M7 deploy: flag só válida e <= teto, dentro de ZEVANORY_RUNTIME_CONFIG; ausente = nada gravado", async () => {
  const ceiling = await ceilingOf();
  const ok = prepare("2026-11-20");
  assert.equal(ok.code, 0, "[M7.1] preparador roda: " + ok.out.slice(-300));
  assert.equal(ok.config.vars.ZEVANORY_RUNTIME_CONFIG.OPERATOR_TOKEN_MIGRATION_UNTIL, "2026-11-20", "[M7.1] flag gravada no runtime config");
  assert.equal("OPERATOR_TOKEN_MIGRATION_UNTIL" in ok.config.vars, false, "[M7.1] nunca como var própria (sem binding novo)");
  assert.equal(ok.config.vars.ZEVANORY_RUNTIME_CONFIG.KEEP, "1", "[M7.1] o resto do runtime config fica");
  assert.equal(prepare(ceiling).code, 0, "[M7.1] o próprio teto é aceito");
  const absent = prepare(null);
  assert.equal(absent.code, 0, "[M7.2] sem a flag o preparador roda");
  assert.equal("OPERATOR_TOKEN_MIGRATION_UNTIL" in absent.config.vars.ZEVANORY_RUNTIME_CONFIG, false, "[M7.2] sem a flag nada é gravado (herdado removido)");
  assert.equal("OPERATOR_TOKEN_MIGRATION_UNTIL" in absent.config.vars, false, "[M7.2] var herdada removida");
  for (const bad of ["2026-11-31", "2027-01-01", "amanhã", "2026-11-20T00:00:00Z"]) {
    const r = prepare(bad);
    assert.notEqual(r.code, 0, "[M7.3] flag inválida ou acima do teto reprova: " + bad);
    assert.match(r.out, /OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID/, "[M7.3] motivo: " + bad);
  }
  const base = { vars: { SALE_GLOBALLY_ENABLED: "false", WHATSAPP_SALES_ENABLED: "false", ASAAS_ENV: "sandbox", PAYMENT_PROVIDER: "mercadopago",
    MERCADOPAGO_ENV: "sandbox", ABSOLUTE_RELEASE_APPROVED: "false", PRE_SALE_GATES_APPROVED: "false", ZEVANORY_RUNTIME_CONFIG: { OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" } } };
  assert.equal(verify(base).code, 0, "[M7.4] verificador aceita a flag válida no runtime config");
  const top = verify({ vars: { ...base.vars, OPERATOR_TOKEN_MIGRATION_UNTIL: "2026-11-20" } });
  assert.match(top.out, /OPERATOR_TOKEN_MIGRATION_ONLY_IN_RUNTIME_CONFIG/, "[M7.4] var própria reprova");
  const beyond = verify({ vars: { ...base.vars, ZEVANORY_RUNTIME_CONFIG: { OPERATOR_TOKEN_MIGRATION_UNTIL: "2027-03-01" } } });
  assert.match(beyond.out, /OPERATOR_TOKEN_MIGRATION_UNTIL_INVALID/, "[M7.4] acima do teto reprova no verificador");
});

test("M8 teto em código único: Worker, presença, preparador e verificador", async () => {
  const ceiling = await ceilingOf();
  assert.match(ceiling, /^\d{4}-\d{2}-\d{2}$/, "[M8.1] teto no formato AAAA-MM-DD");
  const read = (p) => readTextNormalized(join(ROOT, ...p.split("/")));
  assert.ok(read("scripts/ci/operator-token-github-presence.sh").includes(`MIGRATION_CODE_CEILING="${ceiling}"`), "[M8.1] presença usa o mesmo teto");
  assert.ok(read("scripts/deploy/prepare-central-candidate.py").includes(`OPERATOR_TOKEN_MIGRATION_CODE_CEILING="${ceiling}"`), "[M8.1] preparador usa o mesmo teto");
  assert.ok(read("scripts/deploy/verify-financial-boundary.py").includes(`_mig <= "${ceiling}"`), "[M8.1] verificador usa o mesmo teto");
});
