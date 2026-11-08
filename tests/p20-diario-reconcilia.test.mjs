// P20 diário D1, PR 4: reconciliação diária Neon × diário (worker/diario-reconcilia.mjs) e o campo diario do relatório
// do backup (worker/data-backup.mjs, finalizeBackup). D1 falso com SQL de verdade (tests/helpers/d1-sqlite.mjs, migrações
// reais 0001 e 0002) e Neon falso que responde a cada fonte pela forma da consulta e filtra pela janela recebida.
// O diário é preenchido pelos MESMOS construtores e argumentos dos ganchos (recovered, refund-flow, lead-magnet).
// Sem rede, sem segredo, sem Cloudflare. Marcadores [RCn.k] usados pelos mutantes (scripts/ci/mutants_p20_diario_reconcilia.py).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { createD1 } from "./helpers/d1-sqlite.mjs";
import { appendEvent } from "../worker/diario-p20.mjs";
import { eventoPedidoCriado, eventoPagamento, eventoEntrega, eventoReembolso, eventoConsentimento, configurarDiarioSombra, comDiario } from "../worker/diario-sombra.mjs";
import { reconciliaDiario, efeitoNoRelatorio, DIARIO_FASE, SQL_JANELA_D1, JANELA_INICIO_MS, JANELA_FIM_MS, MARGEM_MS } from "../worker/diario-reconcilia.mjs";
import { finalizeBackup, REPORT_KEY } from "../worker/data-backup.mjs";
import { handleLeadMagnet } from "../worker/lead-magnet.mjs";
import { reconcileRefund } from "../worker/refund-provider-claims.mjs";

const MIGRATION = readTextNormalized(new URL("../migrations/d1/0001_diario_v1.sql", import.meta.url))
  + "\n" + readTextNormalized(new URL("../migrations/d1/0002_diario_v1_ts.sql", import.meta.url));
// Relógio manual que nunca dispara: nenhum D1 aqui trava, e uma gravação lenta (máquina carregada) nunca vira timeout.
configurarDiarioSombra({ agendar: () => () => {} });
const NOW = Date.UTC(2026, 10, 8, 6, 0, 0);
const H = 3600 * 1000;
const O1 = "3f2a9c1e-7b4d-4abc-9def-0123456789ab"; // Mercado Pago
const O2 = "9b1c0d2e-3f4a-4b5c-8d6e-7f8091a2b3c4"; // Asaas
const O3 = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"; // Stripe (certificação)
const REF = "c".repeat(64);
const PII = /@|payload_json|Cliente|cliente|"amount"/;

function fakeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
}

const FONTE = [["orders", /from orders where/], ["financial_events", /from financial_events where/], ["service_fulfillment", /from service_fulfillment sf/], ["refund_provider_claims", /from refund_provider_claims where/], ["zevanory_lead_events", /from zevanory_lead_events where/]];
// Neon falso: identifica a fonte pela consulta e devolve as linhas cujo instante cai em [$1, $2] (como o banco faria).
function fakeNeon(data, { erro = [], ausente = [] } = {}) {
  const calls = [];
  const query = async (text, params = []) => {
    const f = (FONTE.find(([, re]) => re.test(text)) || [null])[0];
    calls.push({ fonte: f, params });
    if (!f) throw new Error("consulta inesperada: " + text.slice(0, 60));
    if (ausente.includes(f)) throw Object.assign(new Error(`relation "${f}" does not exist`), { code: "42P01" });
    if (erro.includes(f)) throw new Error("neon caiu");
    const [de, ate, eventos] = params;
    const dentro = (ts) => ts != null && ts >= de && ts <= ate;
    return (data[f] || []).filter((r) => (f === "refund_provider_claims" ? dentro(r.ts_claim) || dentro(r.ts_rec) : dentro(r.ts_ms)) && (f !== "zevanory_lead_events" || eventos.includes(r.event)));
  };
  return { calls, factory: () => ({ query }) };
}

