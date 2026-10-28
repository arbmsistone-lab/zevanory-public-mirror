// ZEVANORY Conteúdo Pronto — fully automatic monthly service sold on Hotmart.
// Hotmart owns billing, recurrence, cancellation and refunds. This module only:
//   1) receives the authenticated Hotmart postback (hottok, constant-time compare);
//   2) on an approved charge, emails a one-time briefing link (first cycle) or, on renewal,
//      generates the new monthly package from the stored briefing;
//   3) generates the package with Workers AI (12 posts + 4 multichannel sales/follow-up scripts,
//      each with a short and an e-mail version, + 30-day calendar), validates it, stores it
//      privately and emails it with a private link;
//   4) stops on refund / chargeback / cancellation.
// No Mercado Pago, checkout, pricing or sales-switch code is touched. Buyer e-mail/name are
// kept only in the private KV (needed for delivery), never in logs or the activity ledger.
import { brandedEmailHtml } from "./brand-email.mjs";
import { emitActivity } from "./activity-ledger.mjs";
import { recordHotmartSale } from "./sales-ledger.mjs";
import { BANNED_NUMBERS, CONTEUDO_PRONTO } from "./politica-unica.mjs";
import { resendFailureIsTransient } from "./atendimento.mjs";

// Contrato versionado da oferta (data/politica-unica.json, conteudo_pronto): a página
// /conteudo-pronto, o resumo da oferta e este gerador leem as mesmas quantidades, objetivos e
// canais. A conta de mensagens da ZEVANORY na Meta foi banida: os roteiros são para canais
// autorizados pelo cliente, revisados por ele, sem disparo automático.
export const CONTENT_SCHEMA_VERSION = CONTEUDO_PRONTO.content_schema_version;
export const PACKAGE_SCHEMA = CONTEUDO_PRONTO.package_schema;
export const ROTEIRO_OBJETIVOS = Object.freeze(CONTEUDO_PRONTO.objetivos.map((o) => Object.freeze({ ...o })));
const N_POSTS = CONTEUDO_PRONTO.posts;
// v3 (Sol AVAL 304): cada ciclo é uma campanha mensal de promoção de vendas do assinante.
export const SERVICO = CONTEUDO_PRONTO.servico;
export const CAMPANHA = CONTEUDO_PRONTO.campanha;
export const CAMPANHA_CAMPOS = Object.freeze(CAMPANHA.campos.map((f) => Object.freeze({ ...f })));
export const FASES = Object.freeze(CAMPANHA.fases.map((f) => Object.freeze({ ...f })));
const N_ROTEIROS = CONTEUDO_PRONTO.roteiros;
const CANAIS = CONTEUDO_PRONTO.canais_autorizados_exemplo;
const CANAIS_TEXTO = CANAIS.slice(0, -1).join(", ") + " ou " + CANAIS[CANAIS.length - 1];
// Canal banido e disparo em massa nunca entram num roteiro (termos em conteudo_pronto.termos_proibidos_regex);
// \b evita falso positivo em palavras como "zapier".
const ROTEIRO_PROIBIDO = new RegExp("\\b(?:" + CONTEUDO_PRONTO.termos_proibidos_regex.join("|") + ")\\b", "i");
// Número banido de contato_publico.numeros_banidos em qualquer grafia: completo, formatado ("(88) 9 9254-5413")
// ou mascarado ("88 9****-5413"). Corridas com cara de telefone são comparadas só pelos dígitos.
const PHONE_RUN = /[+(]?\d[\d\s().*•#-]{6,}\d/g;
// Máscara: DDD do número banido, de 2 a 6 posições com ao menos um caractere de máscara, e os 4 últimos dígitos.
const MASKED_RES = BANNED_NUMBERS.map((n) => new RegExp(`(?<!\\d)(?:\\+?55[\\s().-]*)?\\(?${n.slice(2, 4)}\\)?[\\s.-]*(?=[\\d\\s.*•#-]*[*•#])[\\d*•#][\\d\\s*•#]{1,6}[\\s.-]*${n.slice(-4)}(?!\\d)`));
export function bannedNumberIn(text) {
  const str = String(text ?? "");
  if (MASKED_RES.some((re) => re.test(str))) return true;
  for (const run of str.match(PHONE_RUN) || []) {
    const d = run.replace(/\D/g, "");
    if (BANNED_NUMBERS.some((n) => d.includes(n.slice(-8)))) return true;
  }
  return false;
}
// Canal banido, disparo em massa ou número banido: nada disso é gerado, exibido ou reenviado.
export const contaminated = (text) => ROTEIRO_PROIBIDO.test(String(text ?? "")) || bannedNumberIn(text);

export const SERVICE_PRODUCT_NAME = "ZEVANORY Conteúdo Pronto";
// Validade do link de cada pacote (a página promete 120 dias: tests/conteudo-pronto-roteiros.test.mjs [p24-link]).
export const PACKAGE_LINK_DAYS = 120;
// Auditoria #953 M4: sem promessa de prazo não medida ("em poucos minutos"); o limite de tentativas é dito.
export const RETRY_TEXT = "Se a geração ou o envio falhar, o sistema tenta de novo automaticamente a cada hora, até 12 vezes, e a equipe da ZEVANORY é avisada.";
const SUB = "zpc:cp:sub:";        // subscriber record
const TOKEN = "zpc:cp:token:";    // briefing/package access token -> subscriber key
const TXN = "zpc:cp:txn:";        // processed transaction (idempotency)
const PKG = "zpc:cp:pkg:";        // generated package
const PENDING = "zpc:cp:pending"; // list of subscriber keys awaiting generation retry
const ORIGIN = "https://zevanory.api.br";
const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];
const enc = new TextEncoder();
const DAY = 86400;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = () => b64(crypto.getRandomValues(new Uint8Array(32)));
// Auditoria #953 H1: o Workers KV aceita no máximo 1 escrita por segundo na MESMA chave e responde 429 acima disso; a
// Cloudflare recomenda repetir com espera (https://developers.cloudflare.com/kv/api/write-key-value-pairs/). Todas as
// gravações deste módulo passam por este invólucro: só um 429 é repetido (qualquer outro erro sobe na hora).
export const KV_PUT_RETRY_MS = Object.freeze([1100, 2500]);
const KV_RATE_LIMITED = /\b429\b|too many requests/i;
const KV_WRAPPED = new WeakMap();
function kvOf(env) {
  const raw = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!raw?.get || !raw?.put) return raw;
  if (KV_WRAPPED.has(raw)) return KV_WRAPPED.get(raw);
  const w = {
    get: (...a) => raw.get(...a), list: (...a) => raw.list?.(...a),
    delete: (k) => (raw.delete ? raw.delete(k) : raw.put(k, "", { expirationTtl: 60 })), // sem delete: valor vazio = sem lease
    put: async (k, v, o) => {
      for (let i = 0; ; i++) {
        try { return await raw.put(k, v, o); }
        catch (e) { if (i >= KV_PUT_RETRY_MS.length || !KV_RATE_LIMITED.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, KV_PUT_RETRY_MS[i])); }
      }
    },
  };
  KV_WRAPPED.set(raw, w);
  return w;
}
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function eq(a, b) { const x = enc.encode(String(a)), y = enc.encode(String(b)); let n = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) n |= (x[i] || 0) ^ (y[i] || 0); return n === 0; }
async function readJson(kv, key, fallback = null) { try { return JSON.parse(String(await kv.get(key) || "null")) ?? fallback; } catch { return fallback; } }

function bundle(env) { try { const raw = env.CHANNEL_CREDENTIALS_JSON; return raw && typeof raw === "object" ? raw : JSON.parse(String(raw || "{}")); } catch { return {}; } }
export function hottok(env) { return String(env.HOTMART_HOTTOK || bundle(env).HOTMART_HOTTOK || "").trim(); }

export function isServiceProduct(data = {}, ids = "") {
  const name = String(data?.product?.name || "");
  const list = String(ids || "").split(",").map((x) => x.trim()).filter(Boolean);
  return name.trim() === SERVICE_PRODUCT_NAME || list.includes(String(data?.product?.id || ""));
}

const ACTIVE_EVENTS = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
// subscription.status da Hotmart que encerra a assinatura. ACTIVE e STARTED são ativos conhecidos; qualquer outro
// (DELAYED, OVERDUE, SUSPENDED, um status novo) mantém a assinatura ativa e alerta o proprietário (rodada 6, MED-3).
const SUB_ENDED_RX = /^(CANCEL|INACTIVE|EXPIRED|ENDED)/;
const SUB_ACTIVE_RX = /^(ACTIVE|STARTED)$/;
const STOP_EVENTS = new Set(["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED", "PURCHASE_PROTEST", "SUBSCRIPTION_CANCELLATION"]);

// idempotencyKey (opcional): Resend retém a chave por 24 h; mesma chave + mesmo payload devolve a resposta original
// sem enviar outro e-mail (https://resend.com/docs/dashboard/emails/idempotency-keys).
async function sendEmail(env, to, subject, text, fetchImpl = fetch, idempotencyKey = "") {
  if (!env.RESEND_API_KEY || !to) return false;
  const headers = { authorization: "Bearer " + String(env.RESEND_API_KEY), "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: "suporte@zevanory.api.br", subject, text, html: brandedEmailHtml(text) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!r?.ok) return false;
  // Id do provedor (prova de envio; a confirmação de entrega vem depois pelo mesmo id). 2xx sem id: enviado, sem prova.
  const data = await r.json().catch(() => null);
  return String(data?.id || "") || true;
}
// Auditoria #953 M2: o alerta não depende só do Resend (que pode ser justamente o que falhou). Todo alerta fica
// gravado em zpc:cp:alerts (últimos 200, sem e-mail nem nome; lido pela rota autenticada /api/admin/conteudo-pronto/status)
// e vai para o ledger de atividade da central (owner_alert_sent), além do e-mail.
const ALERTS = "zpc:cp:alerts";
async function ownerAlert(env, subject, text, fetchImpl, { kind = "geral", sub = "", now = Date.now() } = {}) {
  const emailed = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"), "ZEVANORY · " + subject, text, fetchImpl);
  const kv = kvOf(env);
  const slug = String(kind).toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 48) || "geral";
  if (kv?.get) {
    try {
      const list = await readJson(kv, ALERTS, []);
      list.push({ at: new Date(now).toISOString(), kind: slug, subject: String(subject).slice(0, 120), sub: String(sub).slice(-12), emailed });
      await kv.put(ALERTS, JSON.stringify(list.slice(-200)), { expirationTtl: 400 * DAY });
    } catch {}
  }
  await emitActivity(env, { type: "owner_alert_sent", channel: "owner", status: "cp_" + slug, ref: "cp-alert:" + slug + ":" + String(sub).slice(-12) + ":" + now }).catch(() => null);
  return emailed;
}

