// R9 (roteiro v4.7; auditoria Sol 164 §4): a credencial de operador da produção passa de CERTIFICATION_E2E_TOKEN para
// ZEVANORY_OPERATOR_TOKEN com transição dual-read. Provado pelo COMPORTAMENTO do código real:
//   T1 resolvedor único (worker/operator-credential.mjs): prioridade, queda registrada só por categoria, fail-closed.
//   T2 Worker REAL de produção (sonda tests/helpers/operator-token-probe.mjs): toda rota autenticada aceita o nome novo,
//      prefere o novo quando os dois existem com valores diferentes e só aceita o antigo na ausência do novo.
//   T3 handlers chamados diretamente (voz, pós-venda, reembolso, auditoria, sonda assinada), mesmas
//      três variantes.
//   T4 perímetro de certificação: lá CERTIFICATION_E2E_TOKEN continua a credencial própria; a de operador da produção
//      ligada ao Worker de certificação o derruba (503).
// Sem rede, sem segredo real, sem banco. Cada asserção leva um marcador [Tn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEW = "synthetic-NEW-operator-token-0123456789abcdef0123";
const OLD = "synthetic-OLD-operator-token-fedcba9876543210fedc";
const VARIANTS = {
  new_only: { ZEVANORY_OPERATOR_TOKEN: NEW },
  both_different: { ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD },
  legacy_only: { CERTIFICATION_E2E_TOKEN: OLD },
};
// Qual valor cada variante deve aceitar (o outro precisa ser recusado com 401).
const ACCEPTS = { new_only: "new", both_different: "new", legacy_only: "old" };

async function freshResolver(tag) {
  return import(new URL("../worker/operator-credential.mjs?" + tag, import.meta.url).href);
}
function capture() {
  const lines = [];
  return { lines, log: { warn: (...a) => lines.push(a.map(String).join(" ")) } };
}

test("T1 resolvedor: nome novo primeiro, queda só na ausência, categoria sem valor", async () => {
  const m = await freshResolver("t1");
  const a = capture();
  assert.deepEqual({ ...m.resolveOperatorToken({ ZEVANORY_OPERATOR_TOKEN: NEW, CERTIFICATION_E2E_TOKEN: OLD }, { log: a.log }) },
    { token: NEW, source: "primary" }, "[T1.1] com os dois nomes vale o novo");
  assert.deepEqual(a.lines, [], "[T1.1] sem aviso quando o nome novo existe");
  assert.deepEqual({ ...m.resolveOperatorToken({ CERTIFICATION_E2E_TOKEN: OLD }, { log: a.log }) },
    { token: OLD, source: "legacy_fallback" }, "[T1.2] sem o novo, cai para o antigo (transição)");
  m.resolveOperatorToken({ CERTIFICATION_E2E_TOKEN: OLD }, { log: a.log });
  assert.equal(a.lines.length, 1, "[T1.2] a queda é registrada uma vez por isolate");
  assert.match(a.lines[0], /^operator_token_source .*"category":"legacy_fallback"/, "[T1.2] categoria não secreta");
  assert.ok(!a.lines[0].includes(OLD) && !a.lines[0].includes(NEW), "[T1.2] o valor nunca é registrado");
  assert.equal(m.operatorTokenFallbackUses(), 2, "[T1.2] contador de uso da queda");
  assert.deepEqual({ ...m.resolveOperatorToken({}, { log: a.log }) }, { token: "", source: "absent" }, "[T1.3] sem nenhum nome: vazio (fail-closed)");
  assert.deepEqual({ ...m.resolveOperatorToken({ ZEVANORY_OPERATOR_TOKEN: "short", CERTIFICATION_E2E_TOKEN: OLD }, { log: a.log }) },
    { token: "short", source: "primary" }, "[T1.4] novo presente porém curto NÃO cai para o antigo (o consumidor recusa)");
  assert.equal(m.operatorTokenSource({ CERTIFICATION_E2E_TOKEN: OLD }), "legacy_fallback", "[T1.5] fonte para o readback");
  assert.equal(m.operatorTokenFallbackUses(), 2, "[T1.5] consulta de fonte não conta como uso");
});

