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
// Identificação e endereço únicos do fornecedor (rodapés, e-mails, blog, páginas).
export const SUPPLIER = POLICY.resumo_oferta.fornecedor;
export const ADDRESS_FULL = `${SUPPLIER.endereco_fisico}, CEP ${SUPPLIER.cep}`;
export const LEGAL_IDENTITY = `${SUPPLIER.razao_social} · CNPJ ${SUPPLIER.cnpj} · ${ADDRESS_FULL}`;

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

// Prazo de arrependimento (refund_window): início = a data mais recente entre a contratação
// (confirmação do pagamento) e o primeiro recebimento (entrega por e-mail bem-sucedida ou primeiro
// download); fim = último instante do N-ésimo dia corrido seguinte no fuso da política. Nunca é mais
// curto que N x 24 h. Sem recebimento registrado o prazo ainda não começou (pedido aceito).
export const REFUND_WINDOW = Object.freeze({ ...POLICY.refund_window });
const DAY_MS = 86_400_000;
const toMs = (v) => { if (v == null || v === "") return null; const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v)); return Number.isFinite(t) ? t : null; };
export function refundWindow({ paidAt, deliveredAt, firstDownloadAt, now = Date.now() } = {}) {
  const paid = toMs(paidAt);
  if (paid == null) return { eligible: false, started: false, reason: "sem_confirmacao_de_pagamento" };
  const receipts = [toMs(deliveredAt), toMs(firstDownloadAt)].filter((t) => t != null);
  if (!receipts.length) return { eligible: true, started: false, reason: "recebimento_pendente", paid_at: new Date(paid).toISOString() };
  const receipt = Math.min(...receipts);
  const start = Math.max(paid, receipt);
  const off = Number(REFUND_WINDOW.utc_offset_minutes) * 60_000;
  const localDay = Math.floor((start + off) / DAY_MS);
  const deadline = (localDay + Number(REFUND_WINDOW.days) + 1) * DAY_MS - 1 - off;
  return { eligible: toMs(now) <= deadline, started: true, reason: toMs(now) <= deadline ? "dentro_do_prazo" : "fora_do_prazo",
    paid_at: new Date(paid).toISOString(), received_at: new Date(receipt).toISOString(), starts_at: new Date(start).toISOString(), ends_at: new Date(deadline).toISOString() };
}