// ---------- Hotmart postback ----------
export async function handleHotmartWebhook(request, env, ctx, fetchImpl = fetch) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const kv = kvOf(env);
  const secret = hottok(env);
  if (!kv?.get || !kv?.put) return json(503, { error: "secure_store_unavailable" });
  if (secret.length < 16) return json(503, { error: "hotmart_not_configured" });
  let body = null;
  try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
  const provided = request.headers.get("x-hotmart-hottok") || String(body?.hottok || "");
  if (!eq(provided, secret)) return json(401, { error: "unauthorized" });
  const serviceIds = String(env.HOTMART_SERVICE_PRODUCT_IDS || bundle(env).HOTMART_SERVICE_PRODUCT_IDS || "8704905");
  const event = String(body?.event || "").toUpperCase();
  const data = body?.data || {};
  const txn = String(data?.purchase?.transaction || "");
  if (!event || !txn) return json(400, { error: "missing_event_or_transaction" });
  const dedupe = TXN + (await sha(event + ":" + txn)).slice(0, 40);
  if (await kv.get(dedupe)) return json(200, { ok: true, duplicate: true });
  // G1 (ORDEM 301): o evento só conta como processado DEPOIS dos efeitos duráveis (registro do assinante e intenção de
  // geração na fila). Se o isolate cair antes, a Hotmart reenvia o postback e o processamento se repete sem dobrar o
  // ciclo (o ciclo só sobe uma vez por transação).
  const markProcessed = () => kv.put(dedupe, "1", { expirationTtl: 400 * DAY });
  // Revenue ledger for the command center (aggregate, PII-free, idempotent per txn/outcome).
  await recordHotmartSale(kv, event, data).catch(() => null);

  if (!isServiceProduct(data, serviceIds)) {
    // Digital products: Hotmart itself delivers the files. Only record visibility.
    if (ACTIVE_EVENTS.has(event)) await emitActivity(env, { type: "delivery_sent", channel: "store", status: "hotmart_approved", ref: "hotmart:" + txn }).catch(() => null);
    if (STOP_EVENTS.has(event)) await emitActivity(env, { type: "refund_requested", channel: "store", status: "hotmart_" + event.toLowerCase().slice(0, 40), ref: "hotmart:" + txn }).catch(() => null);
    await markProcessed();
    return json(200, { ok: true, scope: "digital_product" });
  }

  const subscriber = String(data?.subscription?.subscriber?.code || "") || "txn-" + txn;
  const key = SUB + (await sha(subscriber)).slice(0, 40);
  const email = String(data?.buyer?.email || "").trim().toLowerCase();
  const name = String(data?.buyer?.name || "").trim().slice(0, 80);
  let current = await readJson(kv, key, null);

  if (STOP_EVENTS.has(event)) {
    // Rodadas 5 e 6 da auditoria. Estorno, chargeback, protesto ou cancelamento de UMA transação não é, por si, o fim da
    // assinatura: supõe-se que a Hotmart permite estornar uma recorrência sem cancelar (PRECISA DE CONFIRMAÇÃO DO
    // PROPRIETÁRIO). Regras:
    //  - só um mês PAGO pode ser devolvido: o ciclo vem apenas de txnCycles (transação aprovada registrada na renovação).
    //    Transação desconhecida não mexe em mês nenhum (sem fallback por recurrence_number: a Hotmart recomeça a
    //    recorrência numa reassinatura, e um palpite errado poderia dar reembolso e pacote do mesmo mês). Um
    //    PURCHASE_CANCELED de transação desconhecida é cobrança não concluída ("não pago"), sem rótulo de reembolso;
    //  - estorno parcial (valor menor que o pago) não tira o mês: fica registrado e o proprietário é avisado;
    //  - pedido aberto do mês devolvido vira "processed"; sem pedido, o mês fica registrado como devolvido (nunca vira
    //    crédito numa reassinatura);
    //  - a assinatura só acaba com SUBSCRIPTION_CANCELLATION ou subscription.status de encerramento; ao acabar, todo
    //    outro mês pago sem pacote vira pedido de reembolso, com alerta;
    //  - payload sem status, transação desconhecida ou status fora dos conhecidos: assinatura ativa, créditos
    //    preservados, alerta ao proprietário (falha segura, nunca silenciosa).
    const at = new Date().toISOString();
    const subStatus = String(data?.subscription?.status || "").trim().toUpperCase();
    const ends = event === "SUBSCRIPTION_CANCELLATION" || (Boolean(subStatus) && SUB_ENDED_RX.test(subStatus));
    const unknownStatus = Boolean(subStatus) && !ends && !SUB_ACTIVE_RX.test(subStatus);
    if (!current) { await markProcessed(); return json(200, { ok: true, status: "unknown_subscriber" }); }
    const latest = (await readJson(kv, key, null)) || current; // releitura logo antes de gravar
    const recRaw = data?.purchase?.recurrence_number ?? data?.purchase?.recurrency_number;
    const recNum = /^\d{1,4}$/.test(String(recRaw ?? "").trim()) && Number(recRaw) > 0 ? Number(recRaw) : null; // só inteiro positivo, e só para o alerta
    const paidCycle = event === "SUBSCRIPTION_CANCELLATION" ? null : (Number.isInteger(latest.txnCycles?.[txn]) ? latest.txnCycles[txn] : null);
    const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const refundAmt = money(data?.purchase?.price?.value);
    const paidAmt = paidCycle === null ? null : (money(latest.txnPaid?.[txn]) ?? money(data?.purchase?.full_price?.value));
    const partial = paidCycle !== null && refundAmt !== null && paidAmt !== null && refundAmt < paidAmt - 0.005;
    const txnCycle = partial ? null : paidCycle; // mês efetivamente devolvido
    const refundRequests = (latest.refundRequests || []).map((r) => ({ ...r }));
    const partialRefunds = [...(latest.partialRefunds || [])];
    let matched = false;
    if (txnCycle !== null) {
      const open = refundRequests.find((r) => Number(r.cycle) === txnCycle);
      if (open) { matched = true; if (open.status !== "processed") Object.assign(open, { status: "processed", processedAt: at, processedBy: "webhook:" + event }); }
      else refundRequests.push({ cycle: txnCycle, reason: event.toLowerCase(), at, status: "processed", processedAt: at, processedBy: "webhook:" + event });
    }
    if (partial && !partialRefunds.some((r) => r.txn === txn && r.event === event)) partialRefunds.push({ cycle: paidCycle, txn, event, amount: refundAmt, paid: paidAmt, at });
    let owed = [];
    if (ends && latest.status === "active") {
      const already = new Set(refundRequests.map((r) => Number(r.cycle)));
      owed = pendingCycles({ ...latest, refundRequests }).filter((c) => !already.has(c));
      refundRequests.push(...owed.map((cycle) => ({ cycle, reason: "cancelamento", at, status: "requested" })));
    }
    const updated = { ...latest, refundRequests, ...(partialRefunds.length ? { partialRefunds: partialRefunds.slice(-36) } : {}), ...(ends ? { status: "inactive", stoppedAt: at, stopEvent: event } : {}) };
    await kv.put(key, JSON.stringify(updated), { expirationTtl: 400 * DAY });
    await syncCreditIndex(kv, key, updated);
    if (txnCycle !== null) await markRefundProcessed(kv, key, txnCycle, "webhook:" + event);
    if (owed.length) await recordRefundRequests(env, kv, key, owed, "cancelamento", { fetchImpl });
    const who = `assinante …${String(key).slice(-12)}`;
    const recTxt = recNum ? `, recorrência ${recNum} na Hotmart` : "";
    const keep = "A assinatura foi mantida ativa e os créditos foram preservados.";
    if (partial) await ownerAlert(env, "estorno parcial no Conteúdo Pronto", `A Hotmart enviou ${event} de ${refundAmt} sobre ${paidAmt} pagos (${who}, ciclo ${paidCycle}). O mês continua a entregar e o estorno parcial ficou registrado. Conferir na Hotmart.`, fetchImpl, { kind: "estorno_parcial", sub: key }).catch(() => null);
    else if (!ends && paidCycle === null && event === "PURCHASE_CANCELED") await ownerAlert(env, "cobrança do Conteúdo Pronto não concluída", `A Hotmart enviou PURCHASE_CANCELED de uma transação que não foi aprovada aqui (${who}${recTxt}). Tratado como cobrança não paga: nenhum mês foi alterado e nada foi marcado como reembolso. Se uma nova tentativa for aprovada, o mês segue normalmente. ${keep}`, fetchImpl, { kind: "cobranca_nao_concluida", sub: key }).catch(() => null);
    else if (!ends && paidCycle === null) await ownerAlert(env, "estorno de transação desconhecida no Conteúdo Pronto: confirmar", `A Hotmart enviou ${event} de uma transação que não está registrada como paga aqui (${who}${recTxt}). Nenhum mês foi alterado. ${keep} Confirmar na Hotmart qual mês foi devolvido e registrar pelo operador (refund-request e refund-processed).`, fetchImpl, { kind: "assinatura_confirmar", sub: key }).catch(() => null);
    else if (!ends && !subStatus && !matched) await ownerAlert(env, "estorno de um mês do Conteúdo Pronto: confirmar a assinatura", `A Hotmart enviou ${event} (${who}, ciclo ${txnCycle}) sem o status da assinatura. O mês ${txnCycle} saiu dos pendentes. ${keep} Confirmar na Hotmart se ela continua; se foi encerrada, o cancelamento chega como SUBSCRIPTION_CANCELLATION.`, fetchImpl, { kind: "assinatura_confirmar", sub: key }).catch(() => null);
    if (unknownStatus) await ownerAlert(env, "status de assinatura não reconhecido no Conteúdo Pronto", `A Hotmart enviou ${event} com subscription.status "${subStatus.slice(0, 40)}" (${who}). Esse status não está entre os conhecidos (ativos: ACTIVE, STARTED; encerramento: CANCEL*, INACTIVE, EXPIRED, ENDED). ${keep} Confirmar a situação na Hotmart.`, fetchImpl, { kind: "assinatura_status_desconhecido", sub: key }).catch(() => null);
    const outcome = ends ? "service_stopped" : partial ? "service_partial_refund" : paidCycle === null ? (event === "PURCHASE_CANCELED" ? "service_charge_not_completed" : "service_refund_unmatched") : "service_month_refunded";
    await emitActivity(env, { type: "refund_requested", channel: "store", status: outcome, ref: "cp:" + subscriber + ":" + event.toLowerCase() + ":" + txn }).catch(() => null);
    await markProcessed();
    return json(200, { ok: true, status: ends ? "inactive" : "active", cycle: txnCycle, ...(partial ? { partial: true } : {}), ...(paidCycle === null && !ends ? { unpaid_or_unknown: true } : {}) });
  }
  if (!ACTIVE_EVENTS.has(event)) { await markProcessed(); return json(200, { ok: true, ignored: event }); }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) { await markProcessed(); return json(200, { ok: true, status: "no_buyer_email" }); }

  current = (await readJson(kv, key, null)) || current; // releitura logo antes de montar e gravar (LOW, rodada 5)
  const record = {
    schema: "zpc.cp.v1", status: "active", email, name,
    cycles: current?.lastTxn === txn ? Number(current.cycles || 1) : Number(current?.cycles || 0) + 1, lastTxn: txn,
    briefing: current?.briefing || null, createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  // Campos de entrega do ciclo já entregue continuam (sem eles o ciclo seria entregue de novo).
  for (const f of ["deliveredCycle", "deliveredAt", "lastPackage", "briefedAt", "regenProtocolo", "regeneratedAt", "campanha", "deliveries", "credits", "creditsUsed", "refundRequests", "partialRefunds", "deliveryHistory", "emailChanges"]) if (current?.[f] !== undefined) record[f] = current[f];
  // Transação -> ciclo, para um estorno da Hotmart achar o mês certo (últimas 36).
  record.txnCycles = Object.fromEntries([...Object.entries(current?.txnCycles || {}), [txn, record.cycles]].slice(-36));
  // Valor pago por transação, para distinguir estorno parcial de total (rodada 6, MED-2).
  const paidValue = Number(data?.purchase?.price?.value);
  record.txnPaid = Object.fromEntries([...Object.entries(current?.txnPaid || {}), ...(Number.isFinite(paidValue) && paidValue > 0 ? [[txn, paidValue]] : [])].slice(-36));
  // S308: renovação com o mês anterior pago e sem pacote => crédito (nunca perda). Acima do limite, o mais antigo vira
  // pedido de reembolso registrado.
  let newCredit = null, overflow = [];
  const prev = Number(current?.cycles || 0);
  if (current && current.lastTxn !== txn && prev >= 1 && pendingCycles({ ...current, credits: [] }).includes(prev)) {
    newCredit = { cycle: prev, createdAt: new Date().toISOString() };
    const credits = [...(record.credits || []).filter((c) => Number(c.cycle) !== prev), newCredit].sort((a, b) => a.cycle - b.cycle);
    const refunded = refundedCycles(record);
    const live = credits.filter((c) => !refunded.has(Number(c.cycle)));
    overflow = live.slice(0, Math.max(0, live.length - CREDITOS_MAX)).map((c) => c.cycle);
    record.credits = credits.filter((c) => !overflow.includes(c.cycle));
    if (overflow.length) record.refundRequests = [...(record.refundRequests || []), ...overflow.map((cycle) => ({ cycle, reason: "limite_de_creditos", at: new Date().toISOString(), status: "requested" }))];
  }
  await kv.put(key, JSON.stringify(record), { expirationTtl: 400 * DAY });
  if (newCredit) { await pendingLog(kv, key, "credit_created", "ciclo " + newCredit.cycle); await syncCreditIndex(kv, key, record); }
  if (overflow.length) await recordRefundRequests(env, kv, key, overflow, "limite_de_creditos", { fetchImpl });
  await emitActivity(env, { type: "delivery_sent", channel: "store", status: record.cycles === 1 ? "service_started" : "service_renewed", ref: "cp:" + subscriber + ":" + record.cycles }).catch(() => null);

  // Formulário (boas-vindas no 1º ciclo; na renovação, pedido da campanha do mês). Auditoria #953 H2: o evento só conta
  // como processado depois que o e-mail SAIU; se o envio falhar, o pedido entra na fila de formulários (mesmo link e mesma
  // Idempotency-Key em toda tentativa), fica registrado, o proprietário é avisado e o cron tenta de novo.
  // v3: renovação = nova campanha; sem a campanha deste ciclo nada é gerado até o assinante responder.
  if (needsForm(record)) {
    const outbox = await readJson(kv, WELCOME, {});
    const item = outbox[key]?.token && outbox[key].cycles === record.cycles ? outbox[key] : { token: rand(), dedupe, cycles: record.cycles, attempts: 0, firstAt: new Date().toISOString() };
    if (item !== outbox[key]) await putToken(kv, item.token, { k: "brief", sub: key }, 60);
    const sent = await sendWelcome(env, key, record, item.token, fetchImpl);
    if (!sent) {
      await welcomeFailed(env, kv, key, { ...item, dedupe }, "email_failed", fetchImpl);
      return json(202, { ok: true, status: record.briefing ? "campaign_email_pending" : "briefing_email_pending" });
    }
    await welcomeDone(env, kv, key, subscriber, record.cycles, dedupe, Date.now(), record.briefing ? "campaign_requested" : "briefing_requested", item.token);
    // Renovação chegando sem a campanha (e sem entrega) do ciclo anterior: o proprietário é avisado (MED-2).
    if (record.briefing && newCredit) await ownerAlert(env, "ciclo do Conteúdo Pronto terminou sem campanha", `Assinante …${String(key).slice(-12)} renovou (ciclo ${record.cycles}) sem ter enviado a campanha do ciclo ${newCredit.cycle}: o mês virou crédito (${(record.credits || []).length} de ${CREDITOS_MAX}). Contatar o assinante.`, fetchImpl, { kind: "ciclo_sem_campanha", sub: key });
    if (!record.briefing && record.cycles === 1) await ownerAlert(env, "novo assinante do Conteúdo Pronto", `Novo assinante (ciclo ${record.cycles}). O formulário foi enviado automaticamente. Nenhuma ação necessária.`, fetchImpl, { kind: "novo_assinante", sub: key });
    if (!record.briefing && record.cycles > 1) await ownerAlert(env, "ciclo do Conteúdo Pronto terminou sem formulário", `Assinante …${String(key).slice(-12)} renovou (ciclo ${record.cycles}) sem nunca ter enviado o formulário; os meses sem pacote viraram crédito (${(record.credits || []).length} de ${CREDITOS_MAX}). O formulário foi reenviado. Contatar o assinante.`, fetchImpl, { kind: "ciclo_sem_campanha", sub: key });
    return json(200, { ok: true, status: record.briefing ? "campaign_requested" : "briefing_requested" });
  }
  // Reprocessamento de uma transação cujo ciclo já foi entregue (ex.: PURCHASE_COMPLETE depois do APPROVED): nada a gerar.
  if (campaignTarget(record) === null) { await markProcessed(); return json(200, { ok: true, status: "already_delivered" }); }
  // G1: entra na fila ANTES do waitUntil; se o runtime cortar a geração (até 30 s após a resposta), o cron entrega.
  await enqueuePending(kv, key);
  await markProcessed();
  const job = generateAndDeliver(env, key, fetchImpl);
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json(200, { ok: true, status: "generation_started" });
}