test("T1b perímetro de certificação só com as duas marcas e sem nome exclusivo da produção", async () => {
  const m = await freshResolver("t1b");
  const cert = { ZEVANORY_DEPLOYMENT_ENV: "certification", CERTIFICATION_WORKER_NAME: "zevanory-certification", CERTIFICATION_E2E_TOKEN: OLD };
  assert.equal(m.isCertificationPerimeter(cert), true, "[T1b.1] marcas do perímetro");
  assert.deepEqual({ ...m.resolveOperatorToken(cert) }, { token: OLD, source: "certification" }, "[T1b.1] lá vale a credencial de certificação, sem queda");
  for (const name of m.PRODUCTION_ONLY_NAMES) {
    const polluted = { ...cert, [name]: "x" };
    assert.equal(m.isCertificationPerimeter(polluted), false, "[T1b.2] nome de produção desqualifica o perímetro: " + name);
  }
  assert.equal(m.isCertificationPerimeter({ ...cert, ZEVANORY_DEPLOYMENT_ENV: "production" }), false, "[T1b.3] produção nunca é perímetro");
  assert.equal(m.isCertificationPerimeter({ ...cert, CERTIFICATION_WORKER_NAME: "zevanory" }), false, "[T1b.3] nome do Worker de produção");
  assert.equal(m.resolveOperatorToken({ ...cert, ZEVANORY_OPERATOR_TOKEN: NEW }).source, "primary", "[T1b.4] com a credencial de produção não é perímetro");
});

const run = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/operator-token-probe.mjs"],
  { cwd: ROOT, encoding: "utf8", timeout: 150000, env: { ...process.env, NODE_OPTIONS: "" } });
const line = String(run.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
const probe = line ? JSON.parse(line.slice("PROBE_RESULT ".length)) : null;
function probed() {
  assert.ok(probe && !probe.timeout && !probe.out?.error, "[T2.0] sonda sem resultado: " + String(probe?.out?.error || run.stderr || "").slice(-400));
  assert.deepEqual(probe.blocked, [], "[T2.0] chamada externa inesperada");
  return probe.out;
}
const ROUTES = ["backup_run", "funnel_run", "voice_eval_run", "certification_invite", "audit_credential_identity", "telegram_proof",
  "channel_evidence", "whatsapp_stats_refresh", "voice_audit", "node_e2e_status"];

test("T2 Worker de produção: toda rota de operador aceita o nome novo e o prefere ao antigo", () => {
  const out = probed();
  for (const variant of Object.keys(VARIANTS)) {
    for (const route of ROUTES) {
      const r = out[variant]?.[route];
      assert.ok(r, "[T2.1] rota ausente na sonda: " + variant + "/" + route);
      const good = r[ACCEPTS[variant]], bad = r[ACCEPTS[variant] === "new" ? "old" : "new"];
      assert.notEqual(good.status, 401, `[T2.1] ${variant}/${route}: credencial esperada autentica (status ${good.status} ${good.error})`);
      assert.equal(bad.status, 401, `[T2.2] ${variant}/${route}: a outra credencial é recusada (status ${bad.status})`);
    }
  }
});

test("T2b readback e registro da queda no Worker real", () => {
  const out = probed();
  assert.equal(out.new_only.audit_credential_identity.new.source, "primary", "[T2b.1] readback: fonte primary com o nome novo");
  assert.equal(out.both_different.audit_credential_identity.new.source, "primary", "[T2b.1] readback: primary com os dois");
  assert.equal(out.legacy_only.audit_credential_identity.old.source, "legacy_fallback", "[T2b.2] readback denuncia a queda");
  const logs = String(run.stderr || "").split("\n").filter((l) => l.includes("operator_token_source"));
  assert.equal(logs.length, 1, "[T2b.3] a queda é registrada uma vez por isolate");
  assert.match(logs[0], /"category":"legacy_fallback"/, "[T2b.3] categoria");
  const all = String(run.stdout || "") + String(run.stderr || "");
  assert.ok(!all.includes(NEW) && !all.includes(OLD), "[T2b.4] nenhum valor de credencial aparece na saída");
});

test("T4 perímetro de certificação: credencial própria; a de operador da produção derruba o Worker", () => {
  const c = probed().certification;
  assert.equal(c.own_token.status, 200, "[T4.1] certificação autentica com a credencial dela");
  assert.equal(c.wrong_token.status, 401, "[T4.1] e recusa outra");
  assert.deepEqual([c.with_production_operator_token.status, c.with_production_operator_token.error], [503, "certification_isolation_unavailable"],
    "[T4.2] ZEVANORY_OPERATOR_TOKEN ligado ao Worker de certificação: isolamento indisponível");
});

// T3: handlers chamados diretamente com o env de cada variante.
const kv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
};
const sqlFactory = () => () => { throw new Error("no database in test"); };
async function statusOf(fn) {
  try { const r = await fn(); return r ? r.status : null; } catch (e) { return "throw:" + String(e?.message || e).slice(0, 60); }
}

