// P20 diário D1, PR 3: gravação em modo sombra (worker/diario-sombra.mjs) e ganchos nos eventos críticos.
// D1 falso com SQL de verdade (tests/helpers/d1-sqlite.mjs, migração real). Sem rede, sem segredo, sem Cloudflare.
// Marcadores [DSn.k] usados pelos mutantes (scripts/ci/mutants_p20_diario_sombra.py).
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";
import { createD1 } from "./helpers/d1-sqlite.mjs";
import { verifyChain } from "../worker/diario-p20.mjs";
import {
  diarioSombra, comDiario, diarioSombraStats, resetDiarioSombraStats, providerRef, orderRef, LEAD_EVENTO_TIPO, configurarDiarioSombra,
  eventoPedidoCriado, eventoPagamento, eventoEntrega, eventoReembolso, eventoConsentimento,
} from "../worker/diario-sombra.mjs";
import { handleDigitalHotmartNc012 } from "../worker/cp-nc012-digital-hotmart.mjs";
import { handleLeadMagnet } from "../worker/lead-magnet.mjs";
import { handleRefundFlow } from "../worker/refund-flow.mjs";

const MIGRATION = readTextNormalized(new URL("../migrations/d1/0001_diario_v1.sql", import.meta.url));
const RECOVERED = readTextNormalized(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url));
const COMPAT = readTextNormalized(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url));
const SOMBRA = readTextNormalized(new URL("../worker/diario-sombra.mjs", import.meta.url));
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const OID = "3f2a9c1e-7b4d-4abc-9def-0123456789ab";
const REF = "a".repeat(64);
const PII = /@|Cliente|cliente/;
configurarDiarioSombra({ timeoutMs: 200 }); // D1 travado vira diario_timeout rápido (produção: 5 s)

const fakeCtx = () => {
  const tasks = [], settled = [];
  return { tasks, settled, waitUntil(p) { const i = tasks.push(p) - 1; settled[i] = false; Promise.resolve(p).finally(() => { settled[i] = true; }); }, drain: () => Promise.all(tasks), pending: () => settled.filter((x) => !x).length };
};
const evento = (i = 0) => eventoPedidoCriado({ orderId: `ord_${1000 + i}`, provider: "mercadopago", offerId: "ia-na-pratica", amount: 97, ts: T0 + i });
function captureLogs() {
  const lines = [], orig = console.log;
  console.log = (...a) => { lines.push(a.join(" ")); };
  return { lines, restore: () => { console.log = orig; }, sombra: () => lines.filter((l) => l.includes('"evt":"diario_sombra"')).map((l) => JSON.parse(l)) };
}
// D1 que nunca responde: prova que o gancho não segura a resposta.
const hangingD1 = () => ({ prepare: () => ({ bind() { return this; }, first: () => new Promise(() => {}), all: () => new Promise(() => {}), run: () => new Promise(() => {}) }), batch: () => new Promise(() => {}) });
const within = (p, ms = 1500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("resposta bloqueada pelo diário")), ms))]);
const respDump = async (r) => ({ status: r.status, body: await r.text(), type: r.headers.get("content-type") });

test("DS1 sem env.DIARIO é no-op: nada é chamado, nada é agendado", async () => {
  resetDiarioSombraStats();
  globalThis.__ZEVANORY_DIARIO__ = null;
  const ctx = fakeCtx();
  let built = 0;
  for (const env of [undefined, null, {}, { DIARIO: null }, { DIARIO: {} }]) {
    const out = diarioSombra(env, ctx, () => { built++; return evento(); });
    assert.deepEqual(out, { queued: false, reason: "sem_binding" }, "[DS1.1] sem binding devolve no-op");
  }
  assert.equal(built, 0, "[DS1.2] o construtor nem roda");
  assert.equal(ctx.tasks.length, 0, "[DS1.3] nada vai para waitUntil");
  const marker = { ok: 1 };
  assert.equal(comDiario({}, ctx, () => marker), marker, "[DS1.4] comDiario sem DIARIO devolve o mesmo resultado");
  assert.equal(diarioSombraStats().agendados, 0);
});