// ---------- Boas-vindas (formulário) com fila de repetição ----------
const WELCOME = "zpc:cp:welcome-outbox"; // { chave do assinante: { token, dedupe, cycles, attempts, firstAt, lastAt, lastReason } }
// v3: o formulário é pedido no 1º ciclo (perfil + campanha) e a cada renovação (campanha do mês).
// Sol ORDEM 308 (S308-B4): mês pago sem campanha NUNCA é perdido. Na renovação, um mês pago sem pacote vira crédito
// (record.credits); a campanha enviada depois gera o pacote do crédito mais antigo, sem custo. Limite: CREDITOS_MAX
// créditos; o que passar disso vira pedido de reembolso (o crédito mais antigo). Pedido de reembolso de mês sem pacote a
// qualquer momento (operador) e no cancelamento: o código só registra (record.refundRequests e zpc:cp:refund-requests)
// e avisa o proprietário; o estorno é feito pelo proprietário na Hotmart.
export const CREDITOS_MAX = CONTEUDO_PRONTO.creditos_max;
const REFUNDS = "zpc:cp:refund-requests";
const CREDIT_INDEX = "zpc:cp:credit-index";
const refundedCycles = (rec) => new Set((rec?.refundRequests || []).map((r) => Number(r.cycle)));
export function pendingCycles(rec) {
  if (!rec) return [];
  const refunded = refundedCycles(rec);
  const credits = [...new Set((rec.credits || []).map((c) => Number(c.cycle)))].filter((c) => !refunded.has(c)).sort((a, b) => a - b);
  const cur = Number(rec.deliveredCycle || 0) !== Number(rec.cycles) && !refunded.has(Number(rec.cycles)) && !credits.includes(Number(rec.cycles)) ? [Number(rec.cycles)] : [];
  return [...credits, ...cur];
}
export const campaignTarget = (rec) => pendingCycles(rec)[0] ?? null;
const needsForm = (rec) => !rec.briefing || (campaignTarget(rec) !== null && rec.campanha?.cycle !== campaignTarget(rec));
async function syncCreditIndex(kv, key, rec) {
  const idx = await readJson(kv, CREDIT_INDEX, {});
  const refunded = refundedCycles(rec);
  const cycles = (rec?.status === "active" ? (rec.credits || []) : []).map((c) => Number(c.cycle)).filter((c) => !refunded.has(c));
  if (JSON.stringify(idx[key] || []) === JSON.stringify(cycles)) return;
  if (cycles.length) idx[key] = cycles; else delete idx[key];
  await kv.put(CREDIT_INDEX, JSON.stringify(idx), { expirationTtl: 400 * DAY });
}
// MED-5 (rodada 5): estados do pedido de reembolso. requested -> processed (estorno confirmado pelo webhook da Hotmart
// ou marcado pelo operador, com motivo) ou -> overdue (sem processar depois de REEMBOLSO_ALERTA_DIAS; alerta ao
// proprietário). O texto público promete o estorno em até REEMBOLSO_PRAZO_DIAS_UTEIS dias úteis.
export const REEMBOLSO_PRAZO_DIAS_UTEIS = CONTEUDO_PRONTO.reembolso_prazo_dias_uteis;
export const REEMBOLSO_ALERTA_DIAS = CONTEUDO_PRONTO.reembolso_alerta_dias;
async function markRefundProcessed(kv, key, cycle, by, note = "", now = Date.now()) {
  const at = new Date(now).toISOString();
  const list = await readJson(kv, REFUNDS, []);
  let hit = false;
  for (const r of list) if (r.key === key && Number(r.cycle) === Number(cycle) && r.status !== "processed") { r.status = "processed"; r.processedAt = at; r.processedBy = String(by).slice(0, 60); r.processedNote = String(note).slice(0, 200); hit = true; }
  if (!hit && !list.some((r) => r.key === key && Number(r.cycle) === Number(cycle))) list.push({ key, sub: String(key).slice(-12), cycle: Number(cycle), reason: String(by).slice(0, 60), at, status: "processed", processedAt: at, processedBy: String(by).slice(0, 60) });
  await kv.put(REFUNDS, JSON.stringify(list.slice(-500)), { expirationTtl: 400 * DAY });
  await pendingLog(kv, key, "refund_processed", "ciclo " + cycle + " por " + String(by).slice(0, 30), now);
}
export async function checkOverdueRefunds(env, fetchImpl = fetch, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  const days = Number(env?.CP_REFUND_OVERDUE_DAYS) > 0 ? Number(env.CP_REFUND_OVERDUE_DAYS) : REEMBOLSO_ALERTA_DIAS;
  const list = await readJson(kv, REFUNDS, []);
  const late = list.filter((r) => r.status === "requested" && now - Date.parse(r.at) > days * DAY * 1000);
  if (!late.length) return { overdue: 0 };
  for (const r of late) { r.status = "overdue"; r.overdueAt = new Date(now).toISOString(); }
  await kv.put(REFUNDS, JSON.stringify(list), { expirationTtl: 400 * DAY });
  await ownerAlert(env, "reembolso do Conteúdo Pronto atrasado", `${late.length} pedido(s) de reembolso sem processar há mais de ${days} dias (${late.map((r) => "…" + r.sub + " ciclo " + r.cycle).join("; ")}). O prazo prometido é de ${REEMBOLSO_PRAZO_DIAS_UTEIS} dias úteis. Processar na Hotmart e marcar como processado: POST /api/admin/conteudo-pronto/refund-processed.`, fetchImpl, { kind: "reembolso_atrasado", now }).catch(() => null);
  return { overdue: late.length };
}
async function recordRefundRequests(env, kv, key, cycles, reason, { operator = "sistema", note = "", now = Date.now(), fetchImpl = fetch } = {}) {
  if (!cycles.length) return [];
  const at = new Date(now).toISOString();
  const reqs = cycles.map((cycle) => ({ cycle: Number(cycle), reason, operator: String(operator).slice(0, 60), note: String(note).slice(0, 200), at, status: "requested" }));
  const list = await readJson(kv, REFUNDS, []);
  // LOW (rodada 5): idempotente por (assinante, ciclo) — um pedido nunca entra duas vezes na lista do proprietário.
  const fresh = reqs.filter((r) => !list.some((x) => x.key === key && Number(x.cycle) === r.cycle));
  list.push(...fresh.map((r) => ({ ...r, key, sub: String(key).slice(-12) })));
  await kv.put(REFUNDS, JSON.stringify(list.slice(-500)), { expirationTtl: 400 * DAY });
  for (const r of reqs) await pendingLog(kv, key, "refund_requested", reason + " ciclo " + r.cycle, now);
  await ownerAlert(env, "reembolso do Conteúdo Pronto a processar na Hotmart", `Pedido de reembolso registrado (${reason}) para o assinante …${String(key).slice(-12)}, ciclo(s) ${cycles.join(", ")} sem pacote entregue. Processar o estorno na Hotmart; o sistema não move dinheiro.`, fetchImpl, { kind: "reembolso_pedido", sub: key, now }).catch(() => null);
  return reqs;
}
const firstName = (name) => (name ? ", " + String(name).split(" ")[0] : "");
const welcomeText = (name, link) => `Olá${firstName(name)}!\n\nSeu pagamento foi confirmado. Para a ZEVANORY preparar a sua ${SERVICO}, responda este formulário curto (leva 5 minutos): o perfil do negócio e a campanha do mês (objetivo comercial, oferta, condição comercial e período).\n\n${link}\n\nAssim que você enviar, a ZEVANORY gera a campanha com ${N_POSTS} posts, ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento (cada um com versão curta e versão de e-mail) e o calendário do período e envia para este e-mail. ${RETRY_TEXT} Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}; você revisa antes de usar e nada é enviado automaticamente.\n\nDúvidas: suporte@zevanory.api.br`;
const campaignRequestText = (name, cycle, link, credit = false) => `Olá${firstName(name)}!\n\n${credit ? `Você tem o mês ${cycle} em crédito (pago e ainda sem pacote). Para a ZEVANORY preparar a ${SERVICO} desse mês, sem custo adicional,` : `Sua assinatura foi renovada. Para a ZEVANORY preparar a ${SERVICO} deste mês,`} informe no formulário o objetivo comercial, a oferta, a condição comercial e o período (o perfil do seu negócio já vem preenchido):\n\n${link}\n\nA campanha chega neste e-mail depois que você enviar. ${RETRY_TEXT}\n\nDúvidas: suporte@zevanory.api.br`;
async function sendWelcome(env, key, record, token, fetchImpl) {
  const link = `${ORIGIN}/conteudo-pronto/briefing?t=${token}`;
  const idem = (record.briefing ? "cp-camp/" : "cp-welcome/") + (await sha(key + "|" + token)).slice(0, 48);
  const alvo = campaignTarget(record) ?? record.cycles;
  if (record.briefing) return sendEmail(env, record.email, `Conteúdo Pronto: defina a campanha do mês ${alvo}`, campaignRequestText(record.name, alvo, link, alvo !== record.cycles), fetchImpl, idem);
  return sendEmail(env, record.email, "Bem-vindo ao Conteúdo Pronto — falta só 1 passo", welcomeText(record.name, link), fetchImpl, idem);
}
async function welcomeFailed(env, kv, key, item, reason, fetchImpl, now = Date.now()) {
  const outbox = await readJson(kv, WELCOME, {});
  const attempts = Number(item.attempts || 0) + 1;
  outbox[key] = { ...item, attempts, lastAt: new Date(now).toISOString(), lastReason: reason };
  await kv.put(WELCOME, JSON.stringify(outbox), { expirationTtl: 400 * DAY });
  await pendingLog(kv, key, "welcome_failed", reason, now);
  if (attempts === 1) await ownerAlert(env, "e-mail com o formulário do Conteúdo Pronto não saiu", `O e-mail com o formulário (boas-vindas ou campanha do mês) não foi aceito pelo provedor (assinante …${String(key).slice(-12)}). O sistema tenta de novo a cada hora, até ${PENDING_MAX_ATTEMPTS} vezes, com o mesmo link; depois disso o item vai para a fila de falhas.`, fetchImpl, { kind: "boas_vindas_falhou", sub: key, now }).catch(() => null);
}
// #960 rodada 2 (MED-2): formulário enviado e não respondido (boas-vindas ou campanha do mês) => lembretes ao assinante
// nos dias CAMPAIGN_REMINDER_DAYS depois do pedido, alerta ao proprietário nos dias CAMPAIGN_OWNER_ALERT_DAYS. Se a
// renovação seguinte chegar sem a campanha, o mês pago vira crédito (S308; ver pendingCycles) e o proprietário é avisado
// ("ciclo sem campanha"). Regra única (MES_SEM_CAMPANHA, data/politica-unica.json →
// conteudo_pronto.mes_sem_campanha), com o mesmo texto no FAQ da página, nos Termos, no atendimento e nos lembretes.
export const MES_SEM_CAMPANHA = CONTEUDO_PRONTO.mes_sem_campanha;
export const CAMPAIGN_REMINDER_DAYS = Object.freeze([3, 7, 14]);
export const CAMPAIGN_OWNER_ALERT_DAYS = Object.freeze([7, 14]);
const FORM_WAIT = "zpc:cp:form-wait"; // { chave do assinante: { cycle, token, requestedAt, sent: [dias] } }
async function setFormWait(kv, key, cycle, token, now) {
  const w = await readJson(kv, FORM_WAIT, {});
  w[key] = { cycle, token, requestedAt: new Date(now).toISOString(), sent: [] };
  await kv.put(FORM_WAIT, JSON.stringify(w), { expirationTtl: 400 * DAY });
}
async function clearFormWait(kv, key) {
  const w = await readJson(kv, FORM_WAIT, {});
  if (w[key]) { delete w[key]; await kv.put(FORM_WAIT, JSON.stringify(w), { expirationTtl: 400 * DAY }); }
}
const reminderText = (name, cycle, first, link, day) => `Olá${firstName(name)}!\n\n${first ? "Seu pagamento foi confirmado, mas ainda falta o formulário curto (perfil do negócio e campanha do mês)" : `Sua assinatura foi renovada, mas ainda falta a campanha do mês ${cycle} (objetivo comercial, oferta, condição comercial e período)`}. Sem ela a ZEVANORY não gera os textos.\n\n${link}\n\n${MES_SEM_CAMPANHA} Este é o lembrete do dia ${day}.\n\nVocê recebe este aviso porque assinou o Conteúdo Pronto. Para não receber mais, cancele a assinatura na sua conta Hotmart. Ajuda: suporte@zevanory.api.br`;
export async function remindPendingForms(env, fetchImpl = fetch, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  const wait = await readJson(kv, FORM_WAIT, {});
  const out = { reminders: 0, alerts: 0, cleared: 0 };
  for (const [key, w] of Object.entries(wait)) {
    try {
      const rec = await readJson(kv, key, null);
      if (!rec || rec.status !== "active" || !needsForm(rec) || rec.cycles !== w.cycle) { await clearFormWait(kv, key); out.cleared++; continue; }
      const days = (now - Date.parse(w.requestedAt)) / (DAY * 1000);
      const due = CAMPAIGN_REMINDER_DAYS.filter((d) => days >= d && !(w.sent || []).includes(d));
      for (const d of due) {
        const link = `${ORIGIN}/conteudo-pronto/briefing?t=${w.token}`;
        const ok = await sendEmail(env, rec.email, rec.briefing ? `Lembrete: falta a campanha do mês ${rec.cycles} do Conteúdo Pronto` : "Lembrete: falta o formulário do Conteúdo Pronto", reminderText(rec.name, rec.cycles, !rec.briefing, link, d), fetchImpl, "cp-remind/" + (await sha(key + "|" + w.cycle + "|" + d)).slice(0, 48));
        if (!ok) { // tenta de novo no próximo cron; o proprietário é avisado na primeira falha de cada lembrete
          await pendingLog(kv, key, "reminder_failed", "day " + d, now);
          const cur = await readJson(kv, FORM_WAIT, {});
          if (cur[key] && !(cur[key].failed || []).includes(d)) {
            cur[key].failed = [...(cur[key].failed || []), d];
            await kv.put(FORM_WAIT, JSON.stringify(cur), { expirationTtl: 400 * DAY });
            await ownerAlert(env, "lembrete do Conteúdo Pronto não saiu", `O lembrete do dia ${d} para o assinante …${String(key).slice(-12)} (ciclo ${rec.cycles}) não foi aceito pelo provedor. Nova tentativa a cada hora.`, fetchImpl, { kind: "lembrete_falhou", sub: key, now });
          }
          break;
        }
        const cur = await readJson(kv, FORM_WAIT, {});
        if (cur[key]) { cur[key].sent = [...(cur[key].sent || []), d]; await kv.put(FORM_WAIT, JSON.stringify(cur), { expirationTtl: 400 * DAY }); }
        await pendingLog(kv, key, "reminder_sent", "day " + d, now);
        out.reminders++;
        if (CAMPAIGN_OWNER_ALERT_DAYS.includes(d)) {
          await ownerAlert(env, rec.briefing ? "campanha do mês do Conteúdo Pronto sem resposta" : "formulário do Conteúdo Pronto sem resposta", `Assinante …${String(key).slice(-12)} pagou o ciclo ${rec.cycles} e ainda não enviou ${rec.briefing ? "a campanha do mês" : "o formulário"} (${d} dias depois do pedido; lembretes enviados nos dias ${CAMPAIGN_REMINDER_DAYS.filter((x) => x <= d).join(", ")}). Contatar o assinante. O mês fica reservado até a próxima renovação.`, fetchImpl, { kind: "campanha_pendente", sub: key, now });
          out.alerts++;
        }
      }
    } catch (e) { await pendingLog(kv, key, "reminder_failed", "exception:" + String(e?.message || e).slice(0, 40), now).catch(() => null); }
  }
  return out;
}
async function welcomeDone(env, kv, key, ref, cycles, dedupe, now = Date.now(), status = "briefing_requested", token = "") {
  const outbox = await readJson(kv, WELCOME, {});
  if (outbox[key]) { delete outbox[key]; await kv.put(WELCOME, JSON.stringify(outbox), { expirationTtl: 400 * DAY }); await pendingLog(kv, key, "welcome_sent", "", now); }
  await emitActivity(env, { type: "email_sent", channel: "email", status, ref: (status === "campaign_requested" ? "cp-camp:" : "cp-brief:") + ref + ":" + cycles }).catch(() => null);
  if (token) await setFormWait(kv, key, cycles, token, now); // lembretes até a resposta (MED-2)
  if (dedupe) await kv.put(dedupe, "1", { expirationTtl: 400 * DAY }); // markProcessed só depois do envio
}
export async function retryWelcomeEmails(env, fetchImpl = fetch, { now = Date.now(), limit = 5 } = {}) {
  const kv = kvOf(env);
  const outbox = await readJson(kv, WELCOME, {});
  const out = { tried: 0, sent: 0, dead: 0, dropped: 0 };
  for (const [key, item] of Object.entries(outbox)) {
    try {
      const rec = await readJson(kv, key, null);
      const why = !rec ? "record_missing" : rec.status !== "active" ? "inactive" : !needsForm(rec) ? "already_briefed" : item.cycles !== rec.cycles ? "superseded_cycle" : "";
      if (why) {
        const cur = await readJson(kv, WELCOME, {}); delete cur[key];
        await kv.put(WELCOME, JSON.stringify(cur), { expirationTtl: 400 * DAY });
        if (item.dedupe) await kv.put(item.dedupe, "1", { expirationTtl: 400 * DAY });
        await pendingLog(kv, key, "welcome_dropped", why, now); out.dropped++; continue;
      }
      if (Number(item.attempts || 0) >= PENDING_MAX_ATTEMPTS) {
        const cur = await readJson(kv, WELCOME, {}); delete cur[key];
        await kv.put(WELCOME, JSON.stringify(cur), { expirationTtl: 400 * DAY });
        await deadLetter(env, kv, key, { attempts: item.attempts, firstAt: item.firstAt, lastReason: item.lastReason || "email_failed", kind: "welcome", token: item.token, dedupe: item.dedupe, cycles: item.cycles }, fetchImpl, now);
        out.dead++; continue;
      }
      if (out.tried >= limit) continue;
      out.tried++;
      if (await sendWelcome(env, key, rec, item.token, fetchImpl)) { await welcomeDone(env, kv, key, key.slice(-16), rec.cycles, item.dedupe, now, rec.briefing ? "campaign_requested" : "briefing_requested", item.token); out.sent++; }
      else await welcomeFailed(env, kv, key, item, "email_failed", fetchImpl, now);
    } catch (e) {
      out.tried++;
      await welcomeFailed(env, kv, key, item, "exception:" + String(e?.message || e).slice(0, 40), fetchImpl, now).catch(() => null);
    }
  }
  return out;
}