// Cenário completo: cada linha do Neon e o evento que o gancho correspondente gravou (mesmos argumentos do gancho;
// o relógio do Worker difere do now() do Neon em alguns segundos).
function cenario() {
  const t = (h, skew = 0) => NOW - h * H + skew;
  const neon = {
    orders: [
      { order_id: O1, provider: "mercadopago", ts_ms: t(10) },
      { order_id: O2, provider: "asaas", ts_ms: t(20) },
      { order_id: O3, provider: "stripe", ts_ms: t(30) },
    ],
    financial_events: [
      { order_id: O1, provider: "mercadopago", payment_id: "1234567890", status: "approved", refunded_total: null, ts_ms: t(9) },
      { order_id: O1, provider: "mercadopago", payment_id: "1234567890", status: "refunded", refunded_total: "97.00", ts_ms: t(5) },
      { order_id: O2, provider: "asaas", payment_id: "pay_abc123", status: "RECEIVED", refunded_total: null, ts_ms: t(19) },
      { order_id: O3, provider: "stripe", payment_id: "pi_3Abc", status: "succeeded", refunded_total: null, ts_ms: t(29) },
    ],
    service_fulfillment: [{ order_id: O1, ts_ms: t(8.9) }],
    refund_provider_claims: [{ order_id: O1, stage: "reconciled_refunded", reconciled_status: "approved", ts_claim: t(6), ts_rec: t(5.9) }],
    zevanory_lead_events: [
      { subject_ref: REF, event: "consent_given", consent_version: "lead-magnet-v1-2026-10-07", ts_ms: t(12) },
      { subject_ref: REF, event: "confirmed", consent_version: "lead-magnet-v1-2026-10-07", ts_ms: t(11) },
    ],
  };
  const eventos = [
    eventoPedidoCriado({ orderId: O1, provider: "mercadopago", offerId: "ia-na-pratica", amount: 97, certification: false, ts: t(10, 900) }),
    eventoPedidoCriado({ orderId: O2, provider: "asaas", offerId: "ia-na-pratica", amount: 97, certification: false, ts: t(20, 700) }),
    eventoPedidoCriado({ orderId: O3, provider: "stripe", offerId: "ia-na-pratica", amount: 1, certification: true, ts: t(30, 1200) }),
    eventoPagamento({ orderId: O1, provider: "mercadopago", paymentId: "1234567890", status: "approved", normalized: "payment_confirmed", amount: 97, refundedTotal: null, ts: t(9, 400) }),
    eventoEntrega({ orderId: O1, provider: "mercadopago", channel: "email", artifactSha256: "d".repeat(64), ts: t(8.9, 2000) }),
    eventoReembolso({ orderId: O1, provider: "mercadopago", stage: "provider_call_may_have_been_sent", amount: 97, ts: t(6, 300) }),
    eventoReembolso({ orderId: O1, provider: "mercadopago", stage: "approved", refundId: "88990011", amount: 97, ts: t(5.9, 1500) }),
    eventoPagamento({ orderId: O1, provider: "mercadopago", paymentId: "1234567890", status: "refunded", normalized: "refund_confirmed", amount: 97, refundedTotal: 97, ts: t(5, 600) }),
    eventoPagamento({ orderId: O2, provider: "asaas", paymentId: "pay_abc123", status: "RECEIVED", normalized: "payment_confirmed", amount: 97, refundedTotal: null, ts: t(19, 300) }),
    eventoPagamento({ orderId: O3, provider: "stripe", paymentId: "pi_3Abc", status: "succeeded", normalized: "payment_confirmed", amount: 1, refundedTotal: 0, certification: true, ts: t(29, 800) }),
    eventoConsentimento({ event: "consent_given", subjectRef: REF, consentVersion: "lead-magnet-v1-2026-10-07", ts: t(12) }),
    eventoConsentimento({ event: "confirmed", subjectRef: REF, consentVersion: "lead-magnet-v1-2026-10-07", ts: t(11) }),
    // Hotmart: vive no KV e no provedor, não no Neon (fora do escopo, contado à parte).
    eventoEntrega({ provider: "hotmart", transaction: "HP17220001", channel: "store", status: "hotmart_approved", ts: t(7) }),
  ];
  return { neon, eventos, t };
}

async function diarioCom(eventos, before = []) {
  const db = createD1(MIGRATION);
  for (const ev of [...before, ...eventos].sort((a, b) => a.ts_ms - b.ts_ms)) {
    const r = await appendEvent(db, ev);
    assert.equal(r.ok, true, "gravação do cenário: " + r.code);
  }
  return db;
}
const ENV = (db) => ({ DIARIO: db, DATABASE_URL: "postgres://sintetico" });

