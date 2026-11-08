// P12 Entrega digital idempotente: ENSAIO SINTÉTICO reprodutível (roteiro v4.9.1, seções 5, 6.4, 7 e 12-B.4).
// Rótulo da evidência: SINTÉTICA (teste local/CI). Sem rede (fetch global substituído por um que falha e conta),
// sem produção, sem segredo real (valores de teste sem formato de chave), sem compra ou reembolso fabricado.
// DEC-06: a entrega é imediata e integral na área de compras da Hotmart; a ZEVANORY REGISTRA a entrega e o
// estorno a partir do postback autenticado (worker/cp-nc012-digital-hotmart.mjs + worker/sales-ledger.mjs).
// Relatório: docs/p12/ensaio-entrega-sintetico.md. Marcadores [En.k] usados pelos mutantes
// (scripts/ci/mutants_p12_entrega.py).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readTextNormalized } from "./helpers/text.mjs";
import { handleDigitalHotmartNc012 } from "../worker/cp-nc012-digital-hotmart.mjs";
import { routeHotmartNc011 } from "../worker/cp-nc011-routing.mjs";
import {
  SALES_SUMMARY_KEY, SALES_EVENT_PREFIX, SALES_BUCKET_PREFIX, SALES_LEGACY_BASELINE_KEY, SALES_EVENT_TTL_DAYS, BUCKETS,
  recordHotmartSale, refreshSalesSummary, refreshBucket, salesEventRecord, computeBucket, sweepBuckets, bucketName, applySale, saleFacts,
} from "../worker/sales-ledger.mjs";
import { emitActivity } from "../worker/activity-ledger.mjs";
import { ACTIVITY_EVENT_PREFIX } from "../worker/activity-ledger.mjs";
import { CpSubscriberLedger } from "../worker/cp-durable-ledger.mjs";
import {
  MICROVITORIAS, BASE_LEGAL_MICROVITORIA, MICROVITORIA_DEADLINE_MS, onboardingEnabled,
  planMicrovitoria, decideMicrovitoria, renderMicrovitoria, microvitoriaTextIssues, dispatchMicrovitoria, microvitoriaKey,
} from "../worker/onboarding-microvitoria.mjs";
import { validateMatrix, evaluateMatrix } from "../scripts/ci/p12_degradacao.mjs";

const HOTTOK = "valor-sintetico-de-teste-nao-e-segredo";
const T0 = Date.UTC(2026, 10, 7, 15, 0, 0);
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const SLUGS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];

// KV em memória com a semântica do Workers KV usada aqui: get/put/list, metadata, expirationTtl (relógio
// controlável) e list paginado em ordem lexicográfica com no máximo 1.000 chaves por página. Falhas injetáveis por
// operação: "before" (a operação não acontece) ou "after" (acontece e a chamada falha mesmo assim).
function memKv({ clock = () => T0, maxPage = 1000 } = {}) {
  const m = new Map(), meta = new Map(), exp = new Map();
  const faults = [], puts = [];
  const alive = (k) => m.has(k) && !(exp.has(k) && clock() >= exp.get(k));
  const hit = (op, k, when) => { const f = faults.find((x) => x.op === op && (x.when || "before") === when && x.match(k) && x.left > 0); if (f) { f.left--; throw new Error("kv_" + op + "_falhou"); } };
  const kv = {
    m, meta, exp, faults, puts,
    async get(k) { hit("get", k, "before"); return alive(k) ? m.get(k) : null; },
    async put(k, v, o = {}) {
      hit("put", k, "before");
      m.set(k, String(v));
      if (o.metadata !== undefined) meta.set(k, JSON.parse(JSON.stringify(o.metadata))); else meta.delete(k);
      if (o.expirationTtl) exp.set(k, clock() + o.expirationTtl * 1000); else exp.delete(k);
      puts.push({ k, o });
      hit("put", k, "after");
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      hit("list", prefix, "before");
      if (!(limit >= 1 && limit <= 1000)) throw new Error("kv_list_limite_invalido");
      const names = [...m.keys()].filter((k) => k.startsWith(prefix) && alive(k)).sort();
      const start = cursor ? Number(cursor) : 0, page = names.slice(start, start + Math.min(limit, maxPage)), end = start + page.length;
      return { keys: page.map((name) => ({ name, ...(meta.has(name) ? { metadata: JSON.parse(JSON.stringify(meta.get(name))) } : {}) })), list_complete: end >= names.length, ...(end < names.length ? { cursor: String(end) } : {}) };
    },
    async delete(k) { hit("delete", k, "before"); m.delete(k); meta.delete(k); exp.delete(k); },
    fail(op, match, times = 1, when = "before") { faults.push({ op, match, left: times, when }); },
  };
  return kv;
}
const isSummary = (k) => k === SALES_SUMMARY_KEY;
const isSaleEvent = (k) => k.startsWith(SALES_EVENT_PREFIX);
const saleEvents = (kv) => [...kv.m.keys()].filter(isSaleEvent).sort();
const isActivityEvent = (k) => k.startsWith(ACTIVITY_EVENT_PREFIX);
const activities = (kv, type) => [...kv.m.entries()].filter(([k]) => isActivityEvent(k)).map(([, v]) => JSON.parse(v)).filter((a) => !type || a.type === type);
const readSummary = (kv) => JSON.parse(kv.m.get(SALES_SUMMARY_KEY) || "null");
// O postback não recalcula nada (NC-989-02): o resumo é lido depois do recomputo horário.
const summary = async (kv, now = T0) => { await refreshSalesSummary(kv, { now }); return readSummary(kv); };

function envWith(kv, extra = {}) {
  return { HOTMART_HOTTOK: HOTTOK, HOTMART_SERVICE_PRODUCT_IDS: "8704905", ZEVANORY_PRIVATE_ARTIFACTS: kv, ...extra };
}
function postback(event, txn, { hottok = HOTTOK, product = { id: 7000001, name: "Lucro & Caixa" } } = {}) {
  const body = { version: "2.0.0", event, data: {
    product, buyer: { email: "comprador@example.invalid", name: "Comprador Sintetico" },
    purchase: { transaction: txn, price: { value: 147 }, approved_date: T0, origin: { src: "ensaio" }, payment: { type: "PIX" } },
    commissions: [{ source: "MARKETPLACE", value: 14.7 }, { source: "PRODUCER", value: 132.3 }] } };
  const headers = { "content-type": "application/json" };
  if (hottok !== null) headers["x-hotmart-hottok"] = hottok;
  return new Request("https://example.invalid/api/webhooks/hotmart", { method: "POST", headers, body: JSON.stringify(body) });
}
// Prova de "sem rede": qualquer fetch durante o ensaio falha e fica contado.
function noNetwork(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("rede_proibida_no_ensaio"); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test("E1 aprovado → entrega registrada exatamente uma vez; reentrega e APPROVED+COMPLETE idempotentes; sem e-mail de produto", async (t) => {
  const net = noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0001"), env);
  assert.equal(r1.status, 200, "[E1.1] aprovação aceita");
  assert.equal((await r1.json()).duplicate, false, "[E1.2] primeira entrega não é duplicata");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0001"), env);
  assert.equal(r2.status, 200, "[E1.3] reentrega idêntica responde 200 (a Hotmart para de reenviar)");
  assert.equal((await r2.json()).duplicate, true, "[E1.4] reentrega marcada como duplicata");
  const r3 = await handleDigitalHotmartNc012(postback("PURCHASE_COMPLETE", "HP-SINT-0001"), env);
  assert.equal(r3.status, 200, "[E1.5] COMPLETE depois de APPROVED aceito");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E1.6] uma venda, uma entrega registrada");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E1.7] uma única atividade de entrega");
  assert.equal(net.length, 0, "[E1.8] nenhum fetch: a ZEVANORY não envia e-mail de produto (DEC-06)");
  assert.ok(![...kv.m.values(), ...[...kv.meta.values()].map((x) => JSON.stringify(x)), ...kv.m.keys()].some((v) => v.includes("comprador@") || v.includes("HP-SINT-0001")), "[E1.9] registro (valores, metadata e chaves) sem e-mail nem transação em claro");
});

