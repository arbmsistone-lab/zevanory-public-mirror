// D12 (19/11/2026, VC-H, teto inicial de 1 pedido por dia): um ÚNICO aviso ao proprietário no PRIMEIRO pedido elegível
// do dia no horário de Brasília, para ele pausar o produto na Hotmart na hora. "Pedido elegível" = evento autenticado
// e gravado pela primeira vez no registro de vendas (nunca duplicata) de um kit LIBERADO no modo Hotmart por produto,
// com o pedido criado (PIX ou boleto aguardando pagamento, PURCHASE_BILLET_PRINTED) ou aprovado (APPROVED/COMPLETE).
// Sem dado pessoal: nem comprador, nem transação, nem valor do pedido; só produto, tipo de evento e hora BRT.
// Melhor esforço: nunca bloqueia nem altera a resposta do webhook. Canal: segredo TELEGRAM_ALERT ("<token>|<chat_id>").
// Escopo: UM aviso por dia BRT (qualquer kit), porque o teto do VC-H é 1 pedido/dia no total.
// Persistência compatível com o Workers KV (1 escrita por segundo por chave; leitura eventualmente consistente),
// após a reauditoria GPT-6 de 9c9f5f32: NENHUMA chave é regravada no fluxo normal.
//   <dia>:pedido          gravada uma vez, no 1º pedido elegível do dia (produto, evento, hora; sem dado pessoal);
//   <dia>:tentativa:<id>  uma chave NOVA por tentativa, gravada antes do envio (conta tentativas por listagem);
//   <dia>:enviado         gravada uma vez, só depois do 2xx do Telegram. Só ela suprime novos avisos.
// Recuperação sem depender de outro pedido: o cron horário (retryFirstOrderAlert) reenvia o aviso de um <dia>:pedido
// sem <dia>:enviado (hoje e ontem BRT), até MAX_ATTEMPTS tentativas no dia. Falha HTTP, timeout (resultado incerto)
// e segredo ausente ficam pendentes. Preferimos aviso duplicado a nenhum aviso: eventos simultâneos, um timeout que
// na verdade entregou, ou a gravação de <dia>:enviado perdida podem repetir o aviso; o limite de tentativas é
// aproximado (listagem eventualmente consistente). O alerta NÃO impõe o teto na Hotmart: quem pausa é o titular.
import { parseTelegramAlert, TELEGRAM_API } from "./atendimento.mjs";
import { readHotmartSwitch, hotmartProductOpen } from "./sales-control.mjs";
import ALLOW from "../data/p18-commercial-allowlist.json" with { type: "json" };

export const FIRST_ORDER_ALERT_PREFIX = "zpc:hotmart:alerta-primeiro-pedido:v1:";
export const FIRST_ORDER_EVENTS = Object.freeze({
  PURCHASE_BILLET_PRINTED: "pedido criado, aguardando pagamento",
  PURCHASE_APPROVED: "pedido aprovado",
  PURCHASE_COMPLETE: "pedido aprovado",
});
const KITS = Object.freeze(ALLOW.products.filter((p) => p.kind === "kit"));

// Dia civil em America/Sao_Paulo (sem horário de verão desde 2019: UTC-3 fixo, igual a scripts/audit/funnel-counting).
export function brtDay(now) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}
export function brtTime(now) {
  return new Date(now - 3 * 3600000).toISOString().slice(11, 16);
}
export function firstOrderAlertText({ name, kind, now }) {
  return `ZEVANORY: 1º pedido do dia do ${name} (${kind}) às ${brtTime(now)} BRT. Teto de 1 pedido/dia: pause o produto na Hotmart agora (Ativar vendas desligado) e confira em Vendas > Gestão de vendas.`;
}

