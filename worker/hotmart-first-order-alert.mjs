// D12 (19/11/2026, VC-H, teto inicial de 1 pedido por dia): um ÚNICO aviso ao proprietário no PRIMEIRO pedido elegível
// do dia no horário de Brasília, para ele pausar o produto na Hotmart na hora. "Pedido elegível" = evento autenticado
// e gravado pela primeira vez no registro de vendas (nunca duplicata) de um kit LIBERADO no modo Hotmart por produto,
// com o pedido criado (PIX ou boleto aguardando pagamento, PURCHASE_BILLET_PRINTED) ou aprovado (APPROVED/COMPLETE).
// Sem dado pessoal: nem comprador, nem transação, nem valor do pedido; só produto, tipo de evento e hora BRT.
// Melhor esforço: nunca bloqueia nem altera a resposta do webhook. Canal: segredo TELEGRAM_ALERT ("<token>|<chat_id>").
// Escopo da marca: UMA por dia BRT (qualquer kit), porque o teto do VC-H é 1 pedido/dia no total.
// Estados da marca (contra-auditoria GPT-6 de f57e8cf8): só "enviado" (Telegram respondeu 2xx) suprime os eventos
// seguintes do dia. "tentando" (envio em curso ou gravação final perdida), "falhou" (HTTP não-2xx) e "incerto"
// (timeout/rede: o Telegram pode ou não ter entregue) deixam o próximo evento elegível tentar de novo, até
// MAX_ATTEMPTS por dia. Segredo ausente não grava nada. Preferimos aviso duplicado a nenhum aviso: o KV do
// Cloudflare não tem compare-and-set, então dois eventos simultâneos podem gerar dois avisos (nunca zero), e um
// "incerto" seguido de novo evento pode repetir o aviso. O alerta NÃO impõe o teto na Hotmart: quem pausa é o titular.
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
function readMark(raw) {
  if (raw === null || raw === undefined) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : { status: "ilegivel" }; } catch { return { status: "ilegivel" }; }
}

export async function maybeAlertFirstOrder(env, { event, productId, recorded, now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    const kind = FIRST_ORDER_EVENTS[String(event || "").toUpperCase()];
    if (!kind) return { alerted: false, reason: "evento_nao_elegivel" };
    if (recorded !== true) return { alerted: false, reason: "duplicata" };
    const kit = KITS.find((k) => String(k.hotmart_product_id) === String(productId || ""));
    if (!kit) return { alerted: false, reason: "produto_fora_da_lista" };
    if (!hotmartProductOpen(await readHotmartSwitch(env, now), kit.slug)) return { alerted: false, reason: "produto_nao_liberado" };
    const cfg = parseTelegramAlert(env?.TELEGRAM_ALERT);
    if (!cfg) return { alerted: false, reason: "telegram_nao_configurado" }; // nada gravado: a configuração posterior ainda avisa
    const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
    if (!kv?.get || !kv?.put) return { alerted: false, reason: "kv_indisponivel" };
    const key = FIRST_ORDER_ALERT_PREFIX + brtDay(now);
    const prev = readMark(await kv.get(key));
    if (prev?.status === "enviado") return { alerted: false, reason: "ja_avisado_hoje" };
    const attempts = (Number.isInteger(prev?.attempts) ? prev.attempts : 0) + 1;
    if (attempts > MAX_ATTEMPTS) return { alerted: false, reason: "tentativas_esgotadas" };
    const base = { product: kit.slug, event: String(event).toUpperCase(), attempts };
    const mark = (status, extra = {}) => kv.put(key, JSON.stringify({ status, at: new Date(now).toISOString(), ...base, ...extra }), { expirationTtl: 3 * 86400 });
    await mark("tentando");
    let r;
    try {
      r = await fetchImpl(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text: firstOrderAlertText({ name: kit.name || kit.slug, kind, now }), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      await mark("incerto").catch(() => null);
      return { alerted: false, reason: "telegram_incerto" };
    }
    if (r?.ok === true) {
      await mark("enviado").catch(() => null);
      return { alerted: true, reason: null };
    }
    await mark("falhou", { http: Number(r?.status) || 0 }).catch(() => null);
    return { alerted: false, reason: `telegram_${r?.status}` };
  } catch {
    return { alerted: false, reason: "erro" };
  }
}
