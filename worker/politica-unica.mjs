// P13c: fonte única da política de compra para as superfícies fora das páginas estáticas
// (respostas do suporte e do WhatsApp, e-mails de nutrição, avaliações, posts e criativos).
// Todo texto de prazo, entrega e reembolso vem de data/politica-unica.json (o mesmo arquivo do
// build estático, scripts/sales_policy.py). Nada de prazo é escrito à mão nos módulos.
import POLICY from "../data/politica-unica.json" with { type: "json" };

const W = POLICY.customer_wording;
const fill = (s) => String(s).replaceAll("{rule_7d}", W.rule_7d).replaceAll("{refund_channels}", W.refund_channels);

export const SOL_TEXT = POLICY.sol_text;
export const RULE_7D = POLICY.rule_7d;
export const DELIVERY_72H = POLICY.delivery_72h;
export const CLOSED_LABEL = POLICY.closed_label;
export const WAITLIST_LABEL = POLICY.waitlist_label;
export const BANNED_POLICY_PHRASES = Object.freeze([...POLICY.banned_policy_phrases]);
export const CHECKOUT_HREF_PATHS = Object.freeze([...POLICY.checkout_href_paths]);
export const CHECKOUT_HOSTS = Object.freeze([...POLICY.checkout_hosts]);
export const RESUMO_OFERTA = POLICY.resumo_oferta;

// Redação ao cliente (derivada do sol_text; ver customer_wording.fragmentos_sol).
export const CUSTOMER_RULE_7D = W.rule_7d;
export const SHORT_RULE = W.short;
export const SHORT_RULE_LABEL = W.short.charAt(0).toUpperCase() + W.short.slice(1);
// Fala (TTS): números por extenso.
export const SHORT_RULE_SPOKEN = W.short.replace(/\b7\b/, "sete");
export const RULE_LINE = fill(W.rule_line);
export const DELIVERY_TEXT = fill(W.delivery);
export const RESEND_SHORT = fill(W.resend_short);
export const CONFIRMATION_TEXT = fill(W.confirmation);
export const REFUND_TEXT = fill(W.refund);
export const SUBSCRIPTION_DELIVERY_TEXT = fill(W.subscription_delivery);
export const SUBSCRIPTION_REFUND_TEXT = fill(W.subscription_refund);
export const REFUND_CHANNELS = W.refund_channels;
export const SLA_TEXT = fill(W.sla);
export const ALLOWED_DAY_COUNTS = Object.freeze(Object.values(W.dias_permitidos).map(Number));

// Respostas completas do suporte (mesmas peças para API, WhatsApp e voz).
export const SUPPORT_REFUND_ANSWER = [REFUND_TEXT, RESEND_SHORT, SLA_TEXT].join(" ");
export const SUPPORT_DELIVERY_ANSWER = [DELIVERY_TEXT, CONFIRMATION_TEXT, RULE_LINE, SLA_TEXT].join(" ");
export const SUPPORT_SUBSCRIPTION_REFUND_ANSWER = [SUBSCRIPTION_REFUND_TEXT, SLA_TEXT].join(" ");
export const SUPPORT_SUBSCRIPTION_DELIVERY_ANSWER = [SUBSCRIPTION_DELIVERY_TEXT, CONFIRMATION_TEXT, RULE_LINE, SLA_TEXT].join(" ");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Qualquer chamada de compra: caminho de checkout/assinatura (relativo ou absoluto), host de checkout
// externo ou menção à Hotmart como lugar de compra.
const CHECKOUT_RE = new RegExp("(?:" + [...CHECKOUT_HREF_PATHS, ...CHECKOUT_HOSTS].map(esc).join("|") + ")|\\bhotmart\\b", "i");
export function hasCheckoutCta(text) {
  return CHECKOUT_RE.test(String(text || ""));
}

// Formulações divergentes proibidas (maiúsculas ignoradas) + a frase de banned_refund_context perto
// de prazo/reembolso (o prazo nunca conta da compra).
const BANNED_LOWER = [...new Set(BANNED_POLICY_PHRASES.map((p) => p.toLowerCase()))];
const CTX = POLICY.banned_refund_context;
export function bannedPolicyHits(text) {
  const lower = String(text || "").toLowerCase();
  const hits = BANNED_LOWER.filter((p) => lower.includes(p));
  const phrase = CTX.phrase.toLowerCase();
  for (let i = lower.indexOf(phrase); i !== -1; i = lower.indexOf(phrase, i + 1)) {
    const around = lower.slice(Math.max(0, i - CTX.window), i + phrase.length + CTX.window);
    if (CTX.context.some((c) => around.includes(c.toLowerCase()))) { hits.push(CTX.phrase + " (prazo/reembolso)"); break; }
  }
  return hits;
}