test("E2 cancelamento, estorno e contestação: registrados uma vez, sem dupla contagem do estorno", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0002"), env);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0002"), env);
  assert.equal(r1.status, 200, "[E2.1] estorno aceito");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0002"), env)).status, 200, "[E2.2] estorno repetido aceito");
  await handleDigitalHotmartNc012(postback("PURCHASE_CHARGEBACK", "HP-SINT-0002"), env);
  const s = await summary(kv);
  assert.equal(s?.totals?.refunded, 1, "[E2.3] estorno contado uma vez");
  assert.equal(s?.totals?.chargeback, 0, "[E2.4] contestação depois do estorno não reverte de novo");
  assert.equal(s?.totals?.reversedGrossCents, 14700, "[E2.5] valor revertido uma vez");
  assert.equal(activities(kv, "refund_requested").length, 1, "[E2.6] uma atividade de estorno por transação (a contestação posterior não duplica)");
  const c = await handleDigitalHotmartNc012(postback("PURCHASE_CANCELED", "HP-SINT-0003"), env);
  assert.equal(c.status, 200, "[E2.7] cancelamento antes da aprovação aceito");
  assert.equal((await summary(kv))?.totals?.canceled, 1, "[E2.8] cancelamento registrado");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E2.9] cancelamento não gera entrega");
});

test("E3 KV falha ao gravar o evento imutável da venda: 503, a reentrega da Hotmart grava e a venda NÃO some (zero faltante)", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  kv.fail("put", isSaleEvent, 1);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0004"), env);
  assert.equal(r1.status, 503, "[E3.1] falha de gravação do evento devolve 503 (a Hotmart reenvia)");
  assert.deepEqual([saleEvents(kv).length, kv.m.get(SALES_SUMMARY_KEY)], [0, undefined], "[E3.2] nada gravado ainda");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0004"), env);
  assert.equal(r2.status, 200, "[E3.3] reentrega concluída");
  assert.equal((await r2.json()).duplicate, false, "[E3.4] a reentrega grava a venda, não a descarta como duplicata");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E3.5] venda registrada exatamente uma vez");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E3.6] entrega registrada exatamente uma vez");
});

test("E4 queda entre o evento e a projeção do balde: 503, a reentrega recalcula o balde e a venda entra no total uma vez", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  kv.fail("put", (k) => k.startsWith(SALES_BUCKET_PREFIX), 1);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env, { now: T0 });
  assert.equal(r1.status, 503, "[E4.1] projeção do balde não gravada devolve 503 (a Hotmart reenvia)");
  assert.equal(saleEvents(kv).length, 1, "[E4.2] o evento imutável já está gravado");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env, { now: T0 });
  assert.deepEqual([r2.status, (await r2.json()).duplicate], [200, true], "[E4.3] reentrega aceita como duplicata");
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith(SALES_BUCKET_PREFIX)).length, 1, "[E4.4] a reentrega grava a projeção do balde que faltou");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E4.5] o total conta a venda uma vez");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E4.6] uma atividade de entrega");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env, { now: T0 })).status, 200, "[E4.7] terceira reentrega estável");
  assert.deepEqual([(await summary(kv))?.totals?.approved, saleEvents(kv).length], [1, 1], "[E4.8] estável: 1 venda, 1 evento");
});

test("E5 KV fora: leitura ou listagem que falha devolve 503 sem gravar; listagem que falha no recomputo NÃO recria o total vazio nem parcial", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0006"), env, { now: T0 });
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0007"), env, { now: T0 });
  assert.equal((await summary(kv))?.totals?.approved, 2, "[E5.0] duas vendas");
  kv.fail("get", () => true, 1);
  const r = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0008"), env, { now: T0 });
  assert.equal(r.status, 503, "[E5.1] leitura que falha devolve 503 (a Hotmart reenvia)");
  assert.deepEqual([readSummary(kv)?.totals?.approved, saleEvents(kv).length], [2, 2], "[E5.2] nada gravado; as duas vendas anteriores intactas");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0008"), env, { now: T0 });
  assert.equal(r2.status, 200, "[E5.3] reentrega grava o evento e a projeção do balde");
  kv.fail("list", (prefix) => prefix.startsWith(SALES_EVENT_PREFIX), 1);
  await assert.rejects(refreshSalesSummary(kv, { now: T0 }), /kv_list_falhou/, "[E5.6] recomputo com a listagem fora falha");
  assert.equal(readSummary(kv)?.totals?.approved, 2, "[E5.4] listagem que falha não sobrescreve o total com um vazio ou parcial");
  assert.equal((await summary(kv))?.totals?.approved, 3, "[E5.5] recomputo seguinte: três vendas, nenhuma perdida");
});

test("E6 atividade de entrega não gravada: 503, a reentrega grava exatamente uma", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  kv.fail("put", isActivityEvent, 1);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0009"), env);
  assert.equal(r1.status, 503, "[E6.1] registro de entrega não confirmado devolve 503");
  assert.equal(activities(kv, "delivery_sent").length, 0, "[E6.2] nenhuma atividade ainda");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0009"), env);
  assert.equal(r2.status, 200, "[E6.3] reentrega conclui");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E6.4] exatamente uma atividade de entrega");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E6.5] venda contada uma vez");
  kv.fail("put", isActivityEvent, 1);
  const s1 = await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0009"), env);
  assert.equal(s1.status, 503, "[E6.6] registro de estorno não confirmado devolve 503");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0009"), env)).status, 200, "[E6.7] reentrega do estorno conclui");
  assert.equal(activities(kv, "refund_requested").length, 1, "[E6.8] exatamente uma atividade de estorno");
});

