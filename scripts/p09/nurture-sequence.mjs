// P09 Nutrição (Roteiro Mestre v4.7, seção 5): política de envio e renderização da sequência versionada em
// content/p09/<id>/ (sequence.json + um arquivo de texto por e-mail).
//
// Este módulo é PURO: não lê arquivo, não acessa rede e não envia nada. Quem envia continua sendo o Worker
// (worker/lead-magnet.mjs, provedor já existente); este módulo só responde "pode enviar este passo a este lead?"
// e monta assunto, texto, HTML e cabeçalhos de descadastro em 1 clique (RFC 8058).
//
// Regras (todas fail-closed):
//   * Interruptor DESLIGADO por padrão: só há envio quando env[send_switch.env] é exatamente o id da sequência.
//     Ausente, vazio, "on", "true" ou o id de outra sequência = desligado.
//   * Nada sem consentimento registrado (P08): lead confirmado (dupla confirmação), com consent_at e confirmed_at,
//     sem descadastro, com versão de consentimento aceita pela sequência E conhecida pelo modelo do P08
//     (CONSENT_FOLLOWUPS). O passo n (n >= 1) só sai se o consentimento permitir n e-mails depois do checklist.
//   * E-mail comercial só com vendas abertas (interruptor do proprietário).
//   * Todo e-mail leva o link de descadastro no texto e os cabeçalhos List-Unsubscribe / List-Unsubscribe-Post.
import { CONSENT_FOLLOWUPS } from "../../worker/lead-magnet.mjs";
import { CUSTOMER_RULE_7D, LEGAL_IDENTITY, SUPPORT_EMAIL } from "../../worker/politica-unica.mjs";
import { brandedEmailHtml } from "../../worker/brand-email.mjs";

export const PLACEHOLDER_RE = /\{\{([a-z_0-9]+)(?::([a-z0-9_-]+))?\}\}/g;
export const KNOWN_PLACEHOLDERS = Object.freeze(["saudacao", "assinatura", "link", "preco", "regra_7d", "identificacao"]);
export const ALLOWED_LINK_HOSTS = Object.freeze(["vendas.zevanory.api.br", "zevanory.api.br"]);

export function parseTemplate(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  const m = /^Assunto: ([^\n]+)\n\n([\s\S]+)$/.exec(text);
  if (!m) throw new Error("template_format: primeira linha 'Assunto: ...', linha em branco, corpo");
  return { subject: m[1].trim(), body: m[2].replace(/\s+$/, "") + "\n" };
}

export function placeholdersOf(text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((m) => ({ name: m[1], arg: m[2] ?? null, raw: m[0] }));
}

export function trackedUrl(url, campaign, content) {
  const u = new URL(url);
  u.searchParams.set("utm_source", "email");
  u.searchParams.set("utm_medium", "nurture");
  u.searchParams.set("utm_campaign", campaign);
  u.searchParams.set("utm_content", content);
  return u.toString();
}

export function signature(optOutUrl) {
  return `Equipe ZEVANORY\n${SUPPORT_EMAIL}\n\nVocê recebe este e-mail porque pediu o checklist gratuito e confirmou o seu endereço.\nNão quer mais receber? Descadastre-se em 1 clique: ${optOutUrl}`;
}

export function unsubscribeHeaders(optOutUrl) {
  return { "List-Unsubscribe": `<${optOutUrl}>, <mailto:${SUPPORT_EMAIL}?subject=descadastrar>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

function fill(text, ctx) {
  return String(text).replace(PLACEHOLDER_RE, (raw, name, arg) => {
    if (name === "saudacao") return ctx.name ? `Olá, ${ctx.name}!` : "Olá!";
    if (name === "assinatura") return signature(ctx.optOutUrl);
    if (name === "regra_7d") return CUSTOMER_RULE_7D;
    if (name === "identificacao") return LEGAL_IDENTITY;
    if (name === "link") {
      const url = ctx.email.links?.[arg];
      if (!url) throw new Error(`link_undeclared:${arg}`);
      return trackedUrl(url, ctx.email.campaign, arg);
    }
    if (name === "preco") {
      const p = ctx.products.find((x) => x.slug === arg);
      if (!p || !Number.isInteger(p.price)) throw new Error(`price_unknown:${arg}`);
      return String(p.price);
    }
    throw new Error(`placeholder_unknown:${raw}`);
  });
}

// Decide se o passo pode ser enviado. Nunca lança: devolve { ok, reason }.
export function canSend({ env = {}, sequence, step, lead, salesOpen = false, consentFollowups = CONSENT_FOLLOWUPS } = {}) {
  const sw = sequence?.send_switch || {};
  if (!sequence?.id || sw.on_value !== sequence.id || typeof sw.env !== "string" || !sw.env) return { ok: false, reason: "switch_misconfigured" };
  if (String(env?.[sw.env] ?? "") !== sequence.id) return { ok: false, reason: "switch_off" };
  const email = (sequence.emails || []).find((e) => e.step === step);
  if (!email) return { ok: false, reason: "unknown_step" };
  if (!lead || lead.status !== "confirmed" || !lead.confirmed_at || !lead.consent_at || lead.unsubscribed_at) return { ok: false, reason: "no_confirmed_consent" };
  if (!(sequence.consent?.accepted_versions || []).includes(lead.consent_version)) return { ok: false, reason: "consent_version_not_accepted" };
  const cap = Object.prototype.hasOwnProperty.call(consentFollowups, lead.consent_version) ? consentFollowups[lead.consent_version] : undefined;
  if (!Number.isInteger(cap) || cap < 0) return { ok: false, reason: "consent_version_unknown" };
  if (step > cap) return { ok: false, reason: "consent_cap" };
  if (email.commercial === true && salesOpen !== true) return { ok: false, reason: "sales_closed" };
  return { ok: true, reason: "ok" };
}

// Monta o e-mail do passo. Sem rede: devolve o que o Worker enviaria pelo provedor existente.
export function renderEmail({ sequence, templates, step, name = "", optOutUrl, products = [] } = {}) {
  if (!/^https:\/\/[^\s]+$/.test(String(optOutUrl || ""))) throw new Error("optout_url_required");
  const email = (sequence?.emails || []).find((e) => e.step === step);
  if (!email) throw new Error(`unknown_step:${step}`);
  const tpl = parseTemplate(templates[email.file]);
  const ctx = { name: String(name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 60), optOutUrl, email, products };
  const subject = fill(tpl.subject, ctx);
  const text = fill(tpl.body, ctx);
  return { subject, text, html: brandedEmailHtml(text, { unsubscribeUrl: optOutUrl }), headers: unsubscribeHeaders(optOutUrl),
    tags: [{ name: "flow", value: `p09_${sequence.id}` }, { name: "campaign", value: email.campaign }], campaign: email.campaign };
}

// Atalho para o Worker: só monta se puder enviar.
export function prepareEmail(args = {}) {
  const decision = canSend(args);
  if (!decision.ok) return { send: false, reason: decision.reason };
  return { send: true, reason: "ok", message: renderEmail(args) };
}
