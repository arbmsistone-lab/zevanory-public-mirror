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
import { SALES_SUMMARY_KEY } from "../worker/sales-ledger.mjs";
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
const SLUGS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];

// KV em memória com falhas injetáveis por chamada (put/get), contando operações.
function memKv() {
  const m = new Map();
  const faults = [];
  const kv = {
    m, faults,
    async get(k) { const f = faults.find((x) => x.op === "get" && x.match(k) && x.left > 0); if (f) { f.left--; throw new Error("kv_get_falhou"); } return m.has(k) ? m.get(k) : null; },
    async put(k, v) { const f = faults.find((x) => x.op === "put" && x.match(k) && x.left > 0); if (f) { f.left--; throw new Error("kv_put_falhou"); } m.set(k, String(v)); },
    fail(op, match, times = 1) { faults.push({ op, match, left: times }); },
  };
  return kv;
}
const isSummary = (k) => k === SALES_SUMMARY_KEY;
const isTxnMark = (k) => k.startsWith("zpc:sales:v1:txn:");
const isActivityEvent = (k) => k.startsWith(ACTIVITY_EVENT_PREFIX);
const activities = (kv, type) => [...kv.m.entries()].filter(([k]) => isActivityEvent(k)).map(([, v]) => JSON.parse(v)).filter((a) => !type || a.type === type);
const summary = (kv) => JSON.parse(kv.m.get(SALES_SUMMARY_KEY) || "null");

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
  assert.equal(summary(kv).totals.approved, 1, "[E1.6] uma venda, uma entrega registrada");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E1.7] uma única atividade de entrega");
  assert.equal(net.length, 0, "[E1.8] nenhum fetch: a ZEVANORY não envia e-mail de produto (DEC-06)");
  assert.ok(![...kv.m.values()].some((v) => v.includes("comprador@") || v.includes("HP-SINT-0001")), "[E1.9] registro sem e-mail nem transação em claro");
});

test("E2 cancelamento, estorno e contestação: registrados uma vez, sem dupla contagem do estorno", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0002"), env);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0002"), env);
  assert.equal(r1.status, 200, "[E2.1] estorno aceito");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_REFUNDED", "HP-SINT-0002"), env)).status, 200, "[E2.2] estorno repetido aceito");
  await handleDigitalHotmartNc012(postback("PURCHASE_CHARGEBACK", "HP-SINT-0002"), env);
  const s = summary(kv);
  assert.equal(s.totals.refunded, 1, "[E2.3] estorno contado uma vez");
  assert.equal(s.totals.chargeback, 0, "[E2.4] contestação depois do estorno não reverte de novo");
  assert.equal(s.totals.reversedGrossCents, 14700, "[E2.5] valor revertido uma vez");
  assert.equal(activities(kv, "refund_requested").length, 1, "[E2.6] uma atividade de estorno por transação (a contestação posterior não duplica)");
  const c = await handleDigitalHotmartNc012(postback("PURCHASE_CANCELED", "HP-SINT-0003"), env);
  assert.equal(c.status, 200, "[E2.7] cancelamento antes da aprovação aceito");
  assert.equal(summary(kv).totals.canceled, 1, "[E2.8] cancelamento registrado");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E2.9] cancelamento não gera entrega");
});

test("E3 KV falha ao gravar o resumo: 503, a reentrega da Hotmart conclui e a venda NÃO some (zero faltante)", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  kv.fail("put", isSummary, 1);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0004"), env);
  assert.equal(r1.status, 503, "[E3.1] falha de gravação devolve 503 (a Hotmart reenvia)");
  assert.equal(kv.m.get(SALES_SUMMARY_KEY), undefined, "[E3.2] nada aplicado ainda");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0004"), env);
  assert.equal(r2.status, 200, "[E3.3] reentrega concluída");
  assert.equal((await r2.json()).duplicate, false, "[E3.4] a reentrega aplica a venda pendente, não a descarta como duplicata");
  assert.equal(summary(kv).totals.approved, 1, "[E3.5] venda registrada exatamente uma vez");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E3.6] entrega registrada exatamente uma vez");
});

test("E4 queda entre gravar o resumo e concluir o marcador: a reentrega NÃO conta duas vezes (zero duplicado)", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  // 1ª gravação do marcador ("pending") passa; a 2ª (conclusão) falha uma vez.
  let marks = 0;
  kv.fail("put", (k) => isTxnMark(k) && ++marks === 2, 1);
  const r1 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env);
  assert.equal(r1.status, 503, "[E4.1] falha na conclusão devolve 503");
  assert.equal(summary(kv).totals.approved, 1, "[E4.2] resumo já gravado");
  const r2 = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env);
  assert.equal(r2.status, 200, "[E4.3] reentrega aceita");
  assert.equal(summary(kv).totals.approved, 1, "[E4.4] a venda continua contada uma vez");
  assert.equal(activities(kv, "delivery_sent").length, 1, "[E4.5] uma atividade de entrega");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0005"), env)).status, 200, "[E4.6] terceira reentrega estável");
  assert.equal(summary(kv).totals.approved, 1, "[E4.7] estável depois da conclusão");
});

test("E5 leitura do resumo falha (KV fora): 503 e o resumo existente NÃO é sobrescrito", async (t) => {
  noNetwork(t);
  const kv = memKv(), env = envWith(kv);
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0006"), env);
  await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0007"), env);
  kv.fail("get", isSummary, 1);
  const r = await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0008"), env);
  assert.equal(r.status, 503, "[E5.1] leitura que falha não recomeça de um resumo vazio");
  assert.equal(summary(kv).totals.approved, 2, "[E5.2] as duas vendas anteriores continuam no resumo");
  assert.equal((await handleDigitalHotmartNc012(postback("PURCHASE_APPROVED", "HP-SINT-0008"), env)).status, 200, "[E5.3] reentrega conclui");
  assert.equal(summary(kv).totals.approved, 3, "[E5.4] três vendas, nenhuma perdida");
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
  assert.equal(summary(kv).totals.approved, 1, "[E6.5] venda contada uma vez");
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
  assert.equal(summary(kv).totals.approved, 1, "[E7.3] venda registrada");
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
  assert.equal(summary(kv).totals.approved, 1, "[E12.3] uma venda registrada");
});