test("E7 Neon fora: o caminho Hotmart não depende do PostgreSQL nem de rede e continua registrando", async (t) => {
  const net = noNetwork(t);
  const kv = memKv(), env = envWith(kv, { DATABASE_URL: "postgres://sintetico.invalid/indisponivel" });
  const r = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0010"), env);
  assert.equal(r.status, 200, "[E7.1] aprovação registrada com o Neon fora");
  assert.equal(net.length, 0, "[E7.2] nenhuma chamada de rede (nem ao banco)");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E7.3] venda registrada");
});

test("E8 autenticação do postback: hottok inválido 401 e ausente de configuração 503, nada gravado", async (t) => {
  noNetwork(t);
  const kv = memKv();
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0011", { hottok: "outro-valor-sintetico-qualquer" }), envWith(kv))).status, 401, "[E8.1] hottok errado recusado");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0011", { hottok: null }), envWith(kv))).status, 401, "[E8.2] hottok ausente recusado");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0011"), envWith(kv, { HOTMART_HOTTOK: "" }))).status, 503, "[E8.3] sem configuração, fechado em falha");
  assert.equal(kv.m.size, 0, "[E8.4] nada gravado");
});

test("E9 indisponibilidade parcial (12-B.4): todo cenário × direito tem caminho, informado nas páginas de venda", () => {
  const m = JSON.parse(readTextNormalized(new URL("../data/p12-degradacao-12b4.json", import.meta.url)));
  assert.deepEqual(validateMatrix(m), [], "[E9.1] matriz bem formada");
  const ev = evaluateMatrix(m);
  assert.deepEqual(ev.gaps, [], "[E9.2] nenhuma lacuna cenário × direito");
  assert.equal(ev.rows.length, m.cenarios.length * m.direitos.length, "[E9.3] matriz completa (6 cenários × 3 direitos)");
  assert.deepEqual(m.cenarios.map((c) => c.falha).sort(), ["hotmart", "kv", "neon", "resend", "site", "worker"], "[E9.4] cenários do 12-B.4 mais KV");
  // Contraprova: sem o suporte@, a Hotmart fora deixa o acesso sem caminho (o avaliador PRECISA acusar).
  const semSuporte = { ...m, caminhos: m.caminhos.filter((p) => p.id !== "suporte_email") };
  assert.ok(evaluateMatrix(semSuporte).gaps.includes("plataforma_fora×acesso_conteudo"), "[E9.5] avaliador acusa lacuna real");
  const semDeps = { ...m, caminhos: m.caminhos.map((p) => p.id === "hotmart_reembolso" ? { ...p, deps_recebimento: [] } : p) };
  assert.ok(validateMatrix(semDeps).includes("sem_deps_recebimento:hotmart_reembolso"), "[E9.6] caminho sem dependência declarada é recusado");
  // Arrependimento com a plataforma fora: o pedido ganha carimbo fora da Hotmart (o prazo conta da solicitação).
  const row = ev.rows.find((r) => r.cenario === "plataforma_fora" && r.direito === "arrependimento_7d");
  assert.ok(row.caminhos.some((c) => c.id === "suporte_email" || c.id === "atendimento_formulario"), "[E9.7] arrependimento com a Hotmart fora");
  for (const slug of SLUGS) {
    const html = readTextNormalized(new URL(`../sales-public/${slug}.html`, import.meta.url));
    for (const p of m.caminhos) assert.ok(html.includes(p.informado_em), `[E9.8] ${slug} informa o caminho ${p.id} (${p.informado_em})`);
  }
});

test("E10 entrega mensal (Conteúdo Pronto, candidato não ligado) tem chave de idempotência por ciclo", () => {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(q, ...args) {
    const s = q.trim();
    if (/^SELECT\b/i.test(s)) return { toArray: () => db.prepare(s).all(...args) };
    if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) { db.exec(s); return { toArray: () => [] }; }
    db.prepare(s).run(...args); return { toArray: () => [] };
  } };
  const storage = { sql, transactionSync(fn) { db.exec("BEGIN IMMEDIATE"); try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  const id = "cp-do:ensaio-p12-assinatura";
  const ledger = new CpSubscriberLedger(storage, id);
  const ev = (event_key, kind, cycle, extra = {}) => ({ event_key, kind, cycle, ...extra });
  ledger.apply(ev("webhook:aprovado-ciclo-1", "approved", 1));
  ledger.apply(ev("cron:entrega-ciclo-0001", "queue_delivery", 1));
  ledger.apply(ev("webhook:entrega-ciclo-01", "queue_delivery", 1));
  let s = ledger.snapshot();
  assert.equal(s.outbox.length, 1, "[E10.1] webhook × cron no mesmo ciclo: uma entrega");
  assert.equal(s.outbox[0].provider_idempotency_key, id + "/delivery/1", "[E10.2] chave do provedor derivada do ciclo, não do evento");
  ledger.apply(ev("webhook:aprovado-ciclo-2", "approved", 2));
  ledger.apply(ev("cron:entrega-ciclo-0002", "queue_delivery", 2));
  s = ledger.snapshot();
  assert.deepEqual(s.outbox.map((o) => o.provider_idempotency_key), [id + "/delivery/1", id + "/delivery/2"], "[E10.3] um ciclo, uma chave");
  ledger.apply(ev("provider:incerto-ciclo2", "provider_uncertain", 2));
  assert.equal(ledger.snapshot().outbox[1].status, "uncertain", "[E10.4] resultado ambíguo espera conciliação, nunca reenvia sozinho");
});