test("DS2 com DIARIO grava e encadeia, sem bloquear: tudo via waitUntil", async () => {
  resetDiarioSombraStats();
  const db = createD1(MIGRATION);
  const ctx = fakeCtx();
  const logs = captureLogs();
  try {
    const a = diarioSombra({ DIARIO: db }, ctx, () => evento(1));
    const b = diarioSombra({ DIARIO: db }, ctx, evento(2));
    assert.equal(a.queued && b.queued, true, "[DS2.1] agendado");
    assert.equal(db.rows().length, 0, "[DS2.2] nada gravado de forma síncrona: o chamador não espera");
    assert.equal(ctx.tasks.length, 2, "[DS2.3] cada gravação vai para ctx.waitUntil");
    const res = await ctx.drain();
    assert.deepEqual(res.map((r) => r.ok), [true, true]);
  } finally { logs.restore(); }
  const rows = db.rows();
  assert.equal(rows.length, 2, "[DS2.4] duas linhas");
  const v = await verifyChain(rows, { head: db.head() });
  assert.equal(v.ok, true, "[DS2.5] cadeia íntegra até a cabeça");
  assert.deepEqual(logs.sombra().map((l) => [l.tipo, l.ok, l.code, l.seq]), [["order_created", true, "gravado", 1], ["order_created", true, "gravado", 2]], "[DS2.6] log estruturado");
  assert.equal(diarioSombraStats().gravados, 2);
});

test("DS3 falhas nunca lançam: tabela ausente, D1 quebrado, construtor que lança, ctx hostil", async () => {
  resetDiarioSombraStats();
  const logs = captureLogs();
  const ctx = fakeCtx();
  let results;
  try {
    const semTabela = createD1(""); // banco sem a migração (PR 2 com a migração pendente)
    const quebrado = { prepare() { throw new Error("D1_ERROR: boom"); }, batch() { throw new Error("D1_ERROR: boom"); } };
    const outs = [
      diarioSombra({ DIARIO: semTabela }, ctx, () => evento(1)),
      diarioSombra({ DIARIO: quebrado }, ctx, () => evento(2)),
      diarioSombra({ DIARIO: createD1(MIGRATION) }, ctx, () => { throw new Error("construtor"); }),
      diarioSombra({ DIARIO: createD1(MIGRATION) }, ctx, () => eventoPedidoCriado({ orderId: "", provider: "mercadopago" })),
    ];
    assert.ok(outs.every((o) => o.queued === true), "[DS3.1] agendou sem lançar");
    results = await Promise.all(outs.map((o) => o.task.then((r) => r, (e) => ({ rejeitou: String(e?.message || e) }))));
  } finally { logs.restore(); }
  assert.deepEqual(results.map((r) => r.code), ["diario_indisponivel", "diario_indisponivel", "diario_excecao", "diario_chave_invalida"], "[DS3.2] cada falha vira um código, a promessa nunca rejeita");
  assert.equal(diarioSombraStats().falhas, 4, "[DS3.3] falhas contadas");
  assert.deepEqual(logs.sombra().map((l) => l.code), ["diario_indisponivel", "diario_indisponivel", "diario_excecao", "diario_chave_invalida"], "[DS3.7] um log por falha, na ordem da fila");
  const hostil = new Proxy({}, { get() { throw new Error("ctx hostil"); } });
  let r4;
  assert.doesNotThrow(() => { r4 = diarioSombra({ DIARIO: createD1(MIGRATION) }, hostil, () => evento(3)); }, "[DS3.4] ctx hostil não lança");
  assert.deepEqual(r4, { queued: false, reason: "diario_sombra_erro" }, "[DS3.8] ctx hostil vira no-op");
  const envHostil = { get DIARIO() { throw new Error("env hostil"); } };
  assert.doesNotThrow(() => diarioSombra(envHostil, ctx, () => evento(4)), "[DS3.5] env hostil não lança");
  const throwingWait = { waitUntil() { throw new Error("waitUntil fora da requisição"); } };
  const out = diarioSombra({ DIARIO: createD1(MIGRATION) }, throwingWait, () => evento(5));
  assert.equal((await out.task).ok, true, "[DS3.6] waitUntil que lança não impede a gravação");
});