test("RC1 sem binding DIARIO: nao_configurado, nenhuma consulta, relatório do backup inalterado", async () => {
  const neon = fakeNeon({});
  const r = await reconciliaDiario({ DATABASE_URL: "postgres://sintetico" }, { sqlFactory: neon.factory, now: NOW });
  assert.equal(r.estado, "nao_configurado", "[RC1.1] estado");
  assert.equal(neon.calls.length, 0, "[RC1.2] sem binding, nenhuma consulta ao Neon");
  assert.deepEqual(efeitoNoRelatorio(r), { falha: null, alerta: null }, "[RC1.3] sem falha e sem alerta");
  assert.equal(DIARIO_FASE, "sombra", "[RC1.4] fase do código: sombra até o corte documentado");
});

test("RC2 tudo casa: mesmas chaves dos ganchos, cadeia íntegra, Hotmart fora do escopo", async () => {
  const { neon, eventos } = cenario();
  const db = await diarioCom(eventos);
  const n = fakeNeon(neon);
  const r = await reconciliaDiario(ENV(db), { sqlFactory: n.factory, now: NOW });
  assert.equal(r.estado, "ok", "[RC2.1] estado ok: " + JSON.stringify(r.amostra));
  assert.equal(r.esperados, 12, "[RC2.2] 12 esperados (3 pedidos, 4 pagamentos, 1 entrega, 2 estornos, 2 consentimentos)");
  assert.equal(r.presentes, 12, "[RC2.3] 12 presentes reconciliáveis");
  assert.equal(r.faltando, 0, "[RC2.4] nada faltando");
  assert.equal(r.sobrando, 0, "[RC2.5] nada sobrando");
  assert.equal(r.cadeia_ok, true, "[RC2.6] cadeia íntegra");
  assert.deepEqual(r.fora_escopo, { hotmart_fora_do_neon: 1 }, "[RC2.7] Hotmart contado fora do escopo");
  assert.deepEqual(Object.keys(r.por_tipo).sort(), ["consent_confirmed", "consent_given", "delivery_sent", "order_created", "payment_status", "refund"], "[RC2.8] todos os tipos reconciliados");
  assert.equal(r.d1.consultas, 1, "[RC2.9] uma consulta D1 para a janela");
  assert.deepEqual(n.calls.map((c) => c.fonte).sort(), ["financial_events", "orders", "refund_provider_claims", "service_fulfillment", "zevanory_lead_events"], "[RC2.10] uma consulta por fonte do Neon");
  assert.equal(n.calls[0].params[0], NOW - JANELA_INICIO_MS - MARGEM_MS, "[RC2.11] Neon lido na janela larga (início)");
  assert.equal(n.calls[0].params[1], NOW - JANELA_FIM_MS + MARGEM_MS, "[RC2.12] Neon lido na janela larga (fim)");
  assert.doesNotMatch(JSON.stringify(r), PII, "[RC2.13] relatório sem PII nem payload");
});

test("RC3 evento faltando no diário: divergente; sombra = alerta, ativo = falha de P20 no relatório do backup", async () => {
  const { neon, eventos } = cenario();
  const semEntrega = eventos.filter((e) => !(e.tipo === "delivery_sent" && e.payload.provider === "mercadopago"));
  const db = await diarioCom(semEntrega);
  const n = fakeNeon(neon);
  const r = await reconciliaDiario(ENV(db), { sqlFactory: n.factory, now: NOW });
  assert.equal(r.estado, "divergente", "[RC3.1] divergente");
  assert.equal(r.faltando, 1, "[RC3.2] um faltando");
  assert.deepEqual(r.amostra.faltando, [eventoEntrega({ orderId: O1, provider: "mercadopago", channel: "email" }).event_key], "[RC3.3] a chave faltante é a do gancho");
  assert.equal(r.sobrando, 0, "[RC3.4] nada sobrando");
  const parte = { day: new Date(NOW).toISOString().slice(0, 10), part: 0, failures: [], kv: {}, totalTables: 1, neon: { tables: 1, rows: 1, excluded: [], skipped: [] }, restore: { neon: { tables: 1, ok: 1, rows: 1 }, kv: {} }, encryption: { state: "cifrado", kid: "k1" } };
  const kvS = fakeKv({ [`${REPORT_KEY}:part:0`]: JSON.stringify(parte) });
  const sombra = await finalizeBackup({ ...ENV(db), ZEVANORY_PRIVATE_ARTIFACTS: kvS }, { parts: 1, now: NOW, encryptionRequired: false, sqlFactory: n.factory });
  assert.equal(sombra.ok, true, "[RC3.5] em sombra o backup não reprova: " + JSON.stringify(sombra.failures));
  assert.ok(sombra.warnings.includes("diario_divergente:sombra"), "[RC3.6] em sombra vira alerta");
  assert.equal(JSON.parse(kvS.m.get(REPORT_KEY)).diario.faltando, 1, "[RC3.7] resultado gravado em zpc:backup:v1:report (campo diario)");
  const kvA = fakeKv({ [`${REPORT_KEY}:part:0`]: JSON.stringify(parte) });
  const ativo = await finalizeBackup({ ...ENV(db), ZEVANORY_PRIVATE_ARTIFACTS: kvA }, { parts: 1, now: NOW, encryptionRequired: false, sqlFactory: n.factory, diarioFase: "ativo" });
  assert.equal(ativo.ok, false, "[RC3.8] em ativo a divergência reprova o backup");
  assert.ok(ativo.failures.includes("diario_divergente"), "[RC3.9] falha de P20 nomeada");
  const ok = await finalizeBackup({ ...ENV(await diarioCom(eventos)), ZEVANORY_PRIVATE_ARTIFACTS: fakeKv({ [`${REPORT_KEY}:part:0`]: JSON.stringify(parte) }) }, { parts: 1, now: NOW, encryptionRequired: false, sqlFactory: n.factory, diarioFase: "ativo" });
  assert.equal(ok.ok, true, "[RC3.10] em ativo, sem divergência, o backup passa: " + JSON.stringify(ok.failures));
  const desconhecida = efeitoNoRelatorio({ estado: "divergente", fase: "qualquer" });
  assert.equal(desconhecida.falha, "diario_divergente", "[RC3.11] fase desconhecida cai no lado estrito (ativo)");
});