test("T3 handlers diretos: voz, pós-venda, reembolso, auditoria e sonda assinada", async () => {
  const { handleVoiceEncodeAudit } = await import("../worker/voice-chunks.mjs");
  const { handlePostSale } = await import("../worker/post-sale.mjs");
  const { handleRefundFlow } = await import("../worker/refund-flow.mjs");
  const { handleInternalFinancialAudit } = await import("../worker/internal-financial-audit.mjs");
  const { verifySignedAuditProbe } = await import("../worker/signed-audit-probe.mjs");
  const cases = {
    voice_encode_audit: (env, t) => handleVoiceEncodeAudit(new Request("https://x/api/admin/voice/encode-audit", { headers: { authorization: "Bearer " + t } }), env),
    post_sale_certification: (env, t) => handlePostSale(new Request("https://x/api/internal/certification/e2e/post-sale", { method: "POST", headers: { "x-certification-e2e-token": t }, body: "{}" }), env, { sqlFactory: sqlFactory() }),
    refund_approve: (env, t) => handleRefundFlow(new Request("https://x/api/internal/certification/e2e/refund-approve?order_id=x", { method: "POST", headers: { "x-certification-e2e-token": t } }), env, { sqlFactory: sqlFactory() }),
    internal_audit: (env, t) => handleInternalFinancialAudit(new Request("https://x/api/internal/audit/credential-identity", { headers: { "x-certification-e2e-token": t, "cf-connecting-ip": "10.3." + Math.floor(Math.random() * 250) + ".1" } }), env, {}),
  };
  for (const [variant, binding] of Object.entries(VARIANTS)) {
    for (const [name, fn] of Object.entries(cases)) {
      const env = { ...binding, ZEVANORY_PRIVATE_ARTIFACTS: kv() };
      const goodToken = ACCEPTS[variant] === "new" ? NEW : OLD, badToken = goodToken === NEW ? OLD : NEW;
      const good = await statusOf(() => fn(env, goodToken)), bad = await statusOf(() => fn(env, badToken));
      assert.ok(good !== 401 && good !== null && !String(good).startsWith("throw:"), `[T3.1] ${variant}/${name}: credencial esperada autentica (${good})`);
      assert.equal(bad, 401, `[T3.2] ${variant}/${name}: a outra é recusada (${bad})`);
    }
    const sign = (secret, path, ts) => createHmac("sha256", secret).update("GET\n" + path + "\n" + ts).digest("hex");
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/api/internal/audit/credential-identity";
    const probeReq = (secret) => new Request("https://zevanory.api.br" + path, { headers: { "x-zevanory-audit-ts": ts, "x-zevanory-audit-signature": sign(secret, path, ts) } });
    const goodSecret = ACCEPTS[variant] === "new" ? NEW : OLD;
    assert.equal(await verifySignedAuditProbe(probeReq(goodSecret), binding), true, `[T3.3] ${variant}: sonda assinada com a credencial esperada`);
    assert.equal(await verifySignedAuditProbe(probeReq(goodSecret === NEW ? OLD : NEW), binding), false, `[T3.3] ${variant}: assinada com a outra é recusada`);
  }
});

test("T5 auditoria credential-identity: só categorias, chave Stripe de teste denunciada", async () => {
  const { handleInternalFinancialAudit, stripeKeyMode } = await import("../worker/internal-financial-audit.mjs");
  const call = async (env) => {
    const r = await handleInternalFinancialAudit(new Request("https://x/api/internal/audit/credential-identity",
      { headers: { "x-certification-e2e-token": NEW, "cf-connecting-ip": "10.4." + Math.floor(Math.random() * 250) + ".1" } }), env, {});
    return { status: r.status, body: await r.json() };
  };
  const live = await call({ ZEVANORY_OPERATOR_TOKEN: NEW, STRIPE_SECRET_KEY: "sk_live_synthetic", ZEVANORY_RELEASE_SHA: "b".repeat(40) });
  assert.equal(live.status, 200, "[T5.1] rota autenticada");
  assert.deepEqual(Object.keys(live.body).sort(), ["certification_perimeter", "operator_token_fallback_uses_in_isolate", "operator_token_source", "release_sha", "schema", "stripe_key_mode"],
    "[T5.1] só campos de categoria");
  assert.equal(live.body.stripe_key_mode, "live", "[T5.2] chave live");
  assert.ok(!JSON.stringify(live.body).includes("sk_live_synthetic") && !JSON.stringify(live.body).includes(NEW), "[T5.2] nenhum valor no corpo");
  assert.equal((await call({ ZEVANORY_OPERATOR_TOKEN: NEW, STRIPE_SECRET_KEY: "sk_test_synthetic" })).body.stripe_key_mode, "test", "[T5.3] chave de teste denunciada");
  assert.equal((await call({ ZEVANORY_OPERATOR_TOKEN: NEW })).body.stripe_key_mode, "absent", "[T5.3] ausente");
  assert.deepEqual(["rk_live_x", "rk_test_x", "pk_live_x", " sk_test_x", ""].map(stripeKeyMode), ["live", "test", "unrecognized", "test", "absent"], "[T5.4] classificação por prefixo");
});