test("DS4 payload com PII é recusado, não grava e não vaza no log", async () => {
  resetDiarioSombraStats();
  const db = createD1(MIGRATION);
  const ctx = fakeCtx();
  const logs = captureLogs();
  let res;
  try {
    const base = evento(1);
    const casos = [
      { ...base, payload: { ...base.payload, email: "cliente@example.com" } },
      { ...base, event_key: "order_created:ord_9", payload: { ...base.payload, obs: "Cliente 123.456.789-09" } },
      { ...base, event_key: "order_created:ord_8", payload: { ...base.payload, contato: "(11) 98765-4321" } },
    ];
    for (const c of casos) diarioSombra({ DIARIO: db }, ctx, () => c);
    res = await ctx.drain();
  } finally { logs.restore(); }
  assert.deepEqual(res.map((r) => r.code), ["diario_pii", "diario_pii", "diario_pii"], "[DS4.1] recusado");
  assert.equal(db.rows().length, 0, "[DS4.2] nada gravado");
  assert.doesNotMatch(logs.lines.join("\n"), /cliente@example\.com|123\.456\.789-09|98765-4321/, "[DS4.3] log sem PII");
});

test("DS5 construtores de evento: fatos não pessoais, chaves determinísticas, aceitos pelo diário real", async () => {
  assert.equal(providerRef("mercadopago", "1234567890"), "mp1234567890", "[DS5.1] id técnico normalizado: prefixo + alfanumérico");
  assert.equal(providerRef("stripe", "pi_3Abc"), "stpi3Abc");
  assert.equal(providerRef("asaas", "pay_119987654321"), "aspay119987654321");
  assert.equal(orderRef(OID), "ord" + OID.replace(/-/g, ""));
  // UUID cujo último bloco o detector lê como +55 e telefone: com a forma normalizada é aceito (DS5.10).
  const UUID_TEL = "11111111-2222-4333-8444-555555555555";
  assert.equal(eventoPedidoCriado({ orderId: UUID_TEL, provider: "mercadopago", amount: 1 }).ref, "ord11111111222243338444555555555555");
  for (let i = 0; i < 20000; i++) eventoPedidoCriado({ orderId: crypto.randomUUID(), provider: "mercadopago", amount: 1 });
  const evs = [
    eventoPedidoCriado({ orderId: OID, provider: "mercadopago", offerId: "ia-na-pratica", amount: 97, certification: false, ts: T0 }),
    eventoPedidoCriado({ orderId: OID.replace("3f", "4f"), provider: "asaas", offerId: "negocio-completo", amount: 247, ts: T0 }),
    eventoPagamento({ orderId: OID, provider: "mercadopago", paymentId: "1234567890", status: "approved", normalized: "payment_confirmed", amount: 97, ts: T0 }),
    eventoPagamento({ orderId: OID, provider: "mercadopago", paymentId: "1234567890", status: "refunded", normalized: "refund_confirmed", amount: 97, refundedTotal: 97, ts: T0 }),
    eventoPagamento({ orderId: OID, provider: "asaas", paymentId: "pay_abc123", status: "CONFIRMED", normalized: "payment_confirmed", amount: 97, ts: T0 }),
    eventoPagamento({ orderId: OID, provider: "stripe", paymentId: "pi_3Abc", status: "succeeded", normalized: "payment_confirmed", amount: 1, ts: T0 }),
    eventoEntrega({ orderId: OID, provider: "mercadopago", channel: "email", artifactSha256: "b".repeat(64), ts: T0 }),
    eventoEntrega({ provider: "hotmart", transaction: "HP17229876543210", channel: "store", status: "hotmart_approved", ts: T0 }),
    eventoReembolso({ orderId: OID, provider: "mercadopago", stage: "provider_call_may_have_been_sent", amount: 97, ts: T0 }),
    eventoReembolso({ orderId: OID, provider: "mercadopago", stage: "approved", refundId: 98765, amount: 97, ts: T0 }),
    eventoReembolso({ provider: "hotmart", transaction: "HP17229876543210", stage: "hotmart_purchase_refunded", ts: T0 }),
    eventoConsentimento({ event: "consent_given", subjectRef: REF, consentVersion: "lead-magnet-v1-2026-10-07", ts: T0 }),
    eventoConsentimento({ event: "confirmed", subjectRef: REF, consentVersion: "lead-magnet-v1-2026-10-07", ts: T0 + 1 }),
    eventoConsentimento({ event: "revoked_and_erased", subjectRef: REF, consentVersion: null, ts: T0 + 2 }),
  ];
  assert.deepEqual(evs.map((e) => e.tipo), ["order_created", "order_created", "payment_status", "payment_status", "payment_status", "payment_status",
    "delivery_sent", "delivery_sent", "refund", "refund", "refund", "consent_given", "consent_confirmed", "consent_revoked"], "[DS5.2] tipos");
  assert.equal(evs[2].event_key, `payment_status:ord${OID.replace(/-/g, "")}:mp1234567890:approved:r0`, "[DS5.3] chave determinística");
  assert.equal(new Set(evs.map((e) => e.event_key)).size, evs.length, "[DS5.4] chaves distintas");
  assert.doesNotMatch(JSON.stringify(evs), PII, "[DS5.5] nenhum dado pessoal");
  const db = createD1(MIGRATION);
  const ctx = fakeCtx();
  for (const e of evs) diarioSombra({ DIARIO: db }, ctx, e);
  const res = await ctx.drain();
  assert.deepEqual(res.filter((r) => !r.ok), [], "[DS5.6] todos aceitos pelo diário real");
  assert.equal((await verifyChain(db.rows(), { head: db.head() })).ok, true);
  assert.equal(eventoConsentimento({ event: "erase_kv_pending", subjectRef: REF }), null, "[DS5.7] evento de lead sem tipo do diário: nada");
  assert.equal(eventoConsentimento({ event: "consent_given", subjectRef: null }), null, "[DS5.8] sem subject_ref: nada");
  assert.equal(eventoConsentimento({ event: "consent_given", subjectRef: "cliente@example.com" }), null, "[DS5.9] ref que não é HMAC: nada");
  assert.deepEqual(Object.keys(LEAD_EVENTO_TIPO).sort(), ["confirmed", "consent_given", "revoked_and_erased"]);
  const db2 = createD1(MIGRATION);
  const r = await diarioSombra({ DIARIO: db2 }, null, eventoPedidoCriado({ orderId: "11111111-2222-4333-8444-555555555555", provider: "mercadopago", amount: 1 })).task;
  assert.equal(r.ok, true, "[DS5.10] UUID com bloco de 12 dígitos é aceito pelo diário real");
});