test("RC4 evento sobrando no diário (sem origem no Neon) e chave com outra normalização: divergente", async () => {
  const { neon, eventos, t } = cenario();
  const extra = eventoPedidoCriado({ orderId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", provider: "mercadopago", ts: t(3) });
  const db = await diarioCom([...eventos, extra]);
  const r = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(r.estado, "divergente", "[RC4.1] divergente");
  assert.deepEqual(r.amostra.sobrando, [extra.event_key], "[RC4.2] a chave sem origem aparece em sobrando");
  assert.equal(r.faltando, 0, "[RC4.3] nada faltando");
  // Um gancho que gravasse o UUID cru (sem techRef) não casaria com a derivação do Neon.
  const cru = { ...eventos[0], event_key: "order_created:" + O1.replace(/-/g, "_"), ts_ms: eventos[0].ts_ms };
  const db2 = await diarioCom([cru, ...eventos.slice(1)]);
  const r2 = await reconciliaDiario(ENV(db2), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(r2.faltando, 1, "[RC4.4] chave normalizada de outro jeito = faltando");
  assert.equal(r2.sobrando, 1, "[RC4.5] e sobrando");
});

test("RC5 cadeia adulterada na janela ou âncora anterior adulterada: cadeia_ok false, divergente", async () => {
  const { neon, eventos, t } = cenario();
  const antigo = eventoPedidoCriado({ orderId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", provider: "mercadopago", ts: t(60) });
  const db = await diarioCom(eventos, [antigo]);
  const limpo = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(limpo.estado, "ok", "[RC5.1] com linha anterior à janela, a âncora prende o trecho e a cadeia fecha");
  assert.equal(limpo.cadeia.linhas, eventos.length, "[RC5.2] trecho = só as linhas da janela (âncora fora)");
  db.raw.exec("drop trigger diario_v1_sem_update");
  db.raw.prepare("update diario_v1 set payload_json = replace(payload_json, '97', '98') where seq = 4").run();
  const r = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(r.cadeia_ok, false, "[RC5.3] adulteração detectada");
  assert.equal(r.estado, "divergente", "[RC5.4] cadeia quebrada é divergência");
  assert.equal(r.cadeia.broken_at, 4, "[RC5.5] seq da quebra");
  const db2 = await diarioCom(eventos, [antigo]);
  db2.raw.exec("drop trigger diario_v1_sem_update");
  db2.raw.prepare("update diario_v1 set chain_hash = ? where seq = 1").run("e".repeat(64));
  const r2 = await reconciliaDiario(ENV(db2), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(r2.cadeia_ok, false, "[RC5.6] âncora adulterada: o trecho não encadeia");
});

test("RC6 bordas da janela: relógios diferentes não geram falso alarme; fora da janela não conta", async () => {
  const { neon, eventos } = cenario();
  const de = NOW - JANELA_INICIO_MS, ate = NOW - JANELA_FIM_MS;
  const OB = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", OC = "4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a", OV = "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c", ON = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";
  const n2 = { ...neon, orders: [...neon.orders,
    { order_id: OB, provider: "mercadopago", ts_ms: de + 5000 }, // Neon dentro; Worker gravou 30 s antes (fora do núcleo)
    { order_id: OC, provider: "mercadopago", ts_ms: ate + 20000 }, // Neon fora (depois de T−1h); Worker 40 s antes (dentro)
    { order_id: OV, provider: "mercadopago", ts_ms: NOW - 50 * H }, // velho: fora da janela
  ] };
  const extras = [
    eventoPedidoCriado({ orderId: OB, provider: "mercadopago", ts: de - 25000 }),
    eventoPedidoCriado({ orderId: OC, provider: "mercadopago", ts: ate - 20000 }),
    eventoPedidoCriado({ orderId: ON, provider: "mercadopago", ts: NOW - 10 * 60 * 1000 }), // última hora: ainda não reconciliado
  ];
  const db = await diarioCom([...eventos, ...extras]);
  const r = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(n2).factory, now: NOW });
  assert.equal(r.faltando, 0, "[RC6.1] borda inicial: o lado do diário é lido com margem");
  assert.equal(r.sobrando, 0, "[RC6.2] borda final: o lado do Neon é lido com margem");
  assert.equal(r.estado, "ok", "[RC6.3] estado ok: " + JSON.stringify(r.amostra));
  assert.equal(r.esperados, 13, "[RC6.4] OB conta (Neon no núcleo); OC e o pedido velho não");
  assert.equal(r.presentes, 13, "[RC6.5] OC conta (diário no núcleo); OB e o da última hora não");
});

test("RC7 paginação e cota: uma consulta por página, fixa; limite de páginas = incompleto, nunca ok", async () => {
  const { neon, eventos } = cenario();
  const db = await diarioCom(eventos);
  const sqls = [];
  const orig = db.prepare;
  const spy = { ...db, prepare: (sql) => { sqls.push(sql); return orig(sql); } };
  const mod = await import("../worker/diario-reconcilia.mjs");
  const lido = await mod.linhasDoDiario(spy, NOW - JANELA_INICIO_MS - MARGEM_MS, NOW, { pagina: 5 });
  assert.equal(lido.rows.length, eventos.length, "[RC7.1] todas as linhas lidas por páginas");
  assert.equal(lido.consultas, 3, "[RC7.2] 13 linhas em páginas de 5 = 3 consultas");
  assert.ok(sqls.every((s) => s === SQL_JANELA_D1), "[RC7.3] só a consulta fixa da janela (SELECT)");
  assert.match(SQL_JANELA_D1, /^with b as \(select/, "[RC7.4] consulta somente leitura");
  const corte = await mod.linhasDoDiario(db, 0, NOW, { pagina: 5, maxPaginas: 2 });
  assert.equal(corte.completo, false, "[RC7.5] limite de páginas atingido");
  const plan = db.raw.prepare("explain query plan " + SQL_JANELA_D1).all().map((x) => x.detail).join(" ");
  assert.equal((plan.match(/COVERING INDEX diario_v1_ts \(ts_ms>\? AND ts_ms<\?\)/g) || []).length, 2, "[RC7.6] os dois limites da janela pelo índice de ts_ms (migração 0002): " + plan);
});

test("RC8 Neon: tabela ainda inexistente = fonte vazia; erro de fonte ou D1 indisponível = incompleto (alerta em sombra)", async () => {
  const { neon, eventos } = cenario();
  const db = await diarioCom(eventos.filter((e) => e.tipo !== "refund"));
  const r = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(neon, { ausente: ["refund_provider_claims"] }).factory, now: NOW });
  assert.equal(r.neon.fontes.refund_provider_claims, "ausente", "[RC8.1] tabela criada sob demanda e ausente");
  assert.equal(r.estado, "ok", "[RC8.2] fonte ausente não é divergência");
  const e = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon(neon, { erro: ["orders"] }).factory, now: NOW });
  assert.equal(e.estado, "incompleto", "[RC8.3] fonte com erro: incompleto");
  assert.deepEqual(efeitoNoRelatorio(e), { falha: null, alerta: "diario_incompleto:sombra" }, "[RC8.4] em sombra, alerta");
  const quebrado = { prepare: () => ({ bind() { return this; }, all: async () => { throw new Error("D1_ERROR"); } }) };
  const d = await reconciliaDiario(ENV(quebrado), { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(d.estado, "incompleto", "[RC8.5] D1 indisponível: incompleto");
  assert.equal(d.motivo, "d1_indisponivel", "[RC8.6] motivo");
  const semNeon = await reconciliaDiario({ DIARIO: db }, { sqlFactory: fakeNeon(neon).factory, now: NOW });
  assert.equal(semNeon.estado, "incompleto", "[RC8.7] binding sem DATABASE_URL: incompleto");
});

test("RC9 consentimento real (lead-magnet): o gancho usa o instante do Neon e a reconciliação deriva a mesma chave", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const AT = NOW - 7 * H + 123; // instante "do Neon" devolvido pelo RETURNING
  const lead = [];
  const sql = { query: async (text, p = []) => {
    const t = text.trim();
    if (/^create table|^alter table|^select status, confirmed_at|^insert into zevanory_leads/i.test(t)) return [];
    if (/^insert into zevanory_lead_events \(subject_ref, event, consent_version\) values \(\$1, \$2, \$3\) returning \(floor\(extract\(epoch from at\) \* 1000\)\)::bigint as ts_ms$/i.test(t)) {
      lead.push({ subject_ref: p[0], event: p[1], consent_version: p[2], ts_ms: AT });
      return [{ ts_ms: String(AT) }];
    }
    throw new Error("sql inesperado: " + t.slice(0, 60));
  } };
  try {
    const db = createD1(MIGRATION);
    const env = { DATABASE_URL: "x", RESEND_API_KEY: "x".repeat(20), LEAD_PRIVACY_SECRET: "a".repeat(40), ZEVANORY_PRIVATE_ARTIFACTS: fakeKv(), DIARIO: db };
    const req = new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify({ email: "Cliente@Example.com", name: "Cliente", consent: true }) });
    const tasks = [];
    await comDiario(env, { waitUntil: (p) => tasks.push(p) }, () => handleLeadMagnet(req, env, { sqlFactory: () => sql }));
    await Promise.all(tasks);
    assert.equal(db.rows().length, 1, "[RC9.1] consentimento gravado no diário");
    assert.equal(Number(db.rows()[0].ts_ms), AT, "[RC9.2] ts do diário = instante do Neon");
    const r = await reconciliaDiario(ENV(db), { sqlFactory: fakeNeon({ zevanory_lead_events: lead }).factory, now: NOW });
    assert.equal(r.estado, "ok", "[RC9.3] chave de consentimento derivável do Neon: " + JSON.stringify(r.amostra));
    assert.equal(r.esperados, 1, "[RC9.4] um esperado");
  } finally { globalThis.fetch = origFetch; }
});

