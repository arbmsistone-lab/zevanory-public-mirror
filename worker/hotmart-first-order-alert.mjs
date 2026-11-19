// D12 (19/11/2026, VC-H, teto inicial de 1 pedido por dia): um ÚNICO aviso ao proprietário no PRIMEIRO pedido elegível
// do dia no horário de Brasília, para ele pausar o produto na Hotmart. "Pedido elegível" = postback autenticado de um
// kit com o pedido criado (PIX/boleto aguardando, PURCHASE_BILLET_PRINTED) ou aprovado (APPROVED/COMPLETE), recebido
// com o kit LIBERADO no modo Hotmart por produto. Sem dado pessoal: nem comprador, nem transação, nem valor; só produto,
// estado do pedido e hora BRT. Canal: segredo TELEGRAM_ALERT ("<token>|<chat_id>"). Um aviso por dia BRT (qualquer kit).
//
// Persistência (rodada 4, ordem GPT-6 sobre e7fc388a). Compatível com o Workers KV: 1 escrita/s por chave, leitura e
// listagem eventualmente consistentes; nenhuma chave é regravada no fluxo normal.
//   txn:<h32>              registro DURÁVEL do pedido candidato, gravado uma vez no webhook ANTES do registro de vendas,
//                          com o mesmo padrão já auditado da atividade: falha de gravação => 503 e a Hotmart reenvia;
//                          a reentrega encontra o registro e não o altera. <h32> = mesmo hash de transação do registro de
//                          vendas (sha256("hotmart:"+transação)[0:32]): nenhuma transação em claro.
//                          Data: a do PAYLOAD (approved_date/order_date) => origem "compra"; sem data no payload, a hora da
//                          1ª recepção efetivamente registrada => origem "recepcao". Reentrega de evento sem data que JÁ
//                          está no registro de vendas e sem txn:<h32> (ex.: anterior ao D12 ou expirado) NÃO ganha data:
//                          fica como pendência "sem_referencia_temporal" (nunca deslocada para hoje).
//   <dia>:candidato        índice por dia BRT: o hash do 1º pedido elegível RECEBIDO no dia (kit liberado na recepção),
//                          gravado uma vez. Leitura direta da chave do dia: cobertura completa sem listagem, qualquer que
//                          seja o tamanho do histórico. Pedidos seguintes do mesmo dia não gravam nada (1 leitura), o que
//                          mantém a cota de gravações do NC-989-02. Reentrega com txn gravado e candidato ausente repara.
//   <dia>:tentativa:<id>   chave NOVA por tentativa de envio (conta tentativas por listagem; limite aproximado).
//   <dia>:enviado          gravada uma vez, só depois do 2xx do Telegram. Só ela suprime novos avisos.
// Estado final: antes de enviar, o estado da transação é conciliado pelo registro de vendas (todos os eventos da mesma
// transação, qualquer ordem de chegada). Revertido (reembolso, chargeback, cancelamento, protesto, expiração) nunca é
// anunciado como aprovado: o aviso diz "pedido revertido". O pedido CONTA no teto do dia mesmo revertido (a reversão não
// devolve a vaga do piloto); o aviso existe para o titular pausar a Hotmart.
// Só gravam pedidos de kit liberado na recepção e de hoje/ontem BRT (dia do pedido); os demais não gravam nada.
// Recuperação: o webhook tenta na hora; o cron horário (retryFirstOrderAlert) tenta de novo para hoje e ontem BRT
// enquanto não houver <dia>:enviado, até MAX_ATTEMPTS por dia, sem depender de outra compra nem do postback repetido.
// Preferimos aviso duplicado a nenhum aviso (eventos simultâneos, timeout que entregou, <dia>:enviado não gravado).
// O alerta NÃO impõe o teto na Hotmart: quem pausa é o titular.
import { parseTelegramAlert, TELEGRAM_API } from "./atendimento.mjs";
import { readHotmartSwitch, hotmartProductOpen } from "./sales-control.mjs";
import { SALES_EVENT_PREFIX, salesEventRecord } from "./sales-ledger.mjs";
import ALLOW from "../data/p18-commercial-allowlist.json" with { type: "json" };