test("DS6 contexto da requisição: ganchos sem env/ctx usam o banco e o waitUntil do comDiario", async () => {
  const db = createD1(MIGRATION);
  const ctx = fakeCtx();
  const inner = await comDiario({ DIARIO: db }, ctx, async () => {
    await Promise.resolve();
    return diarioSombra(null, null, () => evento(1));
  });
  assert.equal(inner.queued, true, "[DS6.1] achou o banco pelo contexto");
  assert.equal(ctx.tasks.length, 1, "[DS6.2] usou o waitUntil da requisição");
  await ctx.drain();
  assert.equal(db.rows().length, 1);
  comDiario({}, ctx, () => null);
  assert.equal(globalThis.__ZEVANORY_DIARIO__, null, "[DS6.3] requisição sem DIARIO limpa o binding global");
  assert.deepEqual(diarioSombra(null, null, () => evento(2)), { queued: false, reason: "sem_binding" });
});

// ---------------------------------------------------------------------------------------------------------
// Integração com as funções reais (env falso)
const kvStore = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } }; };
const HOTTOK = "hottok-test-0123456789abcdef";
const hotmartReq = (event, txn = "HP17229876543210") => new Request("https://zevanory.api.br/api/webhooks/hotmart", {
  method: "POST", headers: { "x-hotmart-hottok": HOTTOK, "content-type": "application/json" },
  body: JSON.stringify({ event, data: { purchase: { transaction: txn, price: { value: 97, currency_value: "BRL" } }, product: { id: "1111111", name: "IA na Prática" }, buyer: { email: "cliente@example.com", name: "Cliente Teste" } } }),
});