// ---------- Briefing form ----------
const FIELDS = [
  ["negocio", "Nome do negócio", 80, true],
  ["ramo", "Ramo / o que você faz (ex.: salão de beleza, loja de roupas, contabilidade)", 160, true],
  ["publico", "Quem é o seu cliente ideal", 240, true],
  ["produtos", "Principais produtos ou serviços que quer divulgar", 400, true],
  ["diferencial", "Por que escolher você (diferencial)", 300, true],
  ["cidade", "Cidade / região de atendimento", 80, false],
  ["tom", "Tom de voz (ex.: próximo e divertido, sério e técnico)", 120, true],
  ["contato", "Canais que seus clientes autorizaram para falar com você (ex.: e-mail, Instagram Direct, Telegram, chat do site)", 160, false],
];
// Campanha do mês: os cinco campos do contrato, todos obrigatórios. Datas AAAA-MM-DD; período de N a M dias.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Promessa de resultado em qualquer ordem ("venda garantida", "garantia de resultado", "lucro certo").
const CAMPANHA_PROMESSA = /\b(vendas?|resultados?|lucros?|retornos?|clientes?)\s+(garantid\w*|certos?|certas?)\b|\bgarant\w*\s+(de\s+)?(vendas?|resultados?|lucros?|retornos?|clientes?)\b/i;
// #960 rodadas 2 e 3 (MED-5, MED-B): promessa de RESULTADO sobre vendas, faturamento, lucro, renda, retorno ou
// desempenho, e devolução de dinheiro condicionada a resultado. Vale para os campos da campanha e para todo texto
// gerado; a condição comercial é copiada nos e-mails, por isso uma condição com promessa é recusada no formulário e
// nunca é exigida. Frases promocionais comuns passam: "vaga garantida", "horário garantido", "entrega garantida até
// sexta", "Quer vender mais?", "Com certeza você vai amar", "garantia de 90 dias no conserto".
const RES = "(vendas?|faturamento|faturar|lucros?|lucrar|renda|retorno|rentabilidade|resultados?|clientes?|desempenho)";
export const PROMESSA_RX = new RegExp([
  "garant\\w*\\s+(de\\s+|que\\s+(voce\\s+)?(vai|vao|ira|irao)\\s+)?" + RES,
  RES + "\\s+(garantid\\w*|certos?|certas?|assegurad\\w*)",
  "\\b(vai|vao|ira|irao)\\s+(vender|lucrar|faturar|ganhar dinheiro|enriquecer)",
  "\\b(dobr|triplic|multiplic|quadruplic)\\w*\\s+(\\w+\\s+){0,2}" + RES,
  RES + "\\s+(\\w+\\s+)?(em|no|ao)\\s+dobro",
  "(lucrar|faturar|ganhar|vender)\\s+(\\w+\\s+)?(o\\s+)?(dobro|triplo)",
  "retorno\\s+(de\\s+)?\\d+\\s*%",
  "\\d+\\s*%\\s*(de\\s+)?(lucro|retorno|rentabilidade|resultado|aumento\\s+(nas|de|das)\\s+vendas)",
  "resultados?\\s+em\\s+\\d+\\s+(dias?|semanas?|horas?)",
  "dinheiro\\s+(de\\s+volta|devolvido)",
  "aument\\w*\\s+(\\w+\\s+){0,2}(vendas|faturamento|lucros?|renda)\\s+(garantid|em\\s+\\d|com\\s+certeza)",
  "aumente\\s+(o\\s+|seu\\s+|sua\\s+|as\\s+|suas\\s+)?(vendas|faturamento|lucros?|renda)",
  "risco\\s+zero|fique\\s+rico|renda\\s+(extra\\s+)?garantida|milagr",
].join("|"), "i");
// Aviso ao modelo (MED-B): as mesmas promessas listadas, para a IA evitar em vez de só ser recusada depois.
export const PROMESSAS_PROIBIDAS = "Não prometa resultado de vendas, faturamento, lucro, renda, retorno ou desempenho: nada de \"você vai vender\", \"dobrar as vendas\", \"faturamento em dobro\", \"faturamento garantido\", \"retorno de X%\", \"resultado garantido\", \"resultados em X dias\", \"aumente suas vendas\" ou \"dinheiro de volta\". Frases como \"vaga garantida\", \"horário garantido\" ou \"entrega até sexta\" podem ser usadas.";
export const promessa = (t) => PROMESSA_RX.test(normTxt(t));
// #960 rodada 2 (MED-4): a âncora precisa de termos com conteúdo. Palavras vazias ("de", "da", "o") nunca bastam.
const STOPWORDS = new Set("a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que se ao aos ou mais nosso nossa nossos nossas seu sua seus suas meu minha este esta esse essa isto isso aqui todo toda todos todas".split(" "));
// Palavras genéricas de oferta também não ancoram sozinhas ("nosso produto" não prova que o post fala da oferta).
const GENERIC = new Set("produto produtos servico servicos oferta ofertas promocao promocoes desconto descontos item itens loja compra compras venda vendas cliente clientes negocio campanha preco precos normal especial novo nova novos novas".split(" "));
export const ANCHOR_MIN_CHARS = 4;
export function anchorTerms(t) { return normTxt(t).split(/[^a-z0-9%]+/).filter((w) => w.length >= ANCHOR_MIN_CHARS && !STOPWORDS.has(w) && !GENERIC.has(w)); }
// A condição comercial pode ser genérica ("preço normal"): basta um termo com conteúdo ou um número/percentual.
function conditionTerms(t) { return normTxt(t).split(/[^a-z0-9%]+/).filter((w) => (w.length >= ANCHOR_MIN_CHARS && !STOPWORDS.has(w)) || /\d/.test(w)); }
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A frase inteira, com fronteira de palavra (não substring), e só se ela tiver ao menos um termo com conteúdo.
export function anchored(text, phrase, { condition = false } = {}) {
  const ph = normTxt(phrase);
  if (!(condition ? conditionTerms(ph) : anchorTerms(ph)).length) return false;
  return new RegExp("(^|[^a-z0-9])" + reEsc(ph) + "($|[^a-z0-9])").test(normTxt(text));
}
// #960 rodada 2 (LOW): data real (sem 30/02 virando março) e, no formulário, período a partir de hoje e no máximo
// CAMPANHA_INICIO_MAX_DIAS dias à frente (o mês pago fica reservado até a próxima renovação; ver CAMPAIGN_REMINDER_DAYS).
export const CAMPANHA_INICIO_MAX_DIAS = 45;
const realDate = (v) => ISO_DATE.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const dayMs = 86400000;
export function validateCampaign(raw = {}, { now = null } = {}) {
  const c = {};
  for (const f of CAMPANHA_CAMPOS) {
    const v = String(raw?.[f.id] ?? "").replace(/\s+/g, " ").trim();
    if (f.tipo === "date") {
      if (!realDate(v)) return { ok: false, error: `Informe uma data válida: ${f.rotulo}` };
    } else {
      if (v.length < 2) return { ok: false, error: `Faltou preencher: ${f.rotulo}` };
      if (v.length > f.max) return { ok: false, error: `Texto longo demais em: ${f.rotulo} (máximo ${f.max} caracteres)` };
    }
    c[f.id] = v;
  }
  const dias = Math.round((Date.parse(c.periodo_fim + "T00:00:00Z") - Date.parse(c.periodo_inicio + "T00:00:00Z")) / dayMs) + 1;
  if (!(dias >= CAMPANHA.periodo_dias_min && dias <= CAMPANHA.periodo_dias_max)) return { ok: false, error: `O período da campanha precisa ter de ${CAMPANHA.periodo_dias_min} a ${CAMPANHA.periodo_dias_max} dias (informado: ${dias}).` };
  if (now !== null) { // só no formulário: a campanha começa hoje ou depois, dentro da janela do ciclo pago
    const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
    const ini = Date.parse(c.periodo_inicio + "T00:00:00Z");
    if (ini < today) return { ok: false, error: "O início da campanha não pode ser uma data que já passou." };
    if (ini > today + CAMPANHA_INICIO_MAX_DIAS * dayMs) return { ok: false, error: `O início da campanha precisa estar nos próximos ${CAMPANHA_INICIO_MAX_DIAS} dias.` };
  }
  if (!anchorTerms(c.oferta).length) return { ok: false, error: `Descreva a oferta com pelo menos uma palavra de ${ANCHOR_MIN_CHARS} letras ou mais (ex.: o nome do produto ou serviço).` };
  if (!conditionTerms(c.condicao_comercial).length) return { ok: false, error: `Descreva a condição comercial com pelo menos uma palavra de ${ANCHOR_MIN_CHARS} letras ou mais (ex.: "preço normal", "15% na segunda unidade").` };
  const texto = [c.objetivo_comercial, c.oferta, c.condicao_comercial].join(" ");
  if (FORBIDDEN.test(texto) || CAMPANHA_PROMESSA.test(texto) || promessa(texto) || contaminated(texto)) return { ok: false, error: "A campanha não pode prometer resultado, venda ou dinheiro de volta, nem citar canal de contato não autorizado." };
  return { ok: true, campanha: { ...c, dias } };
}
function page(title, inner, status = 200) {
  return new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ZEVANORY</title><style>body{margin:0;background:#05070b;color:#f5f7fb;font:16px/1.55 system-ui,Arial,sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px}label{display:block;margin:16px 0 6px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2a3344;background:#0b0f16;color:#f5f7fb;font:inherit}button{margin-top:20px;padding:14px 20px;border:0;border-radius:12px;background:#dbe6ff;color:#05070b;font-weight:700;font-size:16px;cursor:pointer}article{background:#0b0f16;border:1px solid #1d2533;border-radius:12px;padding:14px;margin:12px 0}h1{font-size:28px;line-height:1.2}small{color:#9aa6bd}</style></head><body><main>${inner}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } });
}
// G5: token tipado. O formulário recebe {k:"brief"} e não abre pacote; cada e-mail de pacote recebe {k:"pkg", pkg}
// e abre AQUELE pacote (o link do mês 1 continua mostrando o mês 1). Tokens antigos (valor = chave do assinante,
// emitidos antes desta versão, TTL de 60/120 dias) continuam valendo como antes: formulário e último pacote.
const putToken = (kv, token, value, ttlDays) => kv.put(TOKEN + token, JSON.stringify(value), { expirationTtl: ttlDays * DAY });
async function resolveToken(kv, token, kind) {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(token || ""))) return null;
  const raw = await kv.get(TOKEN + token);
  if (!raw) return null;
  let t = null;
  if (String(raw).startsWith(SUB)) t = { k: "legacy", sub: String(raw) };
  else { try { t = JSON.parse(String(raw)); } catch { return null; } }
  if (!t || typeof t.sub !== "string" || !t.sub.startsWith(SUB)) return null;
  if (kind && t.k !== kind && t.k !== "legacy") return null;
  return { key: t.sub, token: t, record: await readJson(kv, t.sub, null) };
}
export async function handleBriefing(request, env, ctx, fetchImpl = fetch) {
  const kv = kvOf(env);
  const url = new URL(request.url);
  if (!kv?.get) return page("Indisponível", "<h1>Tente novamente em instantes.</h1>", 503);
  const token = url.searchParams.get("t") || "";
  const found = await resolveToken(kv, token, "brief");
  if (!found?.record || found.record.status !== "active") return page("Link inválido", "<h1>Link inválido ou expirado.</h1><p>Fale com suporte@zevanory.api.br.</p>", 404);
  if (request.method === "GET") {
    const b = found.record.briefing || {};
    const cp = found.record.campanha?.cycle === found.record.cycles ? found.record.campanha : {};
    const campInputs = CAMPANHA_CAMPOS.map((f) => `<label for="${f.id}">${esc(f.rotulo)}</label>${f.tipo === "date" ? `<input type="date" id="${f.id}" name="${f.id}" value="${esc(cp[f.id] || "")}" required>` : `<input id="${f.id}" name="${f.id}" maxlength="${f.max}" value="${esc(cp[f.id] || "")}" required>`}`).join("");
    const inputs = FIELDS.map(([id, label, max, req]) => `<label for="${id}">${esc(label)}${req ? "" : " <small>(opcional)</small>"}</label>${max > 120 ? `<textarea id="${id}" name="${id}" maxlength="${max}" rows="3"${req ? " required" : ""}>${esc(b[id] || "")}</textarea>` : `<input id="${id}" name="${id}" maxlength="${max}" value="${esc(b[id] || "")}"${req ? " required" : ""}>`}`).join("");
    return page("Briefing", `<h1>Conteúdo Pronto · campanha do mês ${esc(found.record.cycles)}</h1><p>Cada mês é uma ${esc(SERVICO)} da oferta que você escolher. Informe a campanha e o perfil do negócio, com o jeito que você fala com seus clientes. Com isso a ZEVANORY prepara a campanha e envia por e-mail assim que ela fica pronta. ${esc(RETRY_TEXT)}</p><form method="post"><h2>Campanha do mês</h2>${campInputs}<p><small>A condição comercial é sua: só informe o que você vai cumprir. Os textos não prometem resultado.</small></p><h2>Perfil do negócio</h2>${inputs}<button type="submit">Enviar e gerar minha campanha</button></form>`);
  }
  if (request.method !== "POST") return page("Método inválido", "<h1>Método inválido.</h1>", 405);
  let form; try { form = await request.formData(); } catch { form = new FormData(); }
  const briefing = {};
  for (const [id, , max, req] of FIELDS) {
    const v = String(form.get(id) || "").replace(/\s+/g, " ").trim().slice(0, max);
    if (req && v.length < 2) return page("Faltou um campo", `<h1>Faltou preencher: ${esc(FIELDS.find((f) => f[0] === id)[1])}</h1><p><a href="?t=${esc(token)}" style="color:#dbe6ff">Voltar</a></p>`, 400);
    briefing[id] = v;
  }
  const camp = validateCampaign(Object.fromEntries(CAMPANHA_CAMPOS.map((f) => [f.id, form.get(f.id)])), { now: Date.now() });
  if (!camp.ok) return page("Campanha incompleta", `<h1>${esc(camp.error)}</h1><p>Sem a campanha do mês (objetivo comercial, oferta, condição comercial e período) a ZEVANORY não gera o pacote.</p><p><a href="?t=${esc(token)}" style="color:#dbe6ff">Voltar</a></p>`, 400);
  await enqueuePending(kv, found.key); // G1: intenção na fila antes de gravar o briefing e de responder
  const fresh = (await readJson(kv, found.key, null)) || found.record;
  if (fresh.status !== "active") return page("Assinatura inativa", "<h1>Esta assinatura não está ativa.</h1><p>Fale com suporte@zevanory.api.br.</p>", 409);
  await kv.put(found.key, JSON.stringify({ ...fresh, briefing, briefedAt: new Date().toISOString(), campanha: { ...camp.campanha, cycle: campaignTarget(fresh) ?? fresh.cycles, savedAt: new Date().toISOString() } }), { expirationTtl: 400 * DAY });
  await clearFormWait(kv, found.key);
  const job = generateAndDeliver(env, found.key, fetchImpl);
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return page("Recebido", `<h1>Pronto! Sua campanha do mês está sendo gerada.</h1><p>Ela chega no seu e-mail assim que ficar pronta. ${esc(RETRY_TEXT)} Confira também a caixa de spam ou promoções.</p>`);
}