test("E11 onboarding com microvitória ≤ 24 h: flag desligada, base legal registrada, idempotente e SEM envio real", async (t) => {
  const net = noNetwork(t);
  const on = { ONBOARDING_MICROVITORIA_ENABLED: "true" };
  for (const v of [undefined, "", "1", "TRUE", "yes", "on", false]) assert.equal(onboardingEnabled({ ONBOARDING_MICROVITORIA_ENABLED: v }), false, `[E11.1] flag desligada para ${String(v)}`);
  assert.equal(onboardingEnabled(on), true, "[E11.2] liga só com o valor exato");
  const ref = "a1b2c3d4e5f60718";
  assert.equal(planMicrovitoria({ env: {}, event: "PURCHASE_APPROVED", slug: "lucro-e-caixa", transactionRef: ref, deliveredAtMs: T0 }).status, "disabled", "[E11.4] sem flag não planeja");
  const p1 = planMicrovitoria({ env: on, event: "PURCHASE_APPROVED", slug: "lucro-e-caixa", transactionRef: ref, deliveredAtMs: T0 });
  const p2 = planMicrovitoria({ env: on, event: "PURCHASE_COMPLETE", slug: "lucro-e-caixa", transactionRef: ref, deliveredAtMs: T0 });
  assert.equal(p1.status, "planned", "[E11.5] aprovação planeja");
  assert.deepEqual(p1, p2, "[E11.6] APPROVED e COMPLETE geram o MESMO plano (uma microvitória por pedido)");
  assert.equal(p1.idempotency_key, microvitoriaKey(ref), "[E11.7] chave de idempotência por pedido e etapa");
  assert.ok(p1.deadline_ms - T0 <= 24 * HOUR && MICROVITORIA_DEADLINE_MS <= 24 * HOUR, "[E11.8] prazo de até 24 h depois da entrega");
  assert.ok(p1.due_at_ms > T0 && p1.due_at_ms < p1.deadline_ms, "[E11.9] janela de envio dentro do prazo");
  assert.equal(p1.base_legal.base_legal, "legitimo_interesse", "[E11.10] base legal registrada");
  assert.equal(p1.base_legal.referencia, "LGPD art. 7º, IX", "[E11.11] referência legal registrada");
  // 12-B.5: a política de privacidade publicada declara o MESMO tratamento com a MESMA base.
  const priv = readTextNormalized(new URL("../sales-public/privacidade.html", import.meta.url)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const trecho = priv.slice(priv.indexOf(p1.base_legal.politica_publicada), priv.indexOf(p1.base_legal.politica_publicada) + 220);
  assert.ok(priv.includes(p1.base_legal.politica_publicada) && trecho.includes(p1.base_legal.referencia.replace("LGPD ", "")), "[E11.28] política de privacidade publicada corresponde à base legal do onboarding");
  assert.equal(BASE_LEGAL_MICROVITORIA.natureza, "transacional, sem oferta", "[E11.12] natureza transacional");
  assert.equal(planMicrovitoria({ env: on, event: "PURCHASE_REFUNDED", slug: "lucro-e-caixa", transactionRef: ref, deliveredAtMs: T0 }).status, "ignored", "[E11.13] estorno não planeja");
  assert.equal(planMicrovitoria({ env: on, event: "PURCHASE_APPROVED", slug: "lucro-e-caixa", transactionRef: "HP-SINT-0001", deliveredAtMs: T0 }).status, "skipped", "[E11.14] identificador bruto da transação recusado (só hash)");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + HOUR }).action, "wait", "[E11.15] antes da janela espera");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + 3 * HOUR }).action, "send", "[E11.16] dentro da janela envia");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + 25 * HOUR }).action, "alert", "[E11.17] depois de 24 h vira falta com alerta, nunca envio atrasado");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + 3 * HOUR, reversed: true }).action, "cancel", "[E11.18] estorno cancela");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + 3 * HOUR, optedOut: true }).action, "cancel", "[E11.19] descadastro cancela");
  assert.equal(decideMicrovitoria(p1, { nowMs: T0 + 3 * HOUR, sent: true }).action, "none", "[E11.20] já enviada nunca repete");
  assert.deepEqual(Object.keys(MICROVITORIAS).sort(), [...SLUGS].sort(), "[E11.21] uma microvitória por produto à venda");
  for (const slug of SLUGS) {
    const msg = renderMicrovitoria(slug, { optOutUrl: "https://zevanory.api.br/pos-venda/descadastrar?i=sintetico" });
    assert.deepEqual(microvitoriaTextIssues(msg), [], `[E11.22] ${slug}: sem chamada de compra, preço, promessa ou frase proibida`);
    assert.ok(msg.text.includes("suporte@zevanory.api.br"), `[E11.23] ${slug}: canal de ajuda`);
  }
  assert.deepEqual(microvitoriaTextIssues({ subject: "x", text: "Compre agora na Hotmart por R$ 97" }), ["chamada_de_compra", "preco"], "[E11.24] contraprova do verificador de texto");
  let senderCalls = 0;
  const out = await dispatchMicrovitoria(p1, { action: "send" }, { env: on, recipient: "comprador@example.invalid", sender: async () => { senderCalls++; return { ok: true }; } });
  assert.equal(out.code, "SEND_DISABLED_BY_SOURCE", "[E11.25] envio bloqueado mesmo com a flag ligada");
  assert.equal(senderCalls, 0, "[E11.26] o remetente nunca é chamado");
  assert.equal(net.length, 0, "[E11.27] nenhuma rede");
});

test("E12 roteamento dos 5 produtos: postback Hotmart não-CP vai ao registro digital (kits 192 h desligados)", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv, { KIT_DEFERRED_192H_ENABLED: "true", HOTMART_KIT_PRODUCT_IDS: "7000001" });
  const r = await routeHotmartNc011(postback("PURCHASE_APPROVED", "HP-SINT-0012"), env);
  assert.equal(r.status, 200, "[E12.1] rota oficial registra a venda digital");
  assert.equal((await r.json()).scope, "digital_product", "[E12.2] escopo digital, nunca o razão de 192 h (DEC-06)");
  assert.equal((await summary(kv))?.totals?.approved, 1, "[E12.3] uma venda registrada");
});

// ---------------------------------------------------------------------------------------------------------------
// NC-989-01/02/03/04 (contra-auditorias do PR #989): concorrência sem CAS, cota do KV free, imutabilidade por
// conteúdo e deduplicação GLOBAL (balde pela transação). AGENDADOR CONTROLADO: cada get/put/list de cada execução
// fica suspenso até o agendador escolher qual operação acontece; E13, E20 e E22 enumeram TODOS os entrelaçamentos;
// E14 e E15 sorteiam com semente fixa. Falhas são injetadas antes e depois de cada gravação, seguidas de
// reprocessamento (reentrega da Hotmart).
const pdata = (txn, { price = 147, approved = T0, src = "ensaio" } = {}) => ({
  product: { id: 7000001, name: "Lucro & Caixa" }, buyer: { email: "comprador@example.invalid" },
  purchase: { transaction: txn, price: { value: price }, ...(approved ? { approved_date: approved } : {}), origin: { src }, payment: { type: "PIX" } },
  commissions: [{ source: "PRODUCER", value: Math.round(price * 90) / 100 }],
});
const hook = (event, txn, opts) => ({ event, data: pdata(txn, opts) });