test("DS7 Hotmart real: entrega e estorno gravados; resposta idêntica com, sem ou com diário quebrado", async () => {
  const run = async (diario, event) => {
    const env = { HOTMART_HOTTOK: HOTTOK, ZEVANORY_PRIVATE_ARTIFACTS: kvStore(), ...(diario ? { DIARIO: diario } : {}) };
    const ctx = fakeCtx();
    const r = await comDiario(env, ctx, () => handleDigitalHotmartNc012(hotmartReq(event), env));
    return { dump: await respDump(r), ctx };
  };
  const db = createD1(MIGRATION);
  const sem = await run(null, "PURCHASE_APPROVED");
  const com = await run(db, "PURCHASE_APPROVED");
  await com.ctx.drain();
  const rows = db.rows();
  assert.deepEqual(rows.map((r) => r.tipo), ["delivery_sent"], "[DS7.1] entrega Hotmart gravada");
  assert.doesNotMatch(rows[0].payload_json, PII, "[DS7.2] payload sem e-mail ou nome do comprador");
  assert.deepEqual(com.dump, sem.dump, "[DS7.3] resposta idêntica com e sem diário");
  const est = await run(db, "PURCHASE_REFUNDED");
  await est.ctx.drain();
  assert.deepEqual(db.rows().map((r) => r.tipo), ["delivery_sent", "refund"], "[DS7.4] estorno Hotmart gravado");
  const quebrado = await run(createD1(""), "PURCHASE_APPROVED");
  await quebrado.ctx.drain();
  assert.deepEqual(quebrado.dump, sem.dump, "[DS7.5] diário sem tabela: resposta idêntica");
  const pendurado = await within(run(hangingD1(), "PURCHASE_APPROVED"));
  assert.deepEqual(pendurado.dump, sem.dump, "[DS7.6] D1 que não responde não segura a resposta");
  assert.equal(pendurado.ctx.pending(), 1, "[DS7.10] a resposta sai com a gravação ainda pendente");
  assert.deepEqual((await pendurado.ctx.drain()).map((r) => r.code), ["diario_timeout"], "[DS7.7] gravação travada vira diario_timeout");
  const depois = await run(db, "PURCHASE_COMPLETE");
  assert.deepEqual((await depois.ctx.drain()).map((r) => r.ok), [true], "[DS7.9] a gravação depois do D1 travado roda");
  assert.equal(db.rows().length, 2, "[DS7.8] a fila segue depois do D1 travado (mesma transação: duplicata idempotente)");
});

const KEY_A = "a".repeat(40);
function leadSql() {
  const events = [];
  return { events, factory: () => ({ query: async (t, p = []) => {
    t = t.trim();
    if (/^create table|^alter table/i.test(t)) return [];
    if (/^select status, confirmed_at/i.test(t)) return [];
    if (/^insert into zevanory_leads/i.test(t)) return [];
    if (/^insert into zevanory_lead_events \(subject_ref, event, consent_version\) values/i.test(t)) { events.push(p[1]); return []; }
    throw new Error("sql inesperado: " + t.slice(0, 50));
  } }) };
}