// ---------- Generation ----------
function aiText(out) { return String(out?.response ?? out?.result?.response ?? out ?? ""); }
function extractJson(text) { const s = text.indexOf("{"), e = text.lastIndexOf("}"); if (s < 0 || e <= s) return null; try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; } }
const FORBIDDEN = /(garant\w* (de )?(resultado|venda|lucro)|100% garantido|fique rico|renda garantida|milagr)/i;
const HASHTAG = /^#[\p{L}\p{N}_]{2,40}$/u;
export const LEGENDA_MIN = 200;
export const IMAGEM_MIN = 8;
function briefingText(b) { return FIELDS.filter(([id]) => b[id]).map(([id, label]) => `${label}: ${b[id]}`).join("\n"); }
const normTxt = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const FASE_IDS = new Set(CAMPANHA.fases.map((f) => f.id));
// Ancoragem (v3): com a campanha, cada post cita a oferta pelo mesmo nome e traz uma fase válida da campanha.
export function validatePosts(list, n, campanha = null) {
  if (!Array.isArray(list) || list.length < n) return null;
  if (campanha && (!anchorTerms(campanha.oferta).length || promessa(campanha.oferta))) return null;
  const out = [];
  for (const p of list.slice(0, n)) {
    const tema = String(p?.tema || "").trim(), legenda = String(p?.legenda || "").trim(), cta = String(p?.cta || "").trim();
    const hashtags = (Array.isArray(p?.hashtags) ? p.hashtags : String(p?.hashtags || "").split(/[\s,]+/)).map((h) => String(h).trim()).filter(Boolean).map((h) => h.startsWith("#") ? h : "#" + h).filter((h) => HASHTAG.test(h)).slice(0, 8);
    const imagem = String(p?.imagem || "").trim();
    // G3: a página promete hashtags e sugestão de imagem para cada post; legenda curta demais não é "legenda completa".
    if (tema.length < 3 || legenda.length < LEGENDA_MIN || legenda.length > 1600 || cta.length < 3 || FORBIDDEN.test(legenda + " " + cta) || promessa(tema + " " + legenda + " " + cta)) return null;
    if (hashtags.length < 1 || imagem.length < IMAGEM_MIN) return null;
    if (out.some((q) => q.tema.toLowerCase() === tema.toLowerCase())) return null;
    if (contaminated([tema, legenda, cta, ...hashtags, imagem].join(" "))) return null;
    const fase = String(p?.fase || "").trim();
    if (campanha) {
      if (!anchored(legenda + " " + cta, campanha.oferta)) return null;
      if (!FASE_IDS.has(fase)) return null;
    }
    out.push(campanha ? { tema, legenda, cta, hashtags, imagem, fase } : { tema, legenda, cta, hashtags, imagem });
  }
  return out;
}
// Roteiros multicanal: exatamente os objetivos do contrato, na ordem; cada um com versão curta
// (Direct, Telegram, chat do site) e versão de e-mail (assunto + corpo). O objetivo exibido vem do
// contrato, nunca do modelo, para a saída não divergir da oferta.
export function validateRoteiros(list, campanha = null) {
  if (!Array.isArray(list) || list.length < N_ROTEIROS) return null;
  const out = [];
  for (const [i, obj] of ROTEIRO_OBJETIVOS.entries()) {
    const r = list[i];
    const id = String(r?.objetivo_id || r?.objetivo || "").trim();
    const curta = String(r?.curta || "").trim();
    const assunto = String(r?.email?.assunto ?? r?.email_assunto ?? "").trim();
    const corpo = String(r?.email?.corpo ?? r?.email_corpo ?? "").trim();
    if (id !== obj.id) return null;
    if (curta.length < 60 || curta.length > 600) return null;
    if (assunto.length < 5 || assunto.length > 120 || corpo.length < 200 || corpo.length > 1600) return null;
    const all = [curta, assunto, corpo].join(" ");
    if (FORBIDDEN.test(all) || promessa(all) || contaminated(all)) return null;
    if (campanha) {
      // Condição com promessa nunca é exigida no e-mail (MED-5): sem ela a campanha inteira é recusada (fail-closed).
      if (promessa(campanha.condicao_comercial) || promessa(campanha.oferta)) return null;
      if (!anchored(curta, campanha.oferta) || !anchored(corpo, campanha.oferta)) return null;
      if (!anchored(corpo, campanha.condicao_comercial, { condition: true })) return null;
    }
    out.push({ objetivo_id: obj.id, objetivo: obj.titulo, curta, email: { assunto, corpo } });
  }
  return out;
}
export function campaignText(c) {
  return `CAMPANHA DO MÊS (${SERVICO}):\nObjetivo comercial: ${c.objetivo_comercial}\nOferta promovida: ${c.oferta}\nCondição comercial: ${c.condicao_comercial}\nPeríodo: de ${c.periodo_inicio} a ${c.periodo_fim}`;
}
export function roteirosPrompt(brief, campanha = null) {
  const objetivos = ROTEIRO_OBJETIVOS.map((o, i) => `${i + 1}) "${o.id}": ${o.regra}`).join("; ");
  const camp = campanha ? `${campaignText(campanha)}\n\nTodos os roteiros promovem esta campanha: cite a oferta exatamente como "${campanha.oferta}" na versão curta e no corpo do e-mail, e escreva a condição comercial exatamente como "${campanha.condicao_comercial}" no corpo do e-mail. Não invente outra condição, prazo ou preço.\n\n` : "";
  return `Briefing do negócio:\n${brief}\n\n${camp}Crie ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento para o negócio usar em canais que o cliente autorizou, como ${CANAIS_TEXTO}. O dono revisa antes de usar; nada é enviado automaticamente. Objetivos, nesta ordem: ${objetivos}. Cada roteiro tem uma versão curta (mensagem direta de 150 a 450 caracteres) e uma versão de e-mail (assunto curto e corpo de 400 a 1200 caracteres). Não cite aplicativos de mensagem que o cliente não autorizou, não proponha envio em massa e não invente nomes, preços ou prazos. JSON: {"roteiros":[{"objetivo_id":"${ROTEIRO_OBJETIVOS[0].id}","curta":"...","email":{"assunto":"...","corpo":"..."}}]}`;
}
async function ask(ai, system, user, validate) {
  let corrected = false; // MED-B: uma única nova chamada corretiva quando a recusa foi por promessa
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let timer, prompt = user, retryFix = false;
      try {
        const out = await Promise.race([
          ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 3000, temperature: 0.6 }),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("ai_timeout")), 60000); }),
        ]);
        const parsed = extractJson(aiText(out));
        const ok = parsed && validate(parsed);
        if (ok) return ok;
        retryFix = Boolean(parsed) && !corrected && promessa(JSON.stringify(parsed));
      } catch {} finally { clearTimeout(timer); }
      if (retryFix) {
        corrected = true;
        let t2;
        try {
          const out = await Promise.race([
            ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user + "\n\n" + CORRECAO_PROMESSA }], max_tokens: 3000, temperature: 0.4 }),
            new Promise((_, rej) => { t2 = setTimeout(() => rej(new Error("ai_timeout")), 60000); }),
          ]);
          const parsed = extractJson(aiText(out));
          const ok = parsed && validate(parsed);
          if (ok) return ok;
        } catch {} finally { clearTimeout(t2); }
      }
    }
  }
  return null;
}
const SYSTEM = "Você é redator sênior de marketing para pequenos negócios brasileiros. Escreva em português do Brasil, no tom pedido, de forma concreta, sem promessas de resultado, sem preços inventados, sem emojis em excesso. " + PROMESSAS_PROIBIDAS + " Responda SOMENTE com JSON válido.";
export const CORRECAO_PROMESSA = "ATENÇÃO: a resposta anterior foi recusada porque trazia promessa de resultado de vendas, faturamento, lucro, renda ou desempenho. Reescreva o mesmo JSON sem nenhuma promessa desse tipo, mantendo a oferta e a condição comercial exatamente como informadas. " + PROMESSAS_PROIBIDAS;
const isoAdd = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * dayMs).toISOString().slice(0, 10);
// Calendário da campanha: 12 posts e 4 roteiros distribuídos nas datas do período informado (v3).
export function campaignCalendar(campanha, posts, roteiros) {
  const span = Math.round((Date.parse(campanha.periodo_fim + "T00:00:00Z") - Date.parse(campanha.periodo_inicio + "T00:00:00Z")) / dayMs);
  const at = (f) => Math.round(f * span);
  const cal = posts.map((p, i) => ({ dia: at(i / (posts.length - 1)) + 1, data: isoAdd(campanha.periodo_inicio, at(i / (posts.length - 1))), tipo: "post", tema: p.tema, fase: p.fase }));
  [0.15, 0.4, 0.65, 0.9].forEach((f, i) => cal.push({ dia: at(f) + 1, data: isoAdd(campanha.periodo_inicio, at(f)), tipo: "roteiro", tema: roteiros[i].objetivo }));
  return cal.sort((x, y) => x.dia - y.dia || (x.tipo === "post" ? -1 : 1));
}
// v3: o gerador RECUSA sem campanha válida (nenhuma chamada de IA). Posts e roteiros ancorados na campanha; as seis
// fases precisam aparecer nos 12 posts.
export async function generatePackage(env, briefing, cycle = 1, campanha = null) {
  const v = validateCampaign(campanha || {});
  if (!v.ok) return null;
  const camp = v.campanha;
  const ai = env.AI;
  if (!ai?.run) return null;
  const brief = briefingText(briefing);
  const fases = CAMPANHA.fases.map((f) => `"${f.id}" (${f.titulo})`).join(", ");
  const postSpec = (from) => `Briefing do negócio:\n${brief}\n\n${campaignText(camp)}\n\nCrie 6 posts para redes sociais da campanha (mês ${cycle}, posts ${from} a ${from + 5}). Todos promovem a oferta: cite-a exatamente como "${camp.oferta}" na legenda; use só a condição comercial informada; não invente nomes, preços nem prazos. Cada post tem uma fase da campanha, entre: ${fases}. JSON: {"posts":[{"fase":"anuncio","tema":"...","legenda":"legenda completa de 400 a 900 caracteres","cta":"chamada para ação curta","hashtags":["#...",5 a 8],"imagem":"sugestão objetiva de foto ou arte"}]}`;
  const a = await ask(ai, SYSTEM, postSpec(1), (j) => validatePosts(j.posts, 6, camp));
  if (!a) return null;
  const b = await ask(ai, SYSTEM, postSpec(7) + `\nNão repita estes temas: ${a.map((p) => p.tema).join("; ")}. Cubra as fases que faltarem entre: ${fases}.`, (j) => {
    const out = validatePosts(j.posts, 6, camp);
    return out && FASE_IDS.size === new Set([...a, ...out].map((p) => p.fase)).size ? out : null;
  });
  if (!b) return null;
  const m = await ask(ai, SYSTEM, roteirosPrompt(brief, camp), (j) => validateRoteiros(j.roteiros, camp));
  if (!m) return null;
  const posts = [...a, ...b];
  if (posts.length !== N_POSTS) return null;
  const { dias: _d, ...campanhaGravada } = camp;
  return { schema: PACKAGE_SCHEMA, content_schema_version: CONTENT_SCHEMA_VERSION, servico: SERVICO, cycle, generatedAt: new Date().toISOString(),
    campanha: campanhaGravada, posts, roteiros: m, calendario: campaignCalendar(camp, posts, m) };
}
// Pacotes antigos (zpc.cp.package.v1, campo "mensagens") continuam legíveis no link privado, com
// rótulo neutro: nenhum canal é prometido na reexibição.
function roteirosOf(pkg) {
  if (Array.isArray(pkg?.roteiros)) return pkg.roteiros;
  return (Array.isArray(pkg?.mensagens) ? pkg.mensagens : []).map((m) => ({ objetivo: String(m?.objetivo || ""), curta: String(m?.texto || ""), email: null }));
}
// Tudo o que a leitura exibe ou reenvia (o "tipo" do calendário nunca é exibido: vira Post/Roteiro).
export function displayedText(pkg) {
  const posts = (Array.isArray(pkg?.posts) ? pkg.posts : []).flatMap((p) => [p?.tema, p?.legenda, p?.cta, ...(Array.isArray(p?.hashtags) ? p.hashtags : [p?.hashtags]), p?.imagem]);
  const rots = roteirosOf(pkg).flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo]);
  const cal = (Array.isArray(pkg?.calendario) ? pkg.calendario : []).map((c) => c?.tema);
  const camp = pkg?.campanha ? [pkg.campanha.objetivo_comercial, pkg.campanha.oferta, pkg.campanha.condicao_comercial] : [];
  return [...camp, ...posts, ...rots, ...cal].filter((x) => x != null).map(String).join("\n");
}
// Decisão (AVAL Sol #898): pacote gravado que cita canal banido ou o número banido NÃO é saneado nem exibido —
// é bloqueado na leitura; os bytes gravados ficam intactos e o assinante ativo pode gerar, sem custo, uma versão
// nova no formato atual (chave nova). Sanear texto de IA trocaria o sentido das mensagens sem revisão humana.
export const packageBlocked = (pkg) => contaminated(displayedText(pkg));
export const BLOQUEIO_TEXTO = "Este pacote foi gerado no formato anterior e cita um canal de contato que a ZEVANORY não usa mais. Por segurança ele não é exibido nem reenviado; a versão gravada fica guardada sem alteração. Você pode gerar, sem custo, uma versão nova no formato atual (roteiros multicanal, cada um com versão curta e versão de e-mail).";
const CAL_LABEL = { post: "Post", roteiro: "Roteiro" };
const calLabel = (tipo) => CAL_LABEL[tipo] || "Roteiro";
export const ROTEIROS_TITULO = `${N_ROTEIROS} ROTEIROS MULTICANAL DE VENDA E ACOMPANHAMENTO`;
export const ROTEIROS_AVISO = `Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}. Use a reativação só com relacionamento ativo ou consentimento registrado. Você revisa antes de usar; não há disparo automático.`;
export function packageText(pkg, name = "") {
  if (packageBlocked(pkg)) return `Seu pacote Conteúdo Pronto — mês ${pkg?.cycle ?? ""}\n\n${BLOQUEIO_TEXTO}\nPeça a versão nova pelo link privado do pacote ou em suporte@zevanory.api.br.`;
  const camp = pkg.campanha;
  const br = (iso) => iso ? iso.split("-").reverse().join("/") : "";
  const lines = [`Seu pacote Conteúdo Pronto — mês ${pkg.cycle}${name ? ` (${name})` : ""}`, ""];
  if (camp) lines.push(`CAMPANHA DO MÊS (${SERVICO})`, `Objetivo comercial: ${camp.objetivo_comercial}`, `Oferta promovida: ${camp.oferta}`, `Condição comercial: ${camp.condicao_comercial}`, `Período: ${br(camp.periodo_inicio)} a ${br(camp.periodo_fim)}`, "");
  lines.push(camp ? "CALENDÁRIO DA CAMPANHA" : "CALENDÁRIO DE 30 DIAS");
  const faseTitulo = Object.fromEntries(CAMPANHA.fases.map((f) => [f.id, f.titulo]));
  for (const c of pkg.calendario) lines.push(c.data ? `${br(c.data)} · ${calLabel(c.tipo)}${c.fase ? " · " + (faseTitulo[c.fase] || c.fase) : ""} · ${c.tema}` : `Dia ${String(c.dia).padStart(2, "0")} · ${calLabel(c.tipo)} · ${c.tema}`);
  lines.push("", `${pkg.posts.length} POSTS`);
  pkg.posts.forEach((p, i) => lines.push("", `POST ${i + 1} — ${p.tema}`, p.legenda, `Chamada: ${p.cta}`, p.hashtags.join(" "), `Imagem sugerida: ${p.imagem || "foto real do seu negócio"}`));
  lines.push("", ROTEIROS_TITULO, ROTEIROS_AVISO);
  roteirosOf(pkg).forEach((r, i) => {
    lines.push("", `ROTEIRO ${i + 1} — ${r.objetivo}`, "Versão curta:", r.curta);
    if (r.email) lines.push("Versão de e-mail:", `Assunto: ${r.email.assunto}`, r.email.corpo);
  });
  lines.push("", "Revise e ajuste o que quiser antes de publicar ou enviar. Fale só com quem autorizou o contato com você.");
  return lines.join("\n");
}
// G2 (ORDEM 301): fila com tentativas contadas, item envenenado vai para a fila de falhas (com alerta e registro
// explícito), reenvio só por operação registrada, alerta quando a fila para de andar e um registro de cada saída da
// fila (nenhum pacote some em silêncio). Estado: zpc:cp:pending (fila), zpc:cp:pending-meta (tentativas),
// zpc:cp:pending-dead (falhas definitivas), zpc:cp:pending-log (últimos 300 eventos, sem e-mail nem nome).
const PENDING_META = "zpc:cp:pending-meta";
const PENDING_DEAD = "zpc:cp:pending-dead";
const PENDING_LOG = "zpc:cp:pending-log";
const STALL_ALERT = "zpc:cp:pending-stall-alert";
export const PENDING_MAX_ATTEMPTS = 12;
export const PENDING_STALL_HOURS = 6;
async function pendingLog(kv, key, event, reason = "", now = Date.now()) {
  const log = await readJson(kv, PENDING_LOG, []);
  log.push({ at: new Date(now).toISOString(), sub: String(key).slice(-12), event, reason: String(reason).slice(0, 80) });
  await kv.put(PENDING_LOG, JSON.stringify(log.slice(-300)), { expirationTtl: 400 * DAY });
}
async function enqueuePending(kv, key, now = Date.now()) {
  const pending = await readJson(kv, PENDING, []);
  if (pending.includes(key)) return;
  if (pending.length >= 200) throw new Error("pending_queue_full"); // nunca descarta o mais antigo em silêncio
  await kv.put(PENDING, JSON.stringify([...pending, key]));
  const meta = await readJson(kv, PENDING_META, {});
  if (!meta[key]) { meta[key] = { attempts: 0, firstAt: new Date(now).toISOString() }; await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY }); }
  await pendingLog(kv, key, "enqueued", "", now);
}
async function notePendingFailure(kv, key, reason, now = Date.now()) {
  const meta = await readJson(kv, PENDING_META, {});
  const m = meta[key] || { attempts: 0, firstAt: new Date(now).toISOString() };
  meta[key] = { ...m, attempts: Number(m.attempts || 0) + 1, lastAt: new Date(now).toISOString(), lastReason: reason };
  await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY });
}
async function leavePending(kv, key, event, reason, now = Date.now()) {
  const pending = await readJson(kv, PENDING, []);
  if (pending.includes(key)) await kv.put(PENDING, JSON.stringify(pending.filter((k) => k !== key)));
  const meta = await readJson(kv, PENDING_META, {});
  const m = meta[key];
  if (m) { delete meta[key]; await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY }); }
  await pendingLog(kv, key, event, reason, now);
  return m || null;
}
async function deadLetter(env, kv, key, m, fetchImpl, now) {
  const dead = await readJson(kv, PENDING_DEAD, {});
  const prev = dead[key] || null; // um segundo dead-letter não apaga o histórico de operações do primeiro
  const kind = m?.kind === "welcome" ? "welcome" : "package";
  dead[key] = { ...(m || {}), kind, deadAt: new Date(now).toISOString(), status: "dead", operations: prev?.operations || [], history: [...(prev?.history || []), ...(prev ? [{ deadAt: prev.deadAt, attempts: prev.attempts, lastReason: prev.lastReason }] : [])].slice(-20) };
  await kv.put(PENDING_DEAD, JSON.stringify(dead), { expirationTtl: 400 * DAY });
  if (kind === "package") await leavePending(kv, key, "dead", m?.lastReason || "max_attempts", now);
  else await pendingLog(kv, key, "dead", "welcome:" + (m?.lastReason || "max_attempts"), now);
  const what = kind === "welcome" ? "o e-mail com o formulário" : "o pacote do mês";
  await ownerAlert(env, kind === "welcome" ? "boas-vindas do Conteúdo Pronto sem entrega" : "pacote do Conteúdo Pronto sem entrega", `Um assinante ficou sem ${what} após ${m?.attempts ?? "?"} tentativas (último motivo: ${m?.lastReason || "desconhecido"}; assinante …${String(key).slice(-12)}). Nada mais será tentado automaticamente. Reenvio só pelo operador, com motivo registrado: POST /api/admin/conteudo-pronto/requeue (ou node scripts/conteudo-pronto/operador.mjs requeue).`, fetchImpl, { kind: "sem_entrega_" + kind, sub: key, now }).catch(() => null);
}
// Reenvio controlado de um item da fila de falhas: só com operador e motivo, registrado no log.
export async function requeueDeadPackage(env, key, { operator, reason, newEmail = "", now = Date.now() } = {}) {
  const kv = kvOf(env);
  if (!String(operator || "").trim() || String(reason || "").trim().length < 10) return { ok: false, reason: "operator_and_reason_required" };
  const dead = await readJson(kv, PENDING_DEAD, {});
  if (!dead[key]) return { ok: false, reason: "not_dead" };
  if (dead[key].status !== "dead") return { ok: false, reason: "not_dead" };
  if (dead[key].kind === "delivery_bounced") { // o reenvio só vale para o ciclo atual de um assinante ativo
    const latest = await readJson(kv, key, null);
    if (!latest || latest.status !== "active") return { ok: false, reason: "inactive" };
    if (Number(dead[key].cycle) !== latest.cycles) return { ok: false, reason: "cycle_superseded" };
    if (newEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(newEmail).trim())) return { ok: false, reason: "invalid_email" };
  } else if (newEmail) return { ok: false, reason: "email_change_only_for_bounce" };
  const ops = [...(dead[key].operations || []), { at: new Date(now).toISOString(), operator: String(operator).slice(0, 60), reason: String(reason).slice(0, 200), ...(newEmail ? { email_changed: true } : {}) }];
  dead[key] = { ...dead[key], status: "requeued", operations: ops };
  await kv.put(PENDING_DEAD, JSON.stringify(dead), { expirationTtl: 400 * DAY });
  if (dead[key].kind === "delivery_bounced") {
    // Mesmo pacote gravado, token de entrega novo (nova Idempotency-Key: o Resend não devolve a resposta antiga);
    // o recibo com falha fica no histórico do assinante.
    const d = dead[key];
    const latest = await readJson(kv, key, null);
    if (d.pkgKey) { await kv.delete(SENT + d.pkgKey.slice(PKG.length)); await kv.delete(DELIVERY + d.pkgKey.slice(PKG.length)); }
    const history = [...(latest.deliveryHistory || []), { cycle: d.cycle, receipt: latest.deliveries?.[d.cycle] || null, requeuedAt: new Date(now).toISOString(), operator: String(operator).slice(0, 60) }].slice(-20);
    const { deliveredCycle: _dc, ...rest } = latest;
    const email = newEmail ? String(newEmail).trim().toLowerCase() : latest.email;
    const emailOps = newEmail ? [...(latest.emailChanges || []), { at: new Date(now).toISOString(), operator: String(operator).slice(0, 60), reason: String(reason).slice(0, 200) }].slice(-20) : latest.emailChanges;
    await kv.put(key, JSON.stringify({ ...rest, email, ...(emailOps ? { emailChanges: emailOps } : {}), deliveryHistory: history }), { expirationTtl: 400 * DAY });
    if (newEmail) await pendingLog(kv, key, "email_changed", String(operator).slice(0, 40), now); // sem o endereço no log
    const meta = await readJson(kv, PENDING_META, {});
    meta[key] = { attempts: 0, firstAt: new Date(now).toISOString(), requeued: true };
    await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY });
    await enqueuePending(kv, key, now);
  } else if (dead[key].kind === "welcome") {
    const outbox = await readJson(kv, WELCOME, {});
    outbox[key] = { token: dead[key].token, dedupe: dead[key].dedupe, cycles: dead[key].cycles, attempts: 0, firstAt: new Date(now).toISOString(), requeuedBy: String(operator).slice(0, 60) };
    await kv.put(WELCOME, JSON.stringify(outbox), { expirationTtl: 400 * DAY });
  } else {
    const meta = await readJson(kv, PENDING_META, {});
    meta[key] = { attempts: 0, firstAt: new Date(now).toISOString(), requeued: true };
    await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY });
    await enqueuePending(kv, key, now);
  }
  await pendingLog(kv, key, "requeued", String(operator).slice(0, 40), now);
  return { ok: true };
}
// G1: enquanto uma geração está em andamento, o cron e um reenvio do formulário não começam outra para o mesmo
// assinante. Auditoria #953 M3: o lease cobre o PIOR caso da geração (3 chamadas de IA x modelos x tentativas x tempo
// limite de cada chamada, mais o envio e as repetições de KV), não só os 30 s do waitUntil. Ele fica numa chave
// própria (zpc:cp:lease:), para não gastar escritas na chave do assinante (H1: 1 escrita/s por chave).
export const AI_CALL_TIMEOUT_MS = 60000;
export const AI_ATTEMPTS_PER_MODEL = 2;
export const AI_CALLS_PER_PACKAGE = 3;
export const AI_CORRECTIVE_CALLS = 1; // nova chamada corretiva por recusa de promessa (no máximo 1 por chamada ao modelo)
export const GEN_WORST_CASE_MS = AI_CALLS_PER_PACKAGE * (MODELS.length * AI_ATTEMPTS_PER_MODEL + AI_CORRECTIVE_CALLS) * AI_CALL_TIMEOUT_MS;
export const GEN_LEASE_MS = GEN_WORST_CASE_MS + 3 * 60000;
const LEASE = "zpc:cp:lease:";
const SENT = "zpc:cp:sent:";       // envio aceito de um pacote (chave própria: sobrevive a falha na gravação do assinante)
const DELIVERY = "zpc:cp:delivery:"; // token estável do e-mail de um pacote, entre tentativas
const leaseKey = (key) => LEASE + key.slice(SUB.length);
async function releaseLease(kv, key) { // a tentativa terminou: o lease só protege geração em andamento
  await kv.delete(leaseKey(key));
}
const DELIVERY_OUTBOX = "zpc:cp:delivery-outbox";
async function deliveryOutboxAdd(kv, key, cycle) {
  const list = await readJson(kv, DELIVERY_OUTBOX, []);
  const id = key + "#" + cycle;
  if (!list.includes(id)) await kv.put(DELIVERY_OUTBOX, JSON.stringify([...list, id].slice(-500)));
}
// Confirmação de entrega (v3): consulta o evento do e-mail no provedor pelo id gravado. delivered/opened/clicked =>
// confirmado; bounced/failed/suppressed/canceled => falha registrada no recibo + alerta ao proprietário.
// #960 rodada 2 (MED-1): o GET ao provedor leva tempo; um cancelamento pode chegar no meio. O registro é relido logo
// antes de gravar e só o recibo do ciclo muda (status, stopEvent e o resto vêm da leitura nova): o cancelamento vence.
async function patchReceipt(kv, key, cycle, patch) {
  const latest = await readJson(kv, key, null);
  if (!latest?.deliveries?.[cycle]) return null;
  const merged = { ...latest, deliveries: { ...latest.deliveries, [cycle]: { ...latest.deliveries[cycle], ...patch } } };
  await kv.put(key, JSON.stringify(merged), { expirationTtl: 400 * DAY });
  return merged;
}
export async function confirmPackageDeliveries(env, fetchImpl = fetch, { limit = 10, now = Date.now() } = {}) {
  const kv = kvOf(env);
  const list = await readJson(kv, DELIVERY_OUTBOX, []);
  let confirmed = 0, failed = 0;
  const keep = [];
  for (const id of list) {
    if (confirmed + failed >= limit) { keep.push(id); continue; }
    const [key, cycle] = id.split("#");
    const rec = await readJson(kv, key, null);
    const rcpt = rec?.deliveries?.[cycle];
    if (!rcpt?.email_id || rcpt.status === "confirmed" || rcpt.status === "failed") continue;
    const ev = await resendLastEvent(env, rcpt.email_id, fetchImpl);
    const entregue = Boolean(ev) && DELIVERED_EVENTS.has(ev);
    if (entregue) {
      await patchReceipt(kv, key, cycle, { status: "confirmed", confirmedAt: new Date(now).toISOString(), provider_event: ev });
      confirmed++;
    } else if (ev && DEAD_EVENTS.has(ev)) {
      await patchReceipt(kv, key, cycle, { status: "failed", failedAt: new Date(now).toISOString(), provider_event: ev });
      // MED-3: a falha de entrega vai para a fila de falhas (visível em /status, reenviável por /requeue).
      const dead = await readJson(kv, PENDING_DEAD, {});
      const prev = dead[key] || null;
      dead[key] = { kind: "delivery_bounced", cycle: Number(cycle), protocolo: rcpt.protocolo, email_id: rcpt.email_id, pkgKey: rcpt.pkgKey, provider_event: ev, lastReason: "resend_" + ev, attempts: 1, deadAt: new Date(now).toISOString(), status: "dead", operations: prev?.operations || [], history: [...(prev?.history || []), ...(prev ? [{ deadAt: prev.deadAt, kind: prev.kind, lastReason: prev.lastReason }] : [])].slice(-20) };
      await kv.put(PENDING_DEAD, JSON.stringify(dead), { expirationTtl: 400 * DAY });
      await pendingLog(kv, key, "delivery_failed", "resend_" + ev, now);
      await ownerAlert(env, "campanha do Conteúdo Pronto não entregue", `Protocolo ${rcpt.protocolo}: o provedor de e-mail registrou ${ev} (assinante …${String(key).slice(-12)}). Confira o endereço com o assinante e reenvie pelo operador: POST /api/admin/conteudo-pronto/requeue (ou node scripts/conteudo-pronto/operador.mjs requeue).`, fetchImpl, { kind: "entrega_falhou", sub: key, now }).catch(() => null);
      failed++;
    } else keep.push(id);
  }
  if (JSON.stringify(keep) !== JSON.stringify(list)) await kv.put(DELIVERY_OUTBOX, JSON.stringify(keep));
  return { confirmed, failed, waiting: keep.length };
}
export async function generateAndDeliver(env, key, fetchImpl = fetch, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  const record = await readJson(kv, key, null);
  if (!record || record.status !== "active" || !record.briefing) return { ok: false, reason: "not_ready" };
  // S308: o mês a entregar é o crédito mais antigo; sem crédito, o mês atual ainda sem pacote.
  const cyc = campaignTarget(record);
  if (cyc === null) return { ok: true, reason: "already_delivered" };
  // v3: sem a campanha DESSE mês não há geração (o assinante recebeu o formulário da campanha).
  if (record.campanha?.cycle !== cyc || !validateCampaign(record.campanha).ok) return { ok: false, reason: "campaign_required" };
  const leaseUntil = Date.parse(String(await kv.get(leaseKey(key)) || "")) || 0;
  if (leaseUntil > now) return { ok: false, reason: "in_progress" };
  await kv.put(leaseKey(key), new Date(now + GEN_LEASE_MS).toISOString(), { expirationTtl: Math.ceil(GEN_LEASE_MS / 1000) + 60 });
  // Chave com a versão do schema: uma regeneração nunca sobrescreve um pacote antigo gravado.
  const pkgKey = PKG + key.slice(SUB.length) + ":" + cyc + ":v" + CONTENT_SCHEMA_VERSION;
  // G4: pacote do ciclo já gerado (o envio falhou antes) é reaproveitado: o retry não chama a IA de novo nem troca o
  // conteúdo que o assinante ainda vai receber.
  let pkg = await readJson(kv, pkgKey, null);
  if (!pkg || pkg.cycle !== cyc || packageBlocked(pkg)) {
    pkg = await generatePackage(env, record.briefing, cyc, record.campanha);
    if (!pkg) {
      await enqueuePending(kv, key, now);
      await notePendingFailure(kv, key, "generation_failed", now);
      await releaseLease(kv, key);
      await ownerAlert(env, "geração do Conteúdo Pronto adiada", `A IA não gerou um pacote válido agora; nova tentativa automática em até 1 hora (máximo ${PENDING_MAX_ATTEMPTS}).`, fetchImpl, { kind: "geracao_adiada", sub: key, now });
      return { ok: false, reason: "generation_failed_retry_scheduled" };
    }
    await kv.put(pkgKey, JSON.stringify(pkg), { expirationTtl: 400 * DAY });
  }
  // G4/G5: um token por pacote (abre só este pacote), estável entre tentativas, para o e-mail repetido ser idêntico.
  // Fica numa chave própria por pacote (H1: nenhuma escrita extra na chave do assinante antes do envio).
  const deliveryKey = DELIVERY + pkgKey.slice(PKG.length);
  const stored = await readJson(kv, deliveryKey, null);
  const delivery = stored?.pkgKey === pkgKey && stored.token ? stored : { pkgKey, token: rand() };
  if (delivery !== stored) {
    await putToken(kv, delivery.token, { k: "pkg", sub: key, pkg: pkgKey }, PACKAGE_LINK_DAYS);
    await kv.put(deliveryKey, JSON.stringify(delivery), { expirationTtl: 400 * DAY });
  }
  const token = delivery.token;
  // H1: se o envio deste pacote já foi aceito (e a gravação seguinte falhou), não reenvia: só conclui o registro.
  const sentKey = SENT + pkgKey.slice(PKG.length);
  const sentRaw = await kv.get(sentKey);
  let sentMark = null;
  if (sentRaw) { try { sentMark = JSON.parse(String(sentRaw)); } catch { sentMark = { at: String(sentRaw), email_id: null }; } }
  if (!sentMark) {
    const text = packageText(pkg, record.briefing.negocio) + `\n\nVersão para consulta online: ${ORIGIN}/conteudo-pronto/pacote?t=${token}\n\nDúvidas ou ajustes: responda este e-mail ou escreva para suporte@zevanory.api.br.`;
    const sent = await sendEmail(env, record.email, `Seu Conteúdo Pronto do mês ${cyc} chegou`, text, fetchImpl, "cp-pkg/" + (await sha(pkgKey + "|" + token)).slice(0, 48));
    if (!sent) {
      await enqueuePending(kv, key, now);
      await notePendingFailure(kv, key, "email_failed", now);
      await releaseLease(kv, key);
      return { ok: false, reason: "email_failed_retry_scheduled" };
    }
    sentMark = { at: new Date(now).toISOString(), email_id: typeof sent === "string" ? sent : null };
    await kv.put(sentKey, JSON.stringify(sentMark), { expirationTtl: 400 * DAY });
  }
  const latest = (await readJson(kv, key, null)) || record; // o formulário pode ter gravado o registro durante a geração
  const { genLeaseUntil: _lease, pendingDelivery: _pd, ...base } = latest;
  // Entrega verificável (v3): protocolo, SHA-256 do pacote, id do e-mail no provedor; a confirmação de entrega vem do
  // provedor pelo mesmo id (confirmPackageDeliveries, no cron).
  const pkgSha = await sha(JSON.stringify(pkg));
  const receipt = { pkgKey, sha256: pkgSha, protocolo: "CP-" + pkgSha.slice(0, 10).toUpperCase(), email_id: sentMark.email_id || null, sentAt: sentMark.at, status: sentMark.email_id ? "sent" : "sent_without_id" };
  const isCurrent = cyc === Number(latest.cycles);
  const credits = (latest.credits || []).filter((c) => Number(c.cycle) !== cyc);
  const creditsUsed = isCurrent ? latest.creditsUsed : [...(latest.creditsUsed || []), { cycle: cyc, deliveredAt: new Date(now).toISOString() }];
  const updated = { ...base, ...(isCurrent ? { deliveredCycle: cyc } : {}), deliveredAt: new Date().toISOString(), lastPackage: pkgKey, deliveries: { ...(latest.deliveries || {}), [cyc]: receipt }, credits, ...(creditsUsed ? { creditsUsed } : {}) };
  await kv.put(key, JSON.stringify(updated), { expirationTtl: 400 * DAY });
  await releaseLease(kv, key);
  if (receipt.email_id) await deliveryOutboxAdd(kv, key, cyc);
  await leavePending(kv, key, "delivered", "cycle " + cyc + (isCurrent ? "" : " (crédito)"), now);
  if (!isCurrent) await syncCreditIndex(kv, key, updated);
  await emitActivity(env, { type: "delivery_sent", channel: "email", status: "service_package_delivered", ref: "cp-pkg:" + key.slice(-16) + ":" + cyc }).catch(() => null);
  // Ainda há mês pago sem pacote (outro crédito ou o mês atual): pede a próxima campanha pela fila de formulários.
  if (campaignTarget(updated) !== null && updated.status === "active") {
    const outbox = await readJson(kv, WELCOME, {});
    if (!outbox[key]) {
      const token = rand();
      await putToken(kv, token, { k: "brief", sub: key }, 60);
      outbox[key] = { token, dedupe: null, cycles: updated.cycles, attempts: 0, firstAt: new Date(now).toISOString() };
      await kv.put(WELCOME, JSON.stringify(outbox), { expirationTtl: 400 * DAY });
    }
  }
  return { ok: true, reason: "delivered", cycle: cyc };
}
export async function retryPendingPackages(env, fetchImpl = fetch, limit = 2, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  if (!kv?.get) return { ok: false };
  const pending = await readJson(kv, PENDING, []);
  // G2: itens cancelados, sem briefing, apagados ou já entregues saem da fila sem gastar o limite; quem falhou vai
  // para o fim (rodízio), para um assinante com falha persistente não travar os outros.
  const failed = [], results = [];
  for (const key of pending) {
    const rec = await readJson(kv, key, null);
    const why = !rec ? "record_missing" : rec.status !== "active" ? "inactive" : !rec.briefing ? "no_briefing" : campaignTarget(rec) === null ? "already_delivered" : needsForm(rec) ? "campaign_required" : "";
    if (why) { await leavePending(kv, key, "dropped", why, now); continue; } // registrado, nunca em silêncio
    const meta = (await readJson(kv, PENDING_META, {}))[key];
    if (Number(meta?.attempts || 0) >= PENDING_MAX_ATTEMPTS) { await deadLetter(env, kv, key, meta, fetchImpl, now); continue; }
    if (results.length >= limit) continue;
    let r;
    try { r = await generateAndDeliver(env, key, fetchImpl, { now }); }
    catch (e) {
      // H1: uma exceção (ex.: KV 429 que persistiu, fila cheia) não derruba o cron nem os outros itens; conta como
      // tentativa (o item chega ao limite e à fila de falhas), fica no log e o proprietário é avisado na primeira vez.
      const reason = "exception:" + String(e?.message || e).replace(/\s+/g, " ").slice(0, 60);
      r = { ok: false, reason };
      try {
        await notePendingFailure(kv, key, reason, now);
        await pendingLog(kv, key, "exception", reason, now);
        await releaseLease(kv, key);
        const meta = await readJson(kv, PENDING_META, {});
        const first = !meta[key]?.exceptionAlerted; // um alerta por item; o dead-letter avisa no fim
        if (first && meta[key]) { meta[key].exceptionAlerted = true; await kv.put(PENDING_META, JSON.stringify(meta), { expirationTtl: 400 * DAY }); }
        if (first) await ownerAlert(env, "erro na entrega do Conteúdo Pronto", `Uma tentativa de entrega terminou em erro (${reason}; assinante …${String(key).slice(-12)}). As tentativas automáticas continuam a cada hora, até ${PENDING_MAX_ATTEMPTS}.`, fetchImpl, { kind: "erro_entrega", sub: key, now });
      } catch {}
    }
    results.push(r);
    if (!r.ok) failed.push(key);
  }
  const cur = await readJson(kv, PENDING, []);
  const next = [...cur.filter((k) => !failed.includes(k)), ...failed.filter((k) => cur.includes(k))];
  if (JSON.stringify(next) !== JSON.stringify(cur)) await kv.put(PENDING, JSON.stringify(next));
  // Fila parada: o item mais antigo está há mais de PENDING_STALL_HOURS sem entrega => alerta (no máximo 1 por dia).
  const metaNow = await readJson(kv, PENDING_META, {});
  const oldest = Math.min(...next.map((k) => Date.parse(metaNow[k]?.firstAt || new Date(now).toISOString())));
  if (next.length && now - oldest > PENDING_STALL_HOURS * 3600000) {
    const last = Date.parse(String(await kv.get(STALL_ALERT) || "")) || 0;
    if (now - last > DAY * 1000) {
      await kv.put(STALL_ALERT, new Date(now).toISOString(), { expirationTtl: 30 * DAY });
      await ownerAlert(env, "fila do Conteúdo Pronto parada", `${next.length} pacote(s) pendente(s); o mais antigo espera há ${Math.round((now - oldest) / 3600000)} h. As tentativas automáticas continuam (máximo ${PENDING_MAX_ATTEMPTS} por assinante).`, fetchImpl, { kind: "fila_parada", now }).catch(() => null);
    }
  }
  const deliveryCheck = await confirmPackageDeliveries(env, fetchImpl, { now }).catch(() => ({ confirmed: 0, failed: 0 }));
  // Mesmo cron: candidatos de regeneração (nova tentativa com a mesma chave; confirmação de entrega pelo email_id).
  const regen = await reconcileRegenCandidates(env, fetchImpl).catch(() => ({ ok: false }));
  const welcome = await retryWelcomeEmails(env, fetchImpl, { now }).catch(() => ({ tried: 0 }));
  const reminders = await remindPendingForms(env, fetchImpl, { now }).catch(() => ({ reminders: 0 }));
  await checkOverdueRefunds(env, fetchImpl, { now }).catch(() => null);
  return { ok: true, tried: results.length + Number(regen.tried || 0) + Number(welcome.tried || 0), delivered: results.filter((r) => r.ok).length, regen, welcome, deliveryCheck, reminders };
}
// ---------- Regeneração de pacote bloqueado (critério de aceite Sol #898) ----------
// Estados do PACOTE (separados dos estados de ENTREGA):
//   bloqueado — o pacote antigo contaminado: imutável, nunca exibido, nunca reenviado, nunca volta a ser atual;
//   candidato — a versão nova válida, imutável (candidate_key nova, hash SHA-256, protocolo, email_id e estado de
//               entrega próprio); UM candidato ativo por pacote bloqueado + ciclo + versão de schema (chave
//               determinística), reaproveitado em toda tentativa com a MESMA Idempotency-Key;
//   atual     — record.lastPackage. O candidato só vira atual com entrega CONFIRMADA: evento `delivered` obtido
//               do Resend pelo MESMO email_id (reconciliação no cron, reconcileRegenCandidates; o projeto ainda
//               não tem webhook assinado de eventos de envio — o de suporte@ só aceita email.received).
// Entrega: pending -> accepted -> delivered, ou pending/accepted -> dead.
//   pending  : candidato e outbox gravados ANTES de qualquer envio. Falha de rede, tempo esgotado, 429, 5xx, 2xx
//              sem id ou envio não configurado => continua pending (202), cron tenta de novo com a mesma chave.
//   accepted : 2xx + id do Resend. NÃO promove e NÃO registra delivery_sent: 2xx só diz que o envio foi aceito
//              (HTTP 202 ao cliente, como pending: entrega ainda não confirmada).
//   delivered: last_event delivered, ou evento posterior que prova a entrega (opened/clicked/complained)
//              ("email.delivered: Resend handed the email off to the recipient's mail server"). Promove UMA vez
//              (evento duplicado não promove nem notifica de novo).
//   dead     : 4xx permanente (mesma regra de worker/atendimento.mjs, PR #892), last_event bounced/failed/
//              suppressed/canceled, janela de 23 h da Idempotency-Key esgotada em pending ou 72 h sem confirmação
//              em accepted => alerta ao proprietário. Candidato dead nunca vira atual sem uma operação nova
//              registrada (reopenDeadRegenCandidate, com operador e motivo).
// Resend: Idempotency-Key até 256 caracteres, retida 24 h; mesma chave + mesmo payload => resposta original sem
// reenviar; payload diferente => 409 invalid_idempotent_request (https://resend.com/docs/dashboard/emails/idempotency-keys).
// Por isso destinatário, assunto e texto ficam gravados no candidato. Consulta: GET https://api.resend.com/emails/{id}
// devolve last_event (https://resend.com/docs/api-reference/emails/retrieve-email); eventos em
// https://resend.com/docs/dashboard/webhooks/event-types.
// Queda entre o envio e a gravação do estado: a nova tentativa repete chave + payload e o Resend devolve o mesmo id
// sem enviar outro e-mail; queda entre "delivered" e a promoção: a reconciliação seguinte promove (converge).
export const REGEN_SEND_WINDOW_HOURS = 23;
export const REGEN_ACCEPTED_MAX_HOURS = 72;
const REGEN = "zpc:cp:regen:";               // candidato (estado de entrega) por pacote bloqueado + ciclo + schema
const REGEN_OUTBOX = "zpc:cp:regen-outbox";  // candidatos pending/accepted para o cron
const RESEND_URL = "https://api.resend.com/emails";
const DELIVERED_EVENTS = new Set(["delivered", "opened", "clicked", "complained"]);
const DEAD_EVENTS = new Set(["bounced", "failed", "suppressed", "canceled"]);
export const REGEN_MSG = Object.freeze({
  delivered: "Pronto! A entrega da versão nova foi confirmada no seu e-mail.",
  accepted: "A versão nova foi gerada e o provedor aceitou o envio. A entrega ao seu e-mail ainda está sendo confirmada.",
  pending: (p) => `A versão nova foi gerada, mas o envio ainda está pendente. Continuaremos tentando sem gerar outra cópia nem fazer qualquer cobrança. Use o protocolo ${p} para acompanhar pelo suporte.`,
  persist: "Não foi possível registrar a regeneração com segurança agora. A versão antiga continua bloqueada e não foi exibida nem alterada. Tente novamente mais tarde ou escreva para suporte@zevanory.api.br. Nenhuma nova entrega foi confirmada.",
  dead: (p) => `Não foi possível concluir o envio da versão nova. A versão antiga continua bloqueada e não foi exibida nem alterada, e a equipe da ZEVANORY foi avisada. Use o protocolo ${p} para acompanhar pelo suporte.`,
});
const putJson = (kv, k, v) => kv.put(k, JSON.stringify(v), { expirationTtl: 400 * DAY });
export async function regenCandidateKey(key, record) {
  return REGEN + (await sha(key + "|" + record.lastPackage + "|" + record.cycles + "|v" + CONTENT_SCHEMA_VERSION)).slice(0, 40);
}
async function resendIdempotent(env, { to, subject, text, idempotencyKey }, fetchImpl) {
  if (!env.RESEND_API_KEY || !to) return { ok: false, transient: true, reason: "resend_not_configured" };
  try {
    const r = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + String(env.RESEND_API_KEY), "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: "suporte@zevanory.api.br", subject, text, html: brandedEmailHtml(text) }),
      signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.ok && data?.id) return { ok: true, id: String(data.id) };
    if (r.ok) return { ok: false, transient: true, reason: "resend_no_id" };
    // Mesma classificação de worker/atendimento.mjs (#892): 408/429/5xx/rede e 409 concurrent_idempotent_requests
    // (outro pedido com a mesma chave em andamento, ex.: clique duplo) são temporários; 409 de outro nome é permanente.
    return { ok: false, transient: resendFailureIsTransient(r.status, data), reason: "resend_" + r.status };
  } catch { return { ok: false, transient: true, reason: "resend_network" }; }
}
async function resendLastEvent(env, emailId, fetchImpl) {
  if (!env.RESEND_API_KEY || !emailId) return null;
  try {
    const r = await fetchImpl(RESEND_URL + "/" + encodeURIComponent(emailId), { method: "GET", headers: { authorization: "Bearer " + String(env.RESEND_API_KEY) }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data && String(data.id || "") === String(emailId) ? String(data.last_event || "") : null;
  } catch { return null; }
}
async function outboxAdd(kv, candKey) {
  const list = await readJson(kv, REGEN_OUTBOX, []);
  if (!list.includes(candKey)) await kv.put(REGEN_OUTBOX, JSON.stringify([...list, candKey].slice(-500)));
}
async function outboxRemove(kv, candKey) {
  const list = await readJson(kv, REGEN_OUTBOX, []);
  if (list.includes(candKey)) await kv.put(REGEN_OUTBOX, JSON.stringify(list.filter((k) => k !== candKey)));
}
async function markDead(env, kv, candKey, cand, reason, fetchImpl) {
  const dead = { ...cand, delivery: "dead", deadReason: reason, deadAt: new Date().toISOString() };
  await putJson(kv, candKey, dead);
  await outboxRemove(kv, candKey).catch(() => null);
  await ownerAlert(env, "regeneração do Conteúdo Pronto sem entrega", `Protocolo ${cand.protocolo}: o envio da versão nova terminou em dead (${reason}). O pacote antigo continua bloqueado e nada foi promovido. Tratar manualmente; reabrir só com operação registrada (reopenDeadRegenCandidate).`, fetchImpl).catch(() => null);
  return dead;
}
// Uma tentativa de envio de um candidato pending (página ou cron).
async function attemptSend(env, kv, candKey, cand, fetchImpl, now) {
  if (!(now - Date.parse(cand.firstAttemptAt) < REGEN_SEND_WINDOW_HOURS * 3600000)) return markDead(env, kv, candKey, cand, "window_expired", fetchImpl);
  const r = await resendIdempotent(env, { to: cand.to, subject: cand.subject, text: cand.text, idempotencyKey: cand.idempotencyKey }, fetchImpl);
  if (r.ok) {
    const accepted = { ...cand, delivery: "accepted", email_id: r.id, acceptedAt: new Date(now).toISOString(), attempts: Number(cand.attempts || 0) + 1, lastError: null };
    await putJson(kv, candKey, accepted);
    return accepted;
  }
  if (!r.transient) return markDead(env, kv, candKey, { ...cand, attempts: Number(cand.attempts || 0) + 1, lastError: r.reason }, r.reason, fetchImpl);
  const pending = { ...cand, attempts: Number(cand.attempts || 0) + 1, lastError: r.reason };
  await putJson(kv, candKey, pending);
  return pending;
}
// Entrega confirmada pelo MESMO email_id: promove uma única vez; dead nunca promove; duplicado não promove nem notifica.
export async function applyRegenDelivered(env, candKey, emailId, fetchImpl = fetch) {
  const kv = kvOf(env);
  const cand = await readJson(kv, candKey, null);
  if (!cand || !cand.email_id || String(emailId) !== String(cand.email_id)) return { promoted: false, reason: "unknown_email_id" };
  if (cand.delivery === "dead") return { promoted: false, reason: "dead_not_promoted" };
  if (cand.delivery === "delivered" && cand.promotedAt) return { promoted: false, reason: "duplicate" };
  let c = cand;
  if (c.delivery !== "delivered") { c = { ...c, delivery: "delivered", deliveredAt: new Date().toISOString() }; await putJson(kv, candKey, c); }
  const record = await readJson(kv, cand.sub, null);
  const notify = () => emitActivity(env, { type: "delivery_sent", channel: "email", status: "service_package_regenerated", ref: "cp-regen:" + cand.protocolo }).catch(() => null);
  if (record?.lastPackage === cand.candidate_key) {
    // Queda depois da promoção e antes de fechar o candidato: converge sem nova promoção (o ledger deduplica a ref).
    await notify();
    await putJson(kv, candKey, { ...c, promotedAt: record.regeneratedAt || new Date().toISOString() });
    await outboxRemove(kv, candKey);
    return { promoted: false, reason: "already_promoted" };
  }
  if (!record || record.lastPackage !== cand.blockedPackage || record.cycles !== cand.cycle) {
    await putJson(kv, candKey, { ...c, promotedAt: null, superseded: true });
    await outboxRemove(kv, candKey);
    return { promoted: false, reason: "superseded" };
  }
  const stored = await kv.get(cand.candidate_key);
  if (!stored || (await sha(stored)) !== cand.hash) { await markDead(env, kv, candKey, c, "candidate_hash_mismatch", fetchImpl); return { promoted: false, reason: "candidate_hash_mismatch" }; }
  const at = new Date().toISOString();
  await putJson(kv, cand.sub, { ...record, lastPackage: cand.candidate_key, blockedPackage: cand.blockedPackage, regeneratedAt: at, regenProtocolo: cand.protocolo, regenEmailId: cand.email_id });
  await notify();
  await putJson(kv, candKey, { ...c, promotedAt: at });
  await outboxRemove(kv, candKey);
  return { promoted: true, reason: "delivered" };
}
// Reconciliação (cron): pending => nova tentativa com a mesma chave; accepted => consulta pelo email_id.
export async function reconcileRegenCandidates(env, fetchImpl = fetch, { limit = 10, now = Date.now() } = {}) {
  const kv = kvOf(env);
  if (!kv?.get) return { ok: false };
  const out = { ok: true, tried: 0, promoted: 0, accepted: 0, dead: 0, pending: 0 };
  for (const candKey of (await readJson(kv, REGEN_OUTBOX, [])).slice(0, limit)) {
    out.tried++;
    const cand = await readJson(kv, candKey, null);
    if (!cand || cand.delivery === "dead" || cand.promotedAt || cand.superseded) { await outboxRemove(kv, candKey); continue; }
    if (cand.delivery === "pending") { const c = await attemptSend(env, kv, candKey, cand, fetchImpl, now); out[c.delivery === "dead" ? "dead" : c.delivery === "accepted" ? "accepted" : "pending"]++; continue; }
    if (cand.delivery === "delivered") { if ((await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl)).promoted) out.promoted++; continue; }
    const ev = await resendLastEvent(env, cand.email_id, fetchImpl);
    if (ev && DELIVERED_EVENTS.has(ev)) { if ((await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl)).promoted) out.promoted++; }
    else if (ev && DEAD_EVENTS.has(ev)) { await markDead(env, kv, candKey, cand, "resend_" + ev, fetchImpl); out.dead++; }
    else if (!(now - Date.parse(cand.acceptedAt) < REGEN_ACCEPTED_MAX_HOURS * 3600000)) { await markDead(env, kv, candKey, cand, "delivery_unconfirmed", fetchImpl); out.dead++; }
    else out.accepted++;
  }
  return out;
}
// Operação explícita e registrada para reabrir um candidato dead (nova Idempotency-Key, mesmo pacote imutável).
export async function reopenDeadRegenCandidate(env, candKey, { operator, reason, now = Date.now() } = {}) {
  const kv = kvOf(env);
  const cand = await readJson(kv, candKey, null);
  if (!cand || cand.delivery !== "dead") return { ok: false, reason: "not_dead" };
  if (!String(operator || "").trim() || !String(reason || "").trim()) return { ok: false, reason: "operation_must_be_recorded" };
  const operations = [...(cand.operations || []), { at: new Date(now).toISOString(), op: "reopen", operator: String(operator).slice(0, 80), reason: String(reason).slice(0, 300), previous: { idempotencyKey: cand.idempotencyKey, email_id: cand.email_id || null, deadReason: cand.deadReason } }];
  const reopened = { ...cand, delivery: "pending", email_id: null, deadReason: null, idempotencyKey: cand.baseIdempotencyKey + "/op" + operations.length, firstAttemptAt: new Date(now).toISOString(), attempts: 0, operations };
  await putJson(kv, candKey, reopened);
  await outboxAdd(kv, candKey);
  return { ok: true, idempotencyKey: reopened.idempotencyKey };
}
// Pedido do cliente (POST da página): cria ou reaproveita o candidato e faz UMA tentativa de envio.
export async function regenerateBlockedPackage(env, key, fetchImpl = fetch, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  const record = await readJson(kv, key, null);
  if (!record || record.status !== "active" || !record.briefing) return { ok: false, reason: "not_eligible" };
  const current = record.lastPackage ? await readJson(kv, record.lastPackage, null) : null;
  if (!current || !packageBlocked(current)) return { ok: true, reason: "not_blocked" };
  const candKey = await regenCandidateKey(key, record);
  let cand = await readJson(kv, candKey, null);
  if (!cand) {
    const h = candKey.slice(REGEN.length);
    const candidate_key = PKG + key.slice(SUB.length) + ":" + record.cycles + ":v" + CONTENT_SCHEMA_VERSION + ":c" + h.slice(0, 12);
    let stored = await kv.get(candidate_key);
    if (!stored) {
      if (record.campanha?.cycle !== record.cycles) return { ok: false, reason: "campaign_required" };
      const pkg = await generatePackage(env, record.briefing, record.cycles, record.campanha);
      if (!pkg || packageBlocked(pkg)) {
        await ownerAlert(env, "regeneração do Conteúdo Pronto adiada", "A IA não gerou um pacote válido para substituir um pacote antigo bloqueado; o assinante pode tentar de novo.", fetchImpl);
        return { ok: false, reason: "generation_failed" };
      }
      stored = JSON.stringify(pkg);
    }
    const protocolo = "CPR-" + h.slice(0, 10).toUpperCase();
    const baseIdempotencyKey = "cp-regen/" + h;
    try {
      const token = rand();
      const text = packageText(JSON.parse(stored), record.briefing.negocio) + `\n\nProtocolo: ${protocolo}\nVersão para consulta online (fica disponível assim que a entrega for confirmada): ${ORIGIN}/conteudo-pronto/pacote?t=${token}\n\nDúvidas ou ajustes: responda este e-mail ou escreva para suporte@zevanory.api.br.`;
      if (!(await kv.get(candidate_key))) await kv.put(candidate_key, stored, { expirationTtl: 400 * DAY });
      await putToken(kv, token, { k: "pkg", sub: key, pkg: candidate_key, cand: candKey }, 120);
      cand = { schema: "zpc.cp.regen.v1", sub: key, blockedPackage: record.lastPackage, cycle: record.cycles, content_schema_version: CONTENT_SCHEMA_VERSION,
        candidate_key, hash: await sha(stored), protocolo, baseIdempotencyKey, idempotencyKey: baseIdempotencyKey, email_id: null, delivery: "pending",
        to: record.email, subject: `Seu Conteúdo Pronto do mês ${record.cycles} — nova versão (protocolo ${protocolo})`, text,
        firstAttemptAt: new Date(now).toISOString(), attempts: 0, operations: [] };
      await putJson(kv, candKey, cand);
      await outboxAdd(kv, candKey);
    } catch { return { ok: false, reason: "persist_failed" }; }
  } else if (cand.delivery === "pending" || cand.delivery === "accepted") {
    try { await outboxAdd(kv, candKey); } catch { return { ok: false, reason: "persist_failed" }; }
  }
  if (cand.delivery === "delivered" && !cand.promotedAt) {
    await applyRegenDelivered(env, candKey, cand.email_id, fetchImpl); // converge uma promoção interrompida
  }
  if (cand.delivery === "pending") {
    try { cand = await attemptSend(env, kv, candKey, cand, fetchImpl, now); }
    catch { return { ok: false, reason: "persist_failed" }; }
  }
  return { ok: cand.delivery !== "dead", reason: cand.delivery, protocolo: cand.protocolo };
}
// Mensagem e status HTTP de cada estado: o 2xx do envio nunca vira afirmação de entrega (teste g7).
export function regenResponse(out) {
  if (out.reason === "delivered") return [200, REGEN_MSG.delivered];
  if (out.reason === "accepted") return [202, REGEN_MSG.accepted]; // aceito pelo provedor, entrega ainda não confirmada
  if (out.reason === "pending") return [202, REGEN_MSG.pending(out.protocolo)];
  if (out.reason === "dead") return [409, REGEN_MSG.dead(out.protocolo)];
  if (out.reason === "persist_failed") return [503, REGEN_MSG.persist];
  return [503, "Não foi possível gerar a versão nova agora. A versão antiga continua bloqueada e não foi exibida nem alterada. Tente novamente mais tarde ou escreva para suporte@zevanory.api.br."];
}
export async function handlePackageView(request, env, ctx, fetchImpl = fetch) {
  const kv = kvOf(env);
  const token = new URL(request.url).searchParams.get("t") || "";
  const found = kv?.get ? await resolveToken(kv, token, "pkg") : null;
  // G5: o token do e-mail abre o pacote daquele e-mail; o da versão nova só depois da entrega confirmada (antes disso
  // mostra o pacote atual, que é o bloqueado, com o estado da regeneração); token antigo segue o último pacote.
  let pkgKey = found?.record?.lastPackage || null;
  if (found?.token?.k === "pkg") {
    const cand = found.token.cand ? await readJson(kv, found.token.cand, null) : null;
    pkgKey = found.token.cand && !cand?.promotedAt ? found.record?.lastPackage : found.token.pkg;
  }
  const pkg = pkgKey && found?.record ? await readJson(kv, pkgKey, null) : null;
  if (!pkg) return page("Pacote não encontrado", "<h1>Pacote não encontrado ou link expirado.</h1>", 404);
  const eligible = found.record.status === "active" && Boolean(found.record.briefing);
  if (request.method === "POST") {
    if (!packageBlocked(pkg)) return page("Pacote atualizado", found.record.regenProtocolo ? `<h1>${esc(REGEN_MSG.delivered)}</h1>` : "<h1>Este pacote já está no formato atual.</h1>");
    if (!eligible) return page("Versão nova", `<h1>Versão nova sem custo</h1><p>${esc(BLOQUEIO_TEXTO)}</p><p>Peça em suporte@zevanory.api.br.</p>`, 409);
    const [status, msg] = regenResponse(await regenerateBlockedPackage(env, found.key, fetchImpl));
    return page("Versão nova", `<h1>Conteúdo Pronto · versão nova</h1><p>${esc(msg)}</p>`, status);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return page("Método inválido", "<h1>Método inválido.</h1>", 405);
  if (packageBlocked(pkg)) {
    const cand = eligible ? await readJson(kv, await regenCandidateKey(found.key, found.record), null) : null;
    const button = `<form method="post" action="?t=${esc(token)}"><input type="hidden" name="acao" value="regenerar"><button type="submit">Gerar versão nova sem custo</button></form>`;
    const offer = !eligible ? "<p>Para receber a versão nova sem custo, escreva para suporte@zevanory.api.br.</p>"
      : !cand ? button
      : `<p>${esc(regenResponse({ reason: cand.delivery, protocolo: cand.protocolo })[1])}</p>${cand.delivery === "pending" ? button : ""}`;
    return page("Pacote no formato anterior", `<h1>Conteúdo Pronto · mês ${esc(pkg.cycle)}</h1><p>${esc(BLOQUEIO_TEXTO)}</p>${offer}`);
  }
  const posts = pkg.posts.map((p, i) => `<article><h2>Post ${i + 1} — ${esc(p.tema)}</h2><p style="white-space:pre-wrap">${esc(p.legenda)}</p><p><b>Chamada:</b> ${esc(p.cta)}</p><p>${esc(p.hashtags.join(" "))}</p><small>Imagem sugerida: ${esc(p.imagem)}</small></article>`).join("");
  const rots = roteirosOf(pkg).map((r, i) => `<article><h2>Roteiro ${i + 1} — ${esc(r.objetivo)}</h2><h3>Versão curta</h3><p style="white-space:pre-wrap">${esc(r.curta)}</p>${r.email ? `<h3>Versão de e-mail</h3><p><b>Assunto:</b> ${esc(r.email.assunto)}</p><p style="white-space:pre-wrap">${esc(r.email.corpo)}</p>` : ""}</article>`).join("");
  const br = (iso) => iso ? iso.split("-").reverse().join("/") : "";
  const cal = pkg.calendario.map((c) => `<li>${c.data ? esc(br(c.data)) : "Dia " + c.dia} · ${calLabel(c.tipo)}${c.fase ? " · " + esc((FASES.find((f) => f.id === c.fase) || {}).titulo || c.fase) : ""} · ${esc(c.tema)}</li>`).join("");
  const camp = pkg.campanha ? `<h2>Campanha do mês</h2><ul><li><b>Objetivo comercial:</b> ${esc(pkg.campanha.objetivo_comercial)}</li><li><b>Oferta promovida:</b> ${esc(pkg.campanha.oferta)}</li><li><b>Condição comercial:</b> ${esc(pkg.campanha.condicao_comercial)}</li><li><b>Período:</b> ${esc(br(pkg.campanha.periodo_inicio))} a ${esc(br(pkg.campanha.periodo_fim))}</li></ul>` : "";
  const rc = found.record.deliveries?.[pkg.cycle];
  const receipt = rc ? `<p><small>Recibo de entrega: protocolo ${esc(rc.protocolo)} · enviado em ${esc(rc.sentAt)} · ${rc.status === "confirmed" ? "entrega confirmada pelo provedor de e-mail em " + esc(rc.confirmedAt) : rc.status === "failed" ? "o provedor de e-mail não entregou; a equipe foi avisada" : "aguardando confirmação do provedor de e-mail"} · SHA-256 ${esc(rc.sha256)}</small></p>` : "";
  return page("Seu pacote", `<h1>Conteúdo Pronto · mês ${pkg.cycle}</h1>${receipt}${camp}<h2>Calendário</h2><ul>${cal}</ul><h2>${pkg.posts.length} posts</h2>${posts}<h2>${esc(ROTEIROS_TITULO.charAt(0) + ROTEIROS_TITULO.slice(1).toLowerCase())}</h2><p>${esc(ROTEIROS_AVISO)}</p>${rots}`);
}

// ---------- Operação (auditoria #953 M1/M2) ----------
// GET  /api/admin/conteudo-pronto/status  -> fila, tentativas, fila de falhas, boas-vindas pendentes, alertas e log
// POST /api/admin/conteudo-pronto/requeue -> {sub, operator, reason}: reenvio de um item da fila de falhas
// A autenticação (token de operador) é feita pelo Worker antes de chamar esta função; aqui não há segredo. As respostas
// não têm e-mail nem nome: o assinante aparece pelos 12 últimos caracteres da chave.
export async function handleContentOperator(request, env, { now = Date.now() } = {}) {
  const kv = kvOf(env);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const out = (status, body) => new Response(JSON.stringify(body), { status, headers });
  if (!kv?.get) return out(503, { error: "secure_store_unavailable" });
  const path = new URL(request.url).pathname;
  const tail = (k) => String(k).slice(-12);
  if (path === "/api/admin/conteudo-pronto/status" && request.method === "GET") {
    const [pending, meta, dead, welcome, alerts, log, formWait, creditIdx, refunds] = await Promise.all([readJson(kv, PENDING, []), readJson(kv, PENDING_META, {}), readJson(kv, PENDING_DEAD, {}), readJson(kv, WELCOME, {}), readJson(kv, ALERTS, []), readJson(kv, PENDING_LOG, []), readJson(kv, FORM_WAIT, {}), readJson(kv, CREDIT_INDEX, {}), readJson(kv, REFUNDS, [])]);
    return out(200, {
      pending: pending.map((k) => ({ sub: tail(k), attempts: Number(meta[k]?.attempts || 0), lastReason: meta[k]?.lastReason || null, firstAt: meta[k]?.firstAt || null })),
      dead: Object.entries(dead).map(([k, d]) => ({ sub: tail(k), kind: d.kind || "package", status: d.status, attempts: d.attempts ?? null, lastReason: d.lastReason || null, provider_event: d.provider_event || null, cycle: d.cycle ?? null, protocolo: d.protocolo || null, deadAt: d.deadAt, operations: (d.operations || []).length })),
      forms_waiting: Object.entries(formWait).map(([k, w]) => ({ sub: tail(k), cycle: w.cycle, requestedAt: w.requestedAt, reminders: w.sent || [] })),
      credits: Object.entries(creditIdx).map(([k, cycles]) => ({ sub: tail(k), cycles })), credits_max: CREDITOS_MAX,
      refund_requests: refunds.slice(-100).map(({ key: _k, ...r }) => r), refund_overdue_days: REEMBOLSO_ALERTA_DIAS,
      welcome: Object.entries(welcome).map(([k, w]) => ({ sub: tail(k), attempts: Number(w.attempts || 0), lastReason: w.lastReason || null, firstAt: w.firstAt || null })),
      alerts: alerts.slice(-50), log: log.slice(-50), max_attempts: PENDING_MAX_ATTEMPTS,
    });
  }
  // POST /api/admin/conteudo-pronto/refund-request -> {sub, cycle, operator, reason}: o assinante pediu ao suporte o
  // reembolso de um mês pago sem pacote. Registra, tira o mês dos pendentes (não gera mais) e avisa o proprietário, que faz o
  // estorno na Hotmart. Nada de dinheiro é movido aqui.
  if (path === "/api/admin/conteudo-pronto/refund-request" && request.method === "POST") {
    let body = null; try { body = await request.json(); } catch { return out(400, { error: "invalid_json" }); }
    const sub = String(body?.sub || ""), operator = String(body?.operator || "").trim(), reason = String(body?.reason || "").trim();
    if (!operator || reason.length < 10) return out(400, { ok: false, reason: "operator_and_reason_required" });
    const keys = sub.startsWith(SUB) ? [sub] : sub.length === 12 ? ((await kv.list({ prefix: SUB }))?.keys || []).map((k) => k.name).filter((k) => tail(k) === sub) : [];
    if (keys.length !== 1) return out(404, { ok: false, reason: keys.length ? "ambiguous_sub" : "not_found" });
    const rec = await readJson(kv, keys[0], null);
    const cycle = Number(body?.cycle);
    if (!rec || !pendingCycles(rec).includes(cycle)) return out(400, { ok: false, reason: "cycle_not_refundable" });
    const latest = (await readJson(kv, keys[0], null)) || rec;
    if (!pendingCycles(latest).includes(cycle)) return out(409, { ok: false, reason: "cycle_changed" }); // outro escritor chegou antes
    const updated = { ...latest, refundRequests: [...(latest.refundRequests || []), { cycle, reason: "pedido_do_assinante", operator: operator.slice(0, 60), at: new Date(now).toISOString(), status: "requested" }] };
    await kv.put(keys[0], JSON.stringify(updated), { expirationTtl: 400 * DAY });
    await syncCreditIndex(kv, keys[0], updated);
    await recordRefundRequests(env, kv, keys[0], [cycle], "pedido_do_assinante", { operator, note: reason, now });
    return out(200, { ok: true, cycle });
  }
  // POST /api/admin/conteudo-pronto/refund-processed -> {sub, cycle, operator, reason}: o proprietário estornou na Hotmart.
  if (path === "/api/admin/conteudo-pronto/refund-processed" && request.method === "POST") {
    let body = null; try { body = await request.json(); } catch { return out(400, { error: "invalid_json" }); }
    const sub = String(body?.sub || ""), operator = String(body?.operator || "").trim(), reason = String(body?.reason || "").trim(), cycle = Number(body?.cycle);
    if (!operator || reason.length < 10) return out(400, { ok: false, reason: "operator_and_reason_required" });
    const keys = sub.startsWith(SUB) ? [sub] : sub.length === 12 ? ((await kv.list({ prefix: SUB }))?.keys || []).map((k) => k.name).filter((k) => tail(k) === sub) : [];
    if (keys.length !== 1) return out(404, { ok: false, reason: keys.length ? "ambiguous_sub" : "not_found" });
    const latest = await readJson(kv, keys[0], null);
    const reqs = (latest?.refundRequests || []).map((r) => ({ ...r }));
    const open = reqs.find((r) => Number(r.cycle) === cycle && r.status !== "processed");
    if (!open) return out(400, { ok: false, reason: "no_open_request" });
    Object.assign(open, { status: "processed", processedAt: new Date(now).toISOString(), processedBy: operator.slice(0, 60) });
    await kv.put(keys[0], JSON.stringify({ ...latest, refundRequests: reqs }), { expirationTtl: 400 * DAY });
    await markRefundProcessed(kv, keys[0], cycle, operator, reason, now);
    return out(200, { ok: true, cycle });
  }
  if (path === "/api/admin/conteudo-pronto/requeue" && request.method === "POST") {
    let body = null; try { body = await request.json(); } catch { return out(400, { error: "invalid_json" }); }
    const sub = String(body?.sub || "");
    const dead = await readJson(kv, PENDING_DEAD, {});
    const keys = Object.keys(dead).filter((k) => k === sub || (sub.length === 12 && tail(k) === sub));
    if (keys.length !== 1) return out(404, { error: keys.length ? "ambiguous_sub" : "not_dead" });
    const r = await requeueDeadPackage(env, keys[0], { operator: body?.operator, reason: body?.reason, newEmail: body?.new_email || "", now });
    return out(r.ok ? 200 : 400, r);
  }
  return out(404, { error: "not_found" });
}
