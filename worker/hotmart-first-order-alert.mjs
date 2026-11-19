// D12 (19/11/2026, VC-H, teto inicial de 1 pedido por dia): um ÚNICO aviso ao proprietário no PRIMEIRO pedido elegível
// do dia no horário de Brasília, para ele pausar o produto na Hotmart na hora. "Pedido elegível" = evento autenticado
// e gravado pela primeira vez no registro de vendas (nunca duplicata) de um kit LIBERADO no modo Hotmart por produto,
// com o pedido criado (PIX ou boleto aguardando pagamento, PURCHASE_BILLET_PRINTED) ou aprovado (APPROVED/COMPLETE).
// Sem dado pessoal: nem comprador, nem transação, nem valor do pedido; só produto, tipo de evento e hora BRT.
// Melhor esforço: nunca bloqueia nem altera a resposta do webhook. O KV do Cloudflare não tem compare-and-set: dois
// postbacks simultâneos no mesmo segundo podem gerar dois avisos; nunca zero por causa disso (a marca é gravada antes
// do envio e só depois de confirmada a ausência). Canal: segredo TELEGRAM_ALERT ("<token>|<chat_id>").
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

export async function maybeAlertFirstOrder(env, { event, productId, recorded, now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const kind = FIRST_ORDER_EVENTS[String(event || "").toUpperCase()];
    if (!kind) return { alerted: false, reason: "evento_nao_elegivel" };
    if (recorded !== true) return { alerted: false, reason: "duplicata" };
    const kit = KITS.find((k) => String(k.hotmart_product_id) === String(productId || ""));
    if (!kit) return { alerted: false, reason: "produto_fora_da_lista" };
    if (!hotmartProductOpen(await readHotmartSwitch(env, now), kit.slug)) return { alerted: false, reason: "produto_nao_liberado" };
    const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
    if (!kv?.get || !kv?.put) return { alerted: false, reason: "kv_indisponivel" };
    const key = FIRST_ORDER_ALERT_PREFIX + brtDay(now);
    if ((await kv.get(key)) !== null) return { alerted: false, reason: "ja_avisado_hoje" };
    await kv.put(key, JSON.stringify({ at: new Date(now).toISOString(), product: kit.slug, event: String(event).toUpperCase() }), { expirationTtl: 3 * 86400 });
    const cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!cfg) return { alerted: false, reason: "telegram_nao_configurado" };
    const r = await fetchImpl(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: firstOrderAlertText({ name: kit.name || kit.slug, kind, now }), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    return { alerted: r.ok === true, reason: r.ok ? null : `telegram_${r.status}` };
  } catch {
    return { alerted: false, reason: "erro" };
  }
}