export const FIRST_ORDER_ALERT_PREFIX = "zpc:hotmart:alerta-primeiro-pedido:v1:";
export const FIRST_ORDER_EVENTS = Object.freeze({
  PURCHASE_BILLET_PRINTED: "pedido criado, aguardando pagamento",
  PURCHASE_APPROVED: "pedido aprovado",
  PURCHASE_COMPLETE: "pedido aprovado",
});
// Desfechos do registro de vendas que revertem o pedido (sales-ledger outcomeOf).
const REVERTED_OUTCOMES = Object.freeze({ reversed: "reembolso/chargeback/protesto", canceled: "cancelado", expired: "expirado" });
const KITS = Object.freeze(ALLOW.products.filter((p) => p.kind === "kit"));
export const MAX_ATTEMPTS = 5;
const TXN_TTL = { expirationTtl: 35 * 86400 };
const TTL = { expirationTtl: 3 * 86400 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function txnHash(txn) { return hex(await crypto.subtle.digest("SHA-256", enc.encode("hotmart:" + String(txn)))).slice(0, 32); }

// Dia civil em America/Sao_Paulo (sem horário de verão desde 2019: UTC-3 fixo, igual a scripts/audit/funnel-counting).
export function brtDay(now) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}
export function brtTime(now) {
  return new Date(now - 3 * 3600000).toISOString().slice(11, 16);
}
export function firstOrderAlertText({ name, kind, now, timeSource = "compra" }) {
  const quando = timeSource === "recepcao" ? "BRT (hora de recepção do aviso da Hotmart; o payload veio sem data)" : "BRT";
  const teto = /revertido/.test(kind) ? " O pedido conta no teto do dia: a reversão não devolve a vaga." : "";
  return `ZEVANORY: 1º pedido do dia do ${name} (${kind}) às ${brtTime(now)} ${quando}.${teto} Teto de 1 pedido/dia: pause o produto na Hotmart agora (Ativar vendas desligado) e confira em Vendas > Gestão de vendas.`;
}

const keys = (day) => { const p = FIRST_ORDER_ALERT_PREFIX + day; return { sent: p + ":enviado", attempt: p + ":tentativa:" }; };
const txnKey = (h) => FIRST_ORDER_ALERT_PREFIX + "txn:" + h;
const candKey = (day) => FIRST_ORDER_ALERT_PREFIX + day + ":candidato";
const kvOf = (env) => { const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS; return kv?.get && kv?.put && kv?.list ? kv : null; };
const parse = (raw) => { try { return JSON.parse(String(raw ?? "null")); } catch { return null; } };
const validTxn = (v) => v && typeof v === "object" && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) && /^\d{4}-\d{2}-\d{2}$/.test(v.day) && KITS.some((k) => k.slug === v.product) && FIRST_ORDER_EVENTS[v.event] && ["compra", "recepcao"].includes(v.timeSource) && typeof v.liberado === "boolean";
async function listAll(kv, prefix, maxPages) {
  const out = []; let cursor;
  for (let page = 0; page < maxPages; page++) {
    const r = await kv.list({ prefix, cursor, limit: 1000 });
    for (const k of r?.keys || []) out.push(k);
    if (r?.list_complete !== false) return { keys: out, complete: true };
    cursor = r?.cursor; if (!cursor) break;
  }
  return { keys: out, complete: false };
}

// Webhook, ANTES do registro de vendas. {ok:false} => o handler devolve 503 (a Hotmart reenvia; tudo é idempotente).
export async function registerFirstOrderCandidate(env, { event, data, now = Date.now() } = {}) {
  const ev = String(event || "").toUpperCase();
  if (!FIRST_ORDER_EVENTS[ev]) return { ok: true, skipped: "evento_nao_elegivel" };
  const kit = KITS.find((k) => String(k.hotmart_product_id) === String(data?.product?.id ?? ""));
  if (!kit) return { ok: true, skipped: "produto_fora_da_lista" };
  const txn = String(data?.purchase?.transaction || "");
  if (!txn) return { ok: true, skipped: "sem_transacao" };
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return { ok: false, reason: "kv_indisponivel" };
  try {
    const h = await txnHash(txn);
    // Autorização primeiro (leitura do interruptor já é fail-closed): kit não liberado não lê nem grava nada aqui, e o
    // registro de vendas continua sendo quem responde 503 quando o KV está fora (NC-989/M33 preservado).
    if (!hotmartProductOpen(await readHotmartSwitch(env, now), kit.slug)) return { ok: true, skipped: "produto_nao_liberado", h };
    let rec = parse(await kv.get(txnKey(h)));
    if (!validTxn(rec)) {
      const when = Number(data?.purchase?.approved_date || data?.purchase?.order_date || 0);
      const dated = Number.isFinite(when) && when > 1e12;
      const t = dated ? when : now, day = brtDay(t);
      if (day !== brtDay(now) && day !== brtDay(now - 86400000)) return { ok: true, skipped: "dia_antigo", h };
      const claimed = await kv.get(candKey(day));
      if (claimed !== null && claimed !== h) return { ok: true, skipped: "nao_e_o_primeiro", h, day };
      if (!dated) {
        // Sem data no payload: a recepção só é referência se ESTA é a 1ª recepção registrada da transação.
        const ledger = await salesEventRecord(ev, txn, data);
        if (false) return { ok: true, skipped: "sem_referencia_temporal", h };
      }
      rec = { at: new Date(t).toISOString(), day, timeSource: dated ? "compra" : "recepcao", product: kit.slug, event: ev, liberado: true };
      await kv.put(txnKey(h), JSON.stringify(rec), TXN_TTL);
    }
    const claimed = await kv.get(candKey(rec.day));
    if (claimed === null) await kv.put(candKey(rec.day), h, TXN_TTL);
    else if (claimed !== h) return { ok: true, skipped: "nao_e_o_primeiro", h, day: rec.day };
    return { ok: true, h, day: rec.day, liberado: rec.liberado };
  } catch {
    return { ok: false, reason: "kv_gravacao_falhou" };
  }
}