test("RC10 estorno confirmado pela consulta ao provedor (reconcileRefund) também grava refund approved", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 1234567890, status: "refunded", status_detail: "refunded", transaction_amount: 97, transaction_amount_refunded: 97, refunds: [{ id: 88990011, status: "approved", amount: 97 }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const db = createD1(MIGRATION);
    const kv = fakeKv({ ["refund:req:" + O1]: JSON.stringify({ order_id: O1, payment_id: "1234567890", amount: 97, test: false, status: "pending", provider_outcome_unknown: true }) });
    const claim = { order_id: O1, payment_id: "1234567890", test: false, stage: "provider_call_may_have_been_sent", claimed_at: new Date(Date.now() - 2 * H).toISOString(), reconciled_at: null, reconciled_status: null };
    const sql = { query: async (t) => (/^select order_id,payment_id,test,stage/.test(t.trim()) ? [claim] : []) };
    const out = await reconcileRefund({ DIARIO: db, MERCADOPAGO_ACCESS_TOKEN: "sintetico" }, sql, kv, O1);
    assert.equal(out.status, 200, "[RC10.1] reconciliação do estorno aprovada: " + JSON.stringify(out.body));
    for (let i = 0; i < 50 && db.rows().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const keys = db.rows().map((r) => r.event_key);
    const base = eventoReembolso({ orderId: O1, provider: "mercadopago", stage: "approved" }).event_key;
    assert.ok(keys.length === 1 && keys[0].startsWith(base + ":"), "[RC10.2] refund approved no diário: " + JSON.stringify(keys));
  } finally { globalThis.fetch = origFetch; }
});