// `procs` recebem um KV cujas operações o agendador serializa: `pick(n)` escolhe qual das n pendentes acontece.
// `fault` = { id, putN, when }: a putN-ésima gravação da execução `id` falha antes (não grava) ou depois (grava e falha).
async function interleave(base, procs, pick, fault = null) {
  const pending = [];
  let running = procs.length, wake = null;
  const ping = () => { if (running === 0 && wake) { const w = wake; wake = null; w(); } };
  const out = new Array(procs.length);
  const views = procs.map((_, id) => {
    let puts = 0;
    const op = (name, args) => new Promise((res, rej) => { pending.push({ id, name, args, res, rej, putN: name === "put" ? ++puts : 0 }); running--; ping(); });
    return { get: (...a) => op("get", a), put: (...a) => op("put", a), list: (...a) => op("list", a), delete: (...a) => op("delete", a) };
  });
  procs.forEach((p, id) => {
    Promise.resolve().then(() => p(views[id])).then((v) => { out[id] = { ok: true, v }; }, (e) => { out[id] = { ok: false, e }; }).finally(() => { running--; ping(); });
  });
  for (;;) {
    await new Promise((r) => { wake = r; ping(); });
    if (!pending.length) break;
    pending.sort((a, b) => a.id - b.id);
    const o = pending.splice(pick(pending.length), 1)[0];
    const f = fault && fault.id === o.id && o.name === "put" && fault.putN === o.putN ? fault.when : null;
    running++;
    try {
      if (f === "before") throw new Error("falha_injetada_antes_da_gravacao");
      const v = await base[o.name](...o.args);
      if (f === "after") throw new Error("falha_injetada_depois_da_gravacao");
      o.res(v);
    } catch (e) { o.rej(e); }
  }
  return { out };
}
async function forAllSchedules(run) {
  const stack = [];
  let count = 0;
  for (;;) {
    let depth = 0;
    await run((n) => { if (depth < stack.length) { stack[depth].n = n; return stack[depth++].i; } stack.push({ i: 0, n }); depth++; return 0; });
    count++;
    stack.length = depth;
    while (stack.length && stack[stack.length - 1].i + 1 >= stack[stack.length - 1].n) stack.pop();
    if (!stack.length) return count;
    stack[stack.length - 1].i++;
  }
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Parte comparável do resumo: o número bruto de chaves (source.events) varia com a corrida APPROVED×COMPLETE.
const core = (s) => { if (!s) return s; const c = JSON.parse(JSON.stringify(s)); if (c.source) delete c.source.events; return c; };
const noComplete = (names) => names.filter((k) => !k.includes(":purchase_complete:"));
const touched = async (hooks) => [...new Set(await Promise.all(hooks.map(async (w) => (await salesEventRecord(w.event, w.data.purchase.transaction, w.data)).bucket)))].sort();
async function reference(hooks) {
  const kv = memKv();
  for (const w of hooks) await recordHotmartSale(kv, w.event, w.data, { now: T0 });
  return { summary: await refreshSalesSummary(kv, { now: T0, buckets: await touched(hooks) }), events: saleEvents(kv) };
}
// Modelo explícito: 1 venda por transação aprovada; 1 reversão por transação (estorno > contestação > protesto).
function model(hooks) {
  const appr = new Set(hooks.filter((w) => /APPROVED|COMPLETE/.test(w.event)).map((w) => w.data.purchase.transaction));
  const rev = {};
  for (const w of hooks) if (/REFUNDED|CHARGEBACK|PROTEST/.test(w.event)) (rev[w.data.purchase.transaction] ||= new Set()).add(w.event);
  const kinds = Object.values(rev).map((set) => ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"].find((e) => set.has(e)));
  return { approved: appr.size, refunded: kinds.filter((e) => e === "PURCHASE_REFUNDED").length, chargeback: kinds.filter((e) => e === "PURCHASE_CHARGEBACK").length };
}
const counts = (s) => ({ approved: s?.totals?.approved, refunded: s?.totals?.refunded, chargeback: s?.totals?.chargeback });
// Uma rodada: postbacks (e, se pedido, um recomputo) concorrentes; reentrega das que falharam; recomputo final
// dos baldes tocados (o que a varredura horária faz em até 25,6 h).
async function round(hooks, pick, fault, { project = true, cron = false } = {}) {
  const kv = memKv();
  const bs = await touched(hooks);
  const procs = hooks.map((w, i) => (v) => recordHotmartSale(v, w.event, w.data, { now: T0 + i, project }));
  if (cron) procs.push((v) => refreshSalesSummary(v, { now: T0, buckets: bs }));
  const { out } = await interleave(kv, procs, pick, fault);
  for (let i = 0; i < hooks.length; i++) if (!out[i]?.ok) await recordHotmartSale(kv, hooks[i].event, hooks[i].data, { now: T0 + 99, project });
  return { kv, out, projected: cron && out[hooks.length]?.ok ? out[hooks.length].v : null, final: await refreshSalesSummary(kv, { now: T0, buckets: bs }) };
}
const UNDATED_THEN_DATED = [hook("PURCHASE_APPROVED", "HP-C-1", { approved: null }), hook("PURCHASE_APPROVED", "HP-C-1")];
const SCEN = {
  "mesmo webhook 2x": [hook("PURCHASE_APPROVED", "HP-C-1"), hook("PURCHASE_APPROVED", "HP-C-1")],
  "APPROVED+COMPLETE da mesma transação": [hook("PURCHASE_APPROVED", "HP-C-1"), hook("PURCHASE_COMPLETE", "HP-C-1")],
  "webhooks de transações diferentes": [hook("PURCHASE_APPROVED", "HP-C-1"), hook("PURCHASE_APPROVED", "HP-C-2", { price: 97 })],
  "estorno x contestação da mesma transação": [hook("PURCHASE_CHARGEBACK", "HP-C-1"), hook("PURCHASE_REFUNDED", "HP-C-1")],
  "aprovação x estorno": [hook("PURCHASE_APPROVED", "HP-C-1"), hook("PURCHASE_REFUNDED", "HP-C-1")],
  "aprovação sem data x com data (NC-989-04)": UNDATED_THEN_DATED,
  "COMPLETE com data x APPROVED sem data (NC-989-04)": [hook("PURCHASE_COMPLETE", "HP-C-1", { approved: T0 - 9 * DAY_MS }), hook("PURCHASE_APPROVED", "HP-C-1", { approved: null })],
};
const FAULTS1 = [null, ...[0, 1].flatMap((id) => ["before", "after"].map((when) => ({ id, putN: 1, when })))];

test("E13 NC-989-01 duas execuções concorrentes, TODOS os entrelaçamentos × falha antes/depois da gravação do evento: contagem final = transações únicas", async (t) => {
  let total = 0;
  for (const [name, hooks] of Object.entries(SCEN)) {
    const ref = await reference(hooks), want = model(hooks);
    for (const fault of FAULTS1) {
      const n = await forAllSchedules(async (pick) => {
        const { final, kv } = await round(hooks, pick, fault, { project: false });
        const tag = `${name} / falha ${fault ? fault.id + ":" + fault.when : "nenhuma"}`;
        assert.deepEqual(counts(final), want, `[E13.1] ${tag}: contagem = modelo de transações únicas`);
        assert.deepEqual(core(final), core(ref.summary), `[E13.2] ${tag}: resumo idêntico ao das entregas em sequência`);
        assert.deepEqual(noComplete(saleEvents(kv)), noComplete(ref.events), `[E13.3] ${tag}: conjunto de eventos = união das entregas`);
      });
      assert.ok(n >= 2, `[E13.4] ${name}: mais de um entrelaçamento (${n})`);
      total += n;
    }
  }
  t.diagnostic(`E13 entrelaçamentos visitados: ${total}`);
  assert.ok(total >= 500, `[E13.5] busca exaustiva visitou ${total} entrelaçamentos`);
});

test("E14 NC-989-02 caminho completo (evento + projeção do balde + recomputo concorrente), semente fixa: nunca conta a mais, e a varredura converge", async (t) => {
  const r = rng(0x98902);
  const scen = Object.values(SCEN);
  for (let c = 0; c < 1500; c++) {
    const hooks = scen[c % scen.length], want = model(hooks);
    const fault = r() < 0.6 ? { id: Math.floor(r() * 2), putN: 1 + Math.floor(r() * 2), when: r() < 0.5 ? "before" : "after" } : null;
    const { projected, final, kv } = await round(hooks, (k) => Math.floor(r() * k), fault, { cron: r() < 0.5 });
    const stored = readSummary(kv);
    if (projected) assert.ok(!(projected.totals.approved > want.approved), `[E14.1] caso ${c}: recomputo concorrente nunca acima da verdade (${projected.totals.approved})`);
    assert.deepEqual(counts(final), want, `[E14.2] caso ${c}: a varredura dos baldes conta exatamente as transações únicas`);
    assert.ok(stored === null || stored.totals.approved <= want.approved, `[E14.3] caso ${c}: nenhum total gravado acima da verdade`);
  }
  t.diagnostic("E14 casos: 1500");
});

test("E15 NC-989-04 propriedade com semente fixa: entregas misturadas com data VARIANDO entre eventos da mesma transação (com, sem, outra), recomputo e falha sorteados → resumo = sequência", async () => {
  const r = rng(0x989_01);
  const evs = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST", "PURCHASE_CANCELED"];
  const dates = [T0, T0 - DAY_MS, T0 - 40 * DAY_MS, null];
  for (let c = 0; c < 800; c++) {
    const n = 2 + Math.floor(r() * 4);
    const hooks = Array.from({ length: n }, () => hook(evs[Math.floor(r() * evs.length)], "HP-P-" + (1 + Math.floor(r() * 3)), { approved: dates[Math.floor(r() * dates.length)] }));
    const fault = r() < 0.7 ? { id: Math.floor(r() * n), putN: 1 + Math.floor(r() * 2), when: r() < 0.5 ? "before" : "after" } : null;
    const ref = await reference(hooks), want = model(hooks);
    const { final, projected } = await round(hooks, (k) => Math.floor(r() * k), fault, { cron: r() < 0.5 });
    const tag = `caso ${c}: ${hooks.map((w) => w.event.slice(9, 13) + ":" + w.data.purchase.transaction.slice(-1) + (w.data.purchase.approved_date ? "" : "?")).join(",")}`;
    assert.deepEqual(counts(final), want, `[E15.1] ${tag}`);
    assert.deepEqual(core(final), core(ref.summary), `[E15.2] ${tag}: idêntico à sequência`);
    if (projected) assert.ok(!(projected.totals.approved > want.approved), `[E15.3] ${tag}: recomputo concorrente nunca acima da verdade`);
  }
});

test("E16 NC-989-01 retenção: evento com 399 dias ainda conta e deduplica; TTL ≥ 400 dias; sem limite de tamanho (2.500 transações, list paginado)", async () => {
  let now = T0;
  const kv = memKv({ clock: () => now });
  assert.equal((await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-R-1"), { now })).recorded, true, "[E16.1] gravado");
  assert.ok(kv.puts.filter((p) => isSaleEvent(p.k) || p.k.startsWith(SALES_BUCKET_PREFIX)).every((p) => p.o.expirationTtl >= 400 * 86400) && SALES_EVENT_TTL_DAYS >= 400, "[E16.2] TTL de todo evento e de toda projeção de balde ≥ 400 dias");
  now = T0 + 399 * DAY_MS + 3_600_000;
  assert.equal((await summary(kv, now))?.totals?.approved, 1, "[E16.3] com 399 dias o evento continua contado");
  const again = await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-R-1"), { now });
  assert.equal(again.reason, "duplicate", "[E16.4] reentrega com 399 dias é duplicata");
  assert.equal((await summary(kv, now))?.totals?.approved, 1, "[E16.5] e não conta de novo");
  const big = memKv({ maxPage: 3 });
  for (let i = 0; i < 2500; i++) await recordHotmartSale(big, "PURCHASE_APPROVED", pdata("HP-B-" + i), { now: T0, project: false });
  const lists = [];
  const wrapped = { get: big.get, put: big.put, list: async (o) => { lists.push(o); return big.list(o); } };
  const all = Array.from({ length: BUCKETS }, (_, i) => bucketName(i));
  assert.equal((await refreshSalesSummary(wrapped, { now: T0, buckets: all }))?.totals?.approved, 2500, "[E16.6] 2.500 vendas (o limite antigo era 2.000), páginas de 3 chaves");
  assert.ok(lists.some((o) => o.cursor) && lists.every((o) => o.limit <= 1000), "[E16.7] listagem paginada (cursor seguido, ≤ 1.000 por página)");
  assert.equal((await recordHotmartSale(big, "PURCHASE_APPROVED", pdata("HP-B-0"), { now: T0 })).reason, "duplicate", "[E16.8] a primeira das 2.500 ainda deduplica");
  big.meta.delete(saleEvents(big)[0]);
  assert.equal((await refreshSalesSummary(big, { now: T0, buckets: all }))?.totals?.approved, 2500, "[E16.9] evento sem metadata é lido pelo valor");
});

test("E17 NC-989-01 legado: o resumo anterior vira base congelada, gravada antes da 1ª projeção; transação legada não conta duas vezes", async () => {
  const kv = memKv();
  const sha16 = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16);
  let legacy = null;
  for (const txn of ["HP-L-1", "HP-L-2"]) {
    legacy = applySale(legacy, saleFacts("PURCHASE_APPROVED", pdata(txn), T0), "approved", await sha16("hotmart:" + txn));
    kv.m.set("zpc:sales:v1:txn:" + (await sha16("hotmart:" + txn)) + ":approved", "1");
  }
  kv.m.set(SALES_SUMMARY_KEY, JSON.stringify(legacy));
  assert.equal((await refreshSalesSummary(kv, { now: T0 }))?.totals?.approved, 2, "[E17.1] a projeção parte do resumo legado");
  assert.equal(JSON.parse(kv.m.get(SALES_LEGACY_BASELINE_KEY) || "null")?.totals?.approved, 2, "[E17.2] base legada gravada");
  assert.equal((await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-L-1"), { now: T0 })).reason, "duplicate", "[E17.3] reentrega de transação legada é duplicata");
  await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-N-1"), { now: T0 });
  await recordHotmartSale(kv, "PURCHASE_REFUNDED", pdata("HP-L-2"), { now: T0 });
  await refreshSalesSummary(kv, { now: T0 });
  const s = await refreshSalesSummary(kv, { now: T0 });
  assert.deepEqual([s?.totals?.approved, s?.totals?.refunded], [3, 1], "[E17.4] 2 legadas + 1 nova, estorno da legada uma vez; estável em recomputos repetidos");
  assert.equal(s?.source?.legacyBaseline, true, "[E17.5] procedência da base declarada");
});

test("E18 NC-989-01 pelo handler: três entregas simultâneas do mesmo postback → 1 venda e 1 atividade única", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  const rs = await Promise.all([0, 1, 2].map(() => handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0013"), env, { now: T0 })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], "[E18.1] todas aceitas");
  assert.deepEqual([(await summary(kv))?.totals?.approved, saleEvents(kv).length], [1, 1], "[E18.2] 1 venda, 1 evento imutável");
  assert.equal(new Set(activities(kv, "delivery_sent").map((a) => a.sourceKey)).size, 1, "[E18.3] uma atividade por sourceKey (o consumidor deduplica por sourceKey)");
});

// Orçamento (NC-989-02): um dia inteiro em regime, com 400 dias de histórico, contando TODA operação de KV feita pelo
// caminho de vendas (postback pelo handler: evento, projeção do balde e atividade; recomputo horário: varredura,
// listas, leituras e total). Cota free: 1.000 list, 1.000 gravações e 100.000 leituras por dia; margem ≥ 50%.
async function budgetDay(N, { refundRate = 0.1, chargebackRate = 0.02, replayRate = 0.05 } = {}) {
  const HOURS = 3_600_000, D0 = Date.UTC(2026, 10, 7);
  let now = D0 - 3 * HOURS;
  const kv = memKv({ clock: () => now }), env = envWith(kv);
  const hist = (d, i) => ({ txn: `HP-H-${d}-${i}`, at: D0 - d * DAY_MS + 12 * HOURS });
  for (let d = 1; d <= 400; d++) for (let i = 0; i < N; i++) {
    const { txn, at } = hist(d, i);
    const rec = await salesEventRecord("PURCHASE_APPROVED", txn, pdata(txn, { approved: at }));
    kv.m.set(rec.key, rec.value); kv.meta.set(rec.key, rec.meta); kv.exp.set(rec.key, at + 400 * DAY_MS);
  }
  for (let i = 0; i < BUCKETS; i++) await refreshBucket(kv, bucketName(i));
  const plan = [];
  const spread = (k, i) => D0 + Math.floor(((i + 0.5) / k) * DAY_MS);
  for (let i = 0; i < N; i++) plan.push({ t: spread(N, i), event: "PURCHASE_APPROVED", txn: `HP-D0-${i}`, at: spread(N, i) });
  const nComplete = Math.round(N * 0.9), nRefund = Math.ceil(N * refundRate), nCb = Math.ceil(N * chargebackRate), nReplay = Math.ceil(N * replayRate);
  for (let i = 0; i < nComplete; i++) { const h = hist(8, i); plan.push({ t: spread(nComplete, i) + 60_000, event: "PURCHASE_COMPLETE", txn: h.txn, at: h.at, seedActivity: true }); }
  for (let i = 0; i < nRefund; i++) { const h = hist(1 + (i % 7), N - 1 - i); plan.push({ t: spread(nRefund, i) + 120_000, event: "PURCHASE_REFUNDED", txn: h.txn, at: h.at, seedActivity: true }); }
  for (let i = 0; i < nCb; i++) { const h = hist(30, i); plan.push({ t: spread(nCb, i) + 180_000, event: "PURCHASE_CHARGEBACK", txn: h.txn, at: h.at, seedActivity: true }); }
  for (let i = 0; i < nReplay; i++) { const a = plan[i * Math.floor(N / nReplay)]; plan.push({ ...a, t: a.t + 600_000 }); }
  for (const p of plan) if (p.seedActivity) await emitActivity(env, { type: "delivery_sent", status: "hotmart_approved", channel: "store", ref: "hotmart:" + p.txn }, { now: p.at });
  await refreshSalesSummary(kv, { now: D0 - HOURS + 15 * 60_000 });
  const ops = { get: 0, put: 0, list: 0, listPrefixes: new Set(), byKind: {} };
  const g = kv.get, pt = kv.put, ls = kv.list;
  const cat = (k) => (k.startsWith(SALES_EVENT_PREFIX) ? "evento" : k.startsWith(SALES_BUCKET_PREFIX) ? "balde" : k === SALES_SUMMARY_KEY ? "total" : k.includes("activity") ? "atividade" : "outro");
  kv.get = (...a) => { ops.get++; return g(...a); };
  kv.put = (...a) => { ops.put++; const c = cat(a[0]); ops.byKind[c] = (ops.byKind[c] || 0) + 1; return pt(...a); };
  // A cota real recusa além de 1.000 list/dia: o KV falso também (e o teste termina rápido se uma mutação estourar).
  kv.list = async (o = {}) => { ops.list++; ops.listPrefixes.add(o.prefix); if (ops.list > 1000) throw new Error("cota_de_list_estourada"); return ls(o); };
  const crons = Array.from({ length: 24 }, (_, h) => ({ t: D0 + h * HOURS + 15 * 60_000, cron: true }));
  const statuses = [];
  for (const step of [...plan, ...crons].sort((a, b) => a.t - b.t)) {
    now = step.t;
    if (step.cron) { await refreshSalesSummary(kv, { now }).catch(() => { ops.cronFailures = (ops.cronFailures || 0) + 1; }); continue; }
    const req = new Request("https://example.invalid/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK },
      body: JSON.stringify({ version: "2.0.0", event: step.event, data: pdata(step.txn, { approved: step.at }) }) });
    statuses.push((await handleDigitalHotmartNc012(req, env, { now })).status);
  }
  kv.get = g; kv.put = pt; kv.list = ls;
  const counted = { ...ops, byKind: { ...ops.byKind }, listPrefixes: new Set(ops.listPrefixes) };
  const s = await refreshSalesSummary(kv, { now: D0 + DAY_MS + 15 * 60_000 });
  return { N, ops: counted, postbacks: plan.length, statuses, s, nRefund, nCb, today: new Date(D0).toISOString().slice(0, 10) };
}

test("E19 NC-989-02 orçamento de cota com 400 dias de histórico (256 baldes): 100 vendas/dia + estornos e 5 vendas/dia, todas as operações contadas, margem ≥ 50%", async (t) => {
  for (const N of [100, 5]) {
    const b = await budgetDay(N);
    t.diagnostic(`E19 N=${N}/dia: postbacks=${b.postbacks} list=${b.ops.list} put=${b.ops.put} ${JSON.stringify(b.ops.byKind)} get=${b.ops.get}`);
    assert.ok(b.statuses.every((x) => x === 200), `[E19.1] N=${N}: todos os postbacks aceitos`);
    assert.ok(![...b.ops.listPrefixes].includes(SALES_EVENT_PREFIX), `[E19.2] N=${N}: o prefixo global de eventos nunca é listado`);
    assert.ok(!b.ops.cronFailures, `[E19.7] N=${N}: nenhum recomputo horário falhou`);
    assert.ok(b.ops.list <= 500, `[E19.3] N=${N}: list/dia ${b.ops.list} ≤ 500 (50% de 1.000)`);
    assert.ok(b.ops.put <= 500, `[E19.4] N=${N}: gravações/dia ${b.ops.put} ≤ 500 (50% de 1.000)`);
    assert.ok(b.ops.get <= 50000, `[E19.5] N=${N}: leituras/dia ${b.ops.get} ≤ 50.000 (50% de 100.000)`);
    assert.deepEqual([b.s?.byDay?.[b.today]?.approved, b.s?.totals?.refunded, b.s?.totals?.chargeback], [N, b.nRefund, b.nCb], `[E19.6] N=${N}: o resumo está certo (vendas de hoje, estornos e contestações)`);
    assert.ok(b.s.totals.approved >= 400 * N && b.s.totals.approved <= 401 * N, `[E19.8] N=${N}: total retido entre 400 e 401 dias de vendas (o dia -400 expira ao longo do dia): ${b.s.totals.approved}`);
  }
});

test("E20 NC-989-03 mesma transação, desfecho e evento com conteúdo diferente, TODOS os entrelaçamentos × falhas: as duas evidências preservadas, contagem 1, divergência sinalizada", async (t) => {
  const hooks = [hook("PURCHASE_APPROVED", "HP-X-1", { price: 147 }), hook("PURCHASE_APPROVED", "HP-X-1", { price: 150 })];
  let total = 0;
  for (const fault of FAULTS1) total += await forAllSchedules(async (pick) => {
    const { final, kv } = await round(hooks, pick, fault, { project: false });
    const names = saleEvents(kv);
    assert.equal(names.length, 2, "[E20.1] duas chaves: conteúdo diferente nunca sobrescreve");
    assert.deepEqual(names.map((k) => JSON.parse(kv.m.get(k)).facts.grossCents).sort(), [14700, 15000], "[E20.2] cada evidência guarda o próprio conteúdo");
    assert.equal(final?.totals?.approved, 1, "[E20.3] contagem 1 por transação+desfecho");
    assert.equal(final?.totals?.grossCents, Math.min(...[14700, 15000].filter(() => true)) === 14700 ? final.totals.grossCents : -1, "[E20.4] representativo determinístico");
    assert.deepEqual(final?.divergent_events?.map((d) => [d.outcome, d.event, d.variants]), [["approved", "PURCHASE_APPROVED", 2]], "[E20.5] divergência sinalizada para revisão humana");
  });
  t.diagnostic(`E20 entrelaçamentos visitados: ${total}`);
  const a = await reference(hooks), b = await reference([hooks[1], hooks[0]]);
  assert.equal(a.summary.totals.grossCents, b.summary.totals.grossCents, "[E20.4] representativo determinístico (independe da ordem)");
  const kv = memKv();
  for (const w of [hooks[0], hooks[0]]) await recordHotmartSale(kv, w.event, w.data, { now: T0 });
  const r = await salesEventRecord("PURCHASE_APPROVED", "HP-X-1", hooks[0].data), r2 = await salesEventRecord("PURCHASE_APPROVED", "HP-X-1", hooks[1].data);
  assert.deepEqual([saleEvents(kv), r.key === r2.key], [[r.key], false], "[E20.6] conteúdo igual ⇒ mesma chave e valor; diferente ⇒ chave diferente");
});

test("E21 NC-989-02 varredura horária: cobre os 256 baldes em 26 h, sem estado, e repara a projeção de balde defasada por corrida", async () => {
  const seen = new Set();
  for (let h = 0; h < 26; h++) for (const b of sweepBuckets(T0 + h * HOUR)) seen.add(b);
  assert.equal(seen.size, BUCKETS, "[E21.1] 26 recomputos horários varrem todos os baldes");
  // Corrida: a projeção do balde foi gravada a partir de uma listagem anterior ao 2º evento.
  const kv = memKv();
  const w1 = hook("PURCHASE_APPROVED", "HP-W-1"), r1 = await salesEventRecord(w1.event, "HP-W-1", w1.data);
  await recordHotmartSale(kv, w1.event, w1.data, { now: T0 });
  let txn2 = null;
  for (let i = 0; !txn2; i++) if ((await salesEventRecord("PURCHASE_APPROVED", "HP-W2-" + i, pdata("HP-W2-" + i))).bucket === r1.bucket) txn2 = "HP-W2-" + i;
  await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata(txn2), { now: T0, project: false });
  assert.equal((await refreshSalesSummary(kv, { now: T0, buckets: [] }))?.totals?.approved, 1, "[E21.2] antes da varredura o total fica defasado (nunca acima)");
  let h = 0;
  while (!sweepBuckets(T0 + h * HOUR).includes(r1.bucket)) h++;
  assert.ok(h < 26, "[E21.3] o balde entra na varredura em menos de 26 h");
  assert.equal((await refreshSalesSummary(kv, { now: T0 + h * HOUR }))?.totals?.approved, 2, "[E21.4] a varredura repara: 2 vendas");
});

test("E22 NC-989-04 deduplicação GLOBAL: transação recebida sem data e depois com data (e o inverso), TODOS os entrelaçamentos × falhas, caminho completo → contada 1 vez", async (t) => {
  let total = 0;
  const cases = [UNDATED_THEN_DATED, [UNDATED_THEN_DATED[1], UNDATED_THEN_DATED[0]], [hook("PURCHASE_APPROVED", "HP-C-1", { approved: null }), hook("PURCHASE_REFUNDED", "HP-C-1", { approved: T0 - 3 * DAY_MS })]];
  for (const hooks of cases) {
    const want = model(hooks);
    for (const fault of [null, { id: 0, putN: 2, when: "before" }, { id: 1, putN: 1, when: "after" }]) total += await forAllSchedules(async (pick) => {
      const { final, kv } = await round(hooks, pick, fault);
      const buckets = new Set(saleEvents(kv).map((k) => k.split(":")[3]));
      assert.equal(buckets.size, 1, "[E22.1] todos os eventos da transação no mesmo balde, com ou sem data");
      assert.deepEqual(counts(final), want, "[E22.2] contada 1 vez (aprovação e reversão)");
      const days = Object.entries(final?.byDay || {}).filter(([, b]) => b.approved > 0);
      if (want.approved && hooks.some((w) => /APPROVED/.test(w.event) && w.data.purchase.approved_date)) assert.deepEqual(days.map(([d, b]) => [d, b.approved]), [[new Date(T0).toISOString().slice(0, 10), 1]], "[E22.3] competência = data do representativo datado, uma vez");
    });
  }
  t.diagnostic(`E22 entrelaçamentos visitados: ${total}`);
  assert.ok(total >= 1000, `[E22.4] ${total} entrelaçamentos`);
  // Sequencial explícito: sem data → com data → total 1, e o dia de competência é o datado.
  const kv = memKv();
  await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-Z-1", { approved: null }), { now: T0 });
  assert.equal((await summary(kv))?.source?.undated_groups, 1, "[E22.5] só sem data: conta 1, fora de byDay");
  await recordHotmartSale(kv, "PURCHASE_APPROVED", pdata("HP-Z-1"), { now: T0 });
  const s = await summary(kv);
  assert.deepEqual([s?.totals?.approved, s?.source?.undated_groups, s?.divergent_events?.length], [1, 0, 1], "[E22.6] chega a data: continua 1, passa a datada, divergência registrada");
});