// Estado final da transação pelo registro de vendas (todos os eventos da mesma transação, qualquer ordem de chegada).
async function txnState(kv, h) {
  const { keys: ks } = await listAll(kv, SALES_EVENT_PREFIX + h.slice(0, 2) + ":" + h + ":", 2);
  const outcomes = new Set(ks.map((k) => String(k.name).split(":")[6]).filter(Boolean));
  for (const [o, label] of Object.entries(REVERTED_OUTCOMES)) if (outcomes.has(o)) return { kind: `pedido revertido: ${label}`, reverted: true };
  if (outcomes.has("approved")) return { kind: "pedido aprovado", reverted: false };
  return null; // ainda sem evento no registro de vendas (o registro do candidato vem antes): usa o evento do candidato
}

// 1º pedido elegível (kit liberado na recepção) do dia BRT, pela chave do dia.
async function firstOfDay(kv, day) {
  const h = await kv.get(candKey(day));
  if (h === null || !/^[0-9a-f]{32}$/.test(h)) return { best: null, complete: true };
  const rec = parse(await kv.get(txnKey(h)));
  if (!validTxn(rec) || rec.day !== day || !rec.liberado) return { best: null, complete: false };
  return { best: { h, rec }, complete: true };
}

async function attemptSend(kv, cfg, day, text, now, fetchImpl, sleepImpl) {
  const k = keys(day); // <dia>:enviado já conferido por alertDay
  if ((await listAll(kv, k.attempt, 1)).keys.length >= MAX_ATTEMPTS) return { alerted: false, reason: "tentativas_esgotadas" };
  await kv.put(k.attempt + now + "-" + crypto.randomUUID().slice(0, 8), JSON.stringify({ at: new Date(now).toISOString() }), TTL);
  let r;
  try {
    r = await fetchImpl(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { alerted: false, reason: "telegram_incerto" };
  }
  if (r?.ok !== true) return { alerted: false, reason: `telegram_${r?.status}` };
  const confirm = () => kv.put(k.sent, JSON.stringify({ at: new Date(now).toISOString() }), TTL);
  try { await confirm(); } catch {
    try { await sleepImpl(1100); await confirm(); } catch { return { alerted: true, reason: "confirmacao_nao_gravada" }; }
  }
  return { alerted: true, reason: null };
}

// Envia (ou reenvia) o aviso do dia BRT `day`, se ainda não confirmado.
async function alertDay(env, kv, cfg, day, now, fetchImpl, sleepImpl) {
  if ((await kv.get(keys(day).sent)) !== null) return { alerted: false, reason: "ja_avisado_hoje" };
  const { best, complete } = await firstOfDay(kv, day);
  if (!best) return { alerted: false, reason: complete ? "sem_pedido" : "registro_do_pedido_ausente" };
  const kit = KITS.find((x) => x.slug === best.rec.product);
  const st = await txnState(kv, best.h);
  const text = firstOrderAlertText({ name: kit?.name || best.rec.product, kind: st?.kind || FIRST_ORDER_EVENTS[best.rec.event], now: Date.parse(best.rec.at), timeSource: best.rec.timeSource });
  return attemptSend(kv, cfg, day, text, now, fetchImpl, sleepImpl);
}

// Webhook, depois do registro de vendas: melhor esforço, nunca muda a resposta. Só hoje/ontem BRT (evento antigo não avisa).
export async function maybeAlertFirstOrder(env, { day, now = Date.now(), fetchImpl = fetch, sleepImpl = sleep } = {}) {
  try {
    if (!day) return { alerted: false, reason: "sem_candidato" };
    if (day !== brtDay(now) && day !== brtDay(now - 86400000)) return { alerted: false, reason: "dia_antigo" };
    const kv = kvOf(env);
    if (!kv) return { alerted: false, reason: "kv_indisponivel" };
    const cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!cfg) return { alerted: false, reason: "telegram_nao_configurado" };
    return await alertDay(env, kv, cfg, day, now, fetchImpl, sleepImpl);
  } catch {
    return { alerted: false, reason: "erro" };
  }
}

// Cron horário: recupera o aviso de hoje e de ontem (BRT) sem depender de outra compra.
export async function retryFirstOrderAlert(env, { now = Date.now(), fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const out = [];
  try {
    const kv = kvOf(env), cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!kv || !cfg) return { ok: true, results: out, reason: !kv ? "kv_indisponivel" : "telegram_nao_configurado" };
    for (const day of [brtDay(now), brtDay(now - 86400000)]) {
      const r = await alertDay(env, kv, cfg, day, now, fetchImpl, sleepImpl);
      if (r.reason === "sem_pedido" || r.reason === "ja_avisado_hoje") continue;
      out.push({ day, ...r });
    }
    return { ok: true, results: out };
  } catch {
    return { ok: false, results: out, reason: "erro" };
  }
}