test("DS8 consentimento real (lead-magnet): consent_given com subject_ref HMAC; resposta idêntica", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const run = async (diario) => {
      const env = { DATABASE_URL: "x", RESEND_API_KEY: "x".repeat(20), LEAD_PRIVACY_SECRET: KEY_A, ZEVANORY_PRIVATE_ARTIFACTS: kvStore(), ...(diario ? { DIARIO: diario } : {}) };
      const ctx = fakeCtx();
      const sql = leadSql();
      const req = new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify({ email: "Cliente@Example.com", name: "Cliente", consent: true }) });
      const r = await comDiario(env, ctx, () => handleLeadMagnet(req, env, { sqlFactory: sql.factory }));
      return { dump: await respDump(r), ctx, sql };
    };
    const db = createD1(MIGRATION);
    const sem = await run(null);
    const com = await run(db);
    await com.ctx.drain();
    const rows = db.rows();
    const expectedRef = createHmac("sha256", "zevanory-lead-privacy-v1:" + KEY_A).update("subject:cliente@example.com").digest("hex");
    assert.deepEqual(rows.map((r) => [r.tipo, r.ref]), [["consent_given", expectedRef]], "[DS8.1] consentimento gravado com a ref HMAC já existente");
    assert.doesNotMatch(rows[0].payload_json + rows[0].event_key, PII, "[DS8.2] sem e-mail ou nome");
    assert.match(rows[0].payload_json, /lead-magnet-v1-2026-10-07/, "[DS8.3] versão do consentimento");
    assert.deepEqual(com.dump, sem.dump, "[DS8.4] resposta idêntica");
    assert.deepEqual(com.sql.events, sem.sql.events, "[DS8.5] Neon recebe o mesmo evento");
    const quebrado = await run(createD1(""));
    await quebrado.ctx.drain();
    assert.deepEqual(quebrado.dump, sem.dump, "[DS8.6] diário sem tabela: resposta idêntica");
    const pendurado = await within(run(hangingD1()));
    assert.deepEqual(pendurado.dump, sem.dump, "[DS8.7] D1 que não responde não segura a resposta");
    assert.equal(pendurado.ctx.pending(), 1, "[DS8.8] a resposta sai com a gravação ainda pendente");
    await pendurado.ctx.drain();
  } finally { globalThis.fetch = origFetch; }
});