export const MAX_ATTEMPTS = 5;
const TTL = { expirationTtl: 3 * 86400 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (day) => { const p = FIRST_ORDER_ALERT_PREFIX + day; return { order: p + ":pedido", sent: p + ":enviado", attempt: p + ":tentativa:" }; };
const kvOf = (env) => { const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS; return kv?.get && kv?.put && kv?.list ? kv : null; };
async function countAttempts(kv, prefix) {
  let n = 0, cursor;
  for (let page = 0; page < 5; page++) { const r = await kv.list({ prefix, cursor }); n += (r?.keys || []).length; if (r?.list_complete !== false || !r?.cursor) break; cursor = r.cursor; }
  return n;
}

// Uma tentativa de envio para o dia `day`. Escreve só chaves novas (tentativa) e, no sucesso, <dia>:enviado.
async function attemptSend(kv, cfg, day, order, now, fetchImpl, sleepImpl) {
  const k = keys(day);
  if ((await kv.get(k.sent)) !== null) return { alerted: false, reason: "ja_avisado_hoje" };
  if ((await countAttempts(kv, k.attempt)) >= MAX_ATTEMPTS) return { alerted: false, reason: "tentativas_esgotadas" };
  await kv.put(k.attempt + now + "-" + crypto.randomUUID().slice(0, 8), JSON.stringify({ at: new Date(now).toISOString() }), TTL);
  const kit = KITS.find((x) => x.slug === order.product);
  const kind = FIRST_ORDER_EVENTS[order.event] || "pedido";
  let r;
  try {
    r = await fetchImpl(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: firstOrderAlertText({ name: kit?.name || order.product, kind, now: Date.parse(order.at) || now }), disable_web_page_preview: true }),
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

export async function maybeAlertFirstOrder(env, { event, productId, recorded, now = Date.now(), fetchImpl = fetch, sleepImpl = sleep } = {}) {
  try {
    const ev = String(event || "").toUpperCase();
    if (!FIRST_ORDER_EVENTS[ev]) return { alerted: false, reason: "evento_nao_elegivel" };
    if (recorded !== true) return { alerted: false, reason: "duplicata" };
    const kit = KITS.find((k) => String(k.hotmart_product_id) === String(productId || ""));
    if (!kit) return { alerted: false, reason: "produto_fora_da_lista" };
    if (!hotmartProductOpen(await readHotmartSwitch(env, now), kit.slug)) return { alerted: false, reason: "produto_nao_liberado" };
    const kv = kvOf(env);
    if (!kv) return { alerted: false, reason: "kv_indisponivel" };
    const day = brtDay(now), k = keys(day);
    if ((await kv.get(k.sent)) !== null) return { alerted: false, reason: "ja_avisado_hoje" };
    // 1º pedido elegível do dia: registro único (corrida entre dois eventos = a 2ª escrita pode ser recusada; ignorado).
    let order = null;
    try { order = JSON.parse((await kv.get(k.order)) ?? "null"); } catch { order = null; }
    if (!order?.product) { order = { at: new Date(now).toISOString(), product: kit.slug, event: ev }; await kv.put(k.order, JSON.stringify(order), TTL).catch(() => null); }
    const cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!cfg) return { alerted: false, reason: "telegram_nao_configurado" }; // pendente: o cron avisa quando houver segredo
    return await attemptSend(kv, cfg, day, order, now, fetchImpl, sleepImpl);
  } catch {
    return { alerted: false, reason: "erro" };
  }
}

// Cron horário: recupera o aviso do 1º pedido de hoje ou de ontem (BRT) ainda não confirmado, sem novo pedido.
export async function retryFirstOrderAlert(env, { now = Date.now(), fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const out = [];
  try {
    const kv = kvOf(env), cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!kv || !cfg) return { ok: true, results: out, reason: !kv ? "kv_indisponivel" : "telegram_nao_configurado" };
    for (const day of [brtDay(now), brtDay(now - 86400000)]) {
      let order = null;
      try { order = JSON.parse((await kv.get(keys(day).order)) ?? "null"); } catch { order = null; }
      if (!order?.product || !KITS.some((x) => x.slug === order.product)) continue;
      out.push({ day, ...(await attemptSend(kv, cfg, day, order, now, fetchImpl, sleepImpl)) });
    }
    return { ok: true, results: out };
  } catch {
    return { ok: false, results: out, reason: "erro" };
  }
}