const ROID = "11111111-2222-4333-8444-555555555555";
const RTOKEN = "t".repeat(48); // valor sintético, sem formato de chave real
function refundFixture(diario) {
  const key = "refund:req:" + ROID;
  const state = new Map([[key, JSON.stringify({ status: "pending", order_id: ROID, payment_id: "1353422739", offer_id: "ZEV-IA-011", amount: 197, test: true })]]);
  let claim = null;
  const kv = { get: async (k) => state.get(k) ?? null, put: async (k, v) => { state.set(k, v); }, list: async () => ({ keys: [], list_complete: true }) };
  const env = { ZEVANORY_OPERATOR_TOKEN: RTOKEN, MERCADOPAGO_TEST_ACCESS_TOKEN: "TEST-FAKE-NONSECRET", ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://mock.invalid/test", ...(diario ? { DIARIO: diario } : {}) };
  const sqlFactory = () => ({ query: async (s, a = []) => {
    if (s.startsWith("insert into refund_provider_claims")) { if (claim) return []; claim = { stage: "provider_call_may_have_been_sent" }; return [{ order_id: a[0] }]; }
    return [];
  } });
  return { env, sqlFactory };
}

test("DS9 reembolso real: claim e aprovação gravados; resposta idêntica e nunca bloqueada", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith("/refunds") ? Response.json({ id: 98765, status: "approved" }) : Response.json({ id: 1353422739, payer: {} }));
  try {
    const run = async (diario) => {
      const f = refundFixture(diario);
      const ctx = fakeCtx();
      const req = new Request("https://zevanory.api.br/api/internal/certification/e2e/refund-approve?order_id=" + ROID, { method: "POST", headers: { "x-certification-e2e-token": RTOKEN } });
      const r = await handleRefundFlow(req, f.env, { sqlFactory: f.sqlFactory, ctx });
      return { dump: await respDump(r), ctx };
    };
    const db = createD1(MIGRATION);
    const sem = await run(null);
    const com = await run(db);
    assert.equal(com.ctx.tasks.length, 2, "[DS9.1] dois eventos via o ctx do handleRefundFlow");
    await com.ctx.drain();
    const rows = db.rows();
    assert.deepEqual(rows.map((r) => JSON.parse(r.payload_json).stage), ["provider_call_may_have_been_sent", "approved"], "[DS9.2] claim antes do POST e aprovação");
    assert.match(rows[1].payload_json, /"refund_ref":"mp98765"/, "[DS9.3] id do estorno com prefixo");
    assert.equal(sem.dump.status, 200);
    assert.deepEqual(com.dump, sem.dump, "[DS9.4] resposta idêntica");
    const pendurado = await within(run(hangingD1()));
    assert.deepEqual(pendurado.dump, sem.dump, "[DS9.5] D1 que não responde não segura a resposta");
    assert.equal(pendurado.ctx.pending(), 2, "[DS9.6] a resposta sai com as gravações ainda pendentes");
    await pendurado.ctx.drain();
  } finally { globalThis.fetch = origFetch; }
});

// ---------------------------------------------------------------------------------------------------------
// Estático: o bundle legado roda atrás do servidor node:http (cloudflare:node) e não carrega em Node. Cada gancho
// é conferido no ponto certo; o construtor de cada tipo já foi exercitado de verdade em DS5.
function fnBody(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, "início não encontrado: " + start);
  const b = src.indexOf(end, a);
  assert.ok(b > a, "fim não encontrado: " + end);
  return src.slice(a, b);
}
const HOOKS = [
  { id: "checkout Asaas", fn: ["async function handler11(req, res) {", '__name(handler11, "handler")'], after: "INSERT INTO orders", call: /if \(inserted\.length\) \{\n\s+order = \{ order_id: orderId[^\n]*\n[^\n]*\n\s+diarioSombra\(null, null, \(\) => eventoPedidoCriado\(\{ orderId, provider: "asaas"/ },
  { id: "checkout Mercado Pago", fn: ["async function handler12(req, res) {", '__name(handler12, "handler")'], after: "INSERT INTO orders", call: /\n\s+if \(inserted\.length\) diarioSombra\(null, null, \(\) => eventoPedidoCriado\(\{ orderId, provider: "mercadopago"/ },
  { id: "checkout Stripe", fn: ["async function handleStripeCheckout(req, res) {", '__name(handleStripeCheckout,'], after: "INSERT INTO orders", call: /\n\s+if \(inserted\.length\) diarioSombra\(null, null, \(\) => eventoPedidoCriado\(\{ orderId, provider: "stripe"/ },
  { id: "webhook Asaas", fn: ["async function handler15(req, res) {", '__name(handler15, "handler")'], after: "const outcome = rows[0] || {};", call: /\n\s+if \(Number\(outcome\.inserted_count\) === 1\) diarioSombra\(null, null, \(\) => eventoPagamento\(\{ orderId, provider: "asaas"/ },
  { id: "webhook Mercado Pago", fn: ["async function handleMercadoPagoWebhook(req, res,", '__name(handleMercadoPagoWebhook,'], after: "const outcome = rows[0] || {};", call: /\n\s+if \(Number\(outcome\.inserted_count\) === 1\) diarioSombra\(null, null, \(\) => eventoPagamento\(\{ orderId: String\(orders\[0\]\.order_id\), provider: "mercadopago"/ },
  { id: "entrega Mercado Pago", fn: ["async function handleMercadoPagoWebhook(req, res,", '__name(handleMercadoPagoWebhook,'], after: "deliveryEvidence = await ensureMercadoPagoDigitalDelivery(", call: /\n\s+if \(deliveryEvidence\?\.email_status === "sent"\) diarioSombra\(null, null, \(\) => eventoEntrega\(\{ orderId: String\(orders\[0\]\.order_id\), provider: "mercadopago"/ },
  { id: "webhook Stripe", fn: ["async function handleStripeWebhook(req, res) {", '__name(handleStripeWebhook,'], after: "const outcome = rows[0] || {};", call: /\n\s+if \(Number\(outcome\.inserted_count\) === 1\) diarioSombra\(null, null, \(\) => eventoPagamento\(\{ orderId, provider: "stripe"/ },
];

test("DS10 bundle legado: um gancho por ponto crítico, depois do fato no Neon, sem await", () => {
  assert.match(RECOVERED, /^import \{ diarioSombra, eventoPedidoCriado, eventoPagamento, eventoEntrega \} from "\.\/diario-sombra\.mjs";$/m, "[DS10.1] import do adaptador");
  for (const h of HOOKS) {
    const body = fnBody(RECOVERED, h.fn[0], h.fn[1]);
    const m = body.match(h.call);
    assert.ok(m, `[DS10.2] gancho presente: ${h.id}`);
    assert.ok(body.indexOf(h.after) >= 0 && body.indexOf(h.after) < m.index, `[DS10.3] gancho depois do fato: ${h.id}`);
    assert.equal((body.match(/diarioSombra\(/g) || []).length >= 1, true);
  }
  assert.equal((RECOVERED.match(/diarioSombra\(/g) || []).length, HOOKS.length, "[DS10.4] nenhum gancho a mais ou a menos");
});

test("DS11 compat envolve a requisição; nenhum gancho espera; o adaptador não usa KV", () => {
  assert.match(COMPAT, /^import \{ comDiario \} from "\.\/diario-sombra\.mjs";$/m);
  assert.match(COMPAT, /const response=await comDiario\(env, ctx, \(\) => wrapped\.processFetch\(request, meteredEnv, ctx\)\);/, "[DS11.1] processFetch dentro do contexto do diário");
  const files = ["worker/cloudflare-worker.recovered.mjs", "worker/cloudflare-worker.compat.mjs", "worker/lead-magnet.mjs", "worker/refund-flow.mjs", "worker/cp-nc012-digital-hotmart.mjs"];
  let calls = 0;
  for (const f of files) {
    const src = readTextNormalized(new URL("../" + f, import.meta.url));
    assert.doesNotMatch(src, /await\s+diarioSombra|diarioSombra\([^\n]*\)\.task|\.then\(\s*\(\)\s*=>\s*diarioSombra/, `[DS11.2] nenhum gancho espera a gravação: ${f}`);
    for (const line of src.split("\n").filter((l) => /\bdiarioSombra\(/.test(l) && !/^\s*import/.test(l))) {
      calls++;
      assert.match(line, /diarioSombra\((null|env), ?(null|ctx), ?\(\) ?=> ?evento[A-Z]\w*\(/, `[DS11.3] gancho com construtor protegido: ${f}`);
    }
  }
  assert.equal(calls, HOOKS.length + 2 + 2 + 1, "[DS11.4] 7 no bundle, 2 no Hotmart, 2 no reembolso, 1 no consentimento");
  const code = SOMBRA.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /ZEVANORY_PRIVATE_ARTIFACTS|__ZEVANORY_PRIVATE_KV__|\.put\(|\bkv\b/i, "[DS11.5] o diário não usa KV");
  assert.doesNotMatch(SOMBRA, /^\s*import .*node:/m, "[DS11.6] sem import estático de módulo node");
});
