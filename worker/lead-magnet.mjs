import { brandedEmailHtml } from "./brand-email.mjs";
import { emitActivity } from "./activity-ledger.mjs";
// Lead magnet: free checklist in exchange for an e-mail, with explicit LGPD consent and double
// opt-in. Inbound only: nobody receives anything without asking for it and confirming the address.
// * Subscribe arrives only through the sales Worker's private binding (host leads.internal).
// * Confirmation link is single-use (token hash stored) and needs a click (POST), so mail scanners
//   never confirm on the person's behalf.
// * Nurture (5 e-mails, then it stops): D0 checklist, D+2 practical tips, D+7 the one product
//   that matches what the person was reading (calculator → Lucro & Caixa, sales → Vendas na
//   Prática, otherwise IA na Prática), D+10 honest answers to the usual doubts, D+14 a last
//   note with the complete package. Offers only go out while sales are open. Every e-mail
//   carries one-click unsubscribe (RFC 8058) and utm tags so sales are attributed to e-mail.
// * T3 / LGPD (plan 3.1): processing follows the consent text and the published privacy policy.
//   - Consent v1 ("o checklist e até 2 e-mails de dicas e produtos") caps the sequence at the
//     checklist + 2 e-mails; longer sequences need a new consent version.
//   - Revocation (one-click opt-out) ERASES the lead row (e-mail, name) and the interest key.
//   - Retention: unconfirmed requests are erased 7 days after the link expires; confirmed leads
//     after 2 years without interaction (policy maximum).
//   - Audit trail without e-mail in clear: zevanory_lead_events keeps event, consent version and
//     a keyed HMAC of the e-mail (pseudonymised, NOT anonymised: still personal data, kept
//     LEAD_EVENT_RETENTION_DAYS) so consent and its revocation can be proven (LGPD art. 8, §2).
//   - Identifiers in links, KV keys and activity refs are keyed HMACs, never plain SHA-256 of the
//     e-mail (a plain hash of an e-mail can be reversed by guessing).

const CORE = "https://zevanory.api.br";
const SALES = "https://vendas.zevanory.api.br";
const CHECKLIST_URL = `${SALES}/checklist-15-minutos`;
const SUPPORT_EMAIL = "suporte@zevanory.api.br";
const CONSENT_VERSION = "lead-magnet-v1-2026-10-07";
// E-mails after the checklist that each consent text allows ("até 2 e-mails de dicas e produtos").
export const CONSENT_FOLLOWUPS = { [CONSENT_VERSION]: 2 };
export const PENDING_GRACE_DAYS = 7;
export const INACTIVE_RETENTION_DAYS = 730;
export const DEFAULT_EVENT_RETENTION_DAYS = 730;
const RETENTION_BATCH = 200;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const DAY = 86_400_000;
let schemaReady = false;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (status, title, body) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#040a12;color:#f5f8fc;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{width:100%;max-width:480px;background:#07111d;border:1px solid #16304a;border-radius:12px;padding:28px}h1{font-size:21px;margin:0 0 12px}p{color:#a9b6c9;line-height:1.55}button,a.b{display:block;width:100%;box-sizing:border-box;text-align:center;background:#00b8ff;color:#03101c;border:0;border-radius:8px;padding:14px 20px;font-weight:700;font-size:16px;cursor:pointer;text-decoration:none;min-height:44px}a{color:#21e6f3}</style></head><body><main><h1>${esc(title)}</h1>${body}<p>Dúvidas: ${SUPPORT_EMAIL}</p></main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });

async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function maskEmail(email) {
  const [u, d] = String(email).split("@");
  return (u || "").slice(0, 2) + "***@" + (d || "");
}
// Legacy opt-out secret (links already sent): derived from the e-mail provider key.
function secretFor(env) { return env.RESEND_API_KEY ? "zevanory-lead-optout-v1:" + env.RESEND_API_KEY : ""; }
// Privacy key for subject references. A dedicated LEAD_PRIVACY_SECRET is preferred (rotating the
// e-mail key then no longer breaks links); without it, a separate derivation of the provider key.
function privacySecret(env) {
  if (env.LEAD_PRIVACY_SECRET && String(env.LEAD_PRIVACY_SECRET).length >= 32) return "zevanory-lead-privacy-v1:" + env.LEAD_PRIVACY_SECRET;
  return env.RESEND_API_KEY ? "zevanory-lead-privacy-v1:" + env.RESEND_API_KEY : "";
}
const normEmail = (email) => String(email || "").trim().toLowerCase();
// Keyed pseudonym of the e-mail; null when no key is configured (never falls back to a plain hash).
export async function subjectRef(env, email) {
  const secret = privacySecret(env);
  return secret ? hmacHex(secret, "subject:" + normEmail(email)) : null;
}
const optOutToken = async (env, ref) => (await hmacHex(privacySecret(env), "optout:" + ref)).slice(0, 32);

export async function leadOptOutLink(env, email) {
  const ref = await subjectRef(env, email);
  if (ref) return `${CORE}/material-gratuito/sair?r=${ref}&t=${await optOutToken(env, ref)}`;
  return `${CORE}/material-gratuito/sair`;
}

async function recordEvent(sql, ref, event, consentVersion = null) {
  await sql.query("insert into zevanory_lead_events (subject_ref, event, consent_version) values ($1, $2, $3)", [ref || null, event, consentVersion]);
}

// Erases the personal data of one lead (row + interest keys) and records the event.
async function eraseLead(env, sql, row, event) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const ref = row.subject_ref || (row.email ? await subjectRef(env, row.email) : null);
  try { if (ref) await kv?.delete?.("zpc:lead:interest:" + ref); } catch {}
  try { if (row.email) await kv?.delete?.("zpc:lead:interest:" + (await sha256Hex(normEmail(row.email)))); } catch {}
  await recordEvent(sql, ref, event, row.consent_version || null);
}

export async function ensureLeadSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_leads (
    email text primary key, email_hash text not null, name text, source text not null default 'material-gratuito',
    consent_version text not null, consent_at timestamptz not null, status text not null default 'pending',
    token_hash text, token_expires_at timestamptz, created_at timestamptz not null default now(),
    confirmed_at timestamptz, unsubscribed_at timestamptz, nurture_step integer not null default 0, nurture_at timestamptz)`, []);
  await sql.query("alter table zevanory_leads add column if not exists subject_ref text", []);
  // Audit trail without e-mail, name or IP (pseudonymised subject reference only).
  await sql.query(`create table if not exists zevanory_lead_events (id bigserial primary key, subject_ref text, event text not null,
    consent_version text, at timestamptz not null default now())`, []);
  schemaReady = true;
}

async function sendEmail(env, { to, subject, text, unsubscribeUrl, idempotencyKey }) {
  if (!env.RESEND_API_KEY) return false;
  const headers = { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers,
    body: JSON.stringify({
      from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: SUPPORT_EMAIL, subject, text, html: brandedEmailHtml(text,{unsubscribeUrl}),
      ...(unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=descadastrar>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      tags: [{ name: "flow", value: "lead_magnet" }],
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (r?.ok) await emitActivity(env, { type: "email_sent", channel: "email", status: "sent", ref: "lead-mail:" + (idempotencyKey || randomToken()) }).catch(() => null);
  return Boolean(r?.ok);
}

async function bridge(env, key, entry) {
  try { await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(`zpc-activity:v1:${entry.kind}:${Date.now()}:${key}`, JSON.stringify(entry), { expirationTtl: 30 * 24 * 3600 }); } catch {}
}

export const NURTURE_DONE = 5;
const OFFERS = {
  ia: { name: "IA na Prática", price: 197, slug: "ia-na-pratica", promise: "usar IA no atendimento, no conteúdo e na rotina, com comandos prontos e uma planilha para medir o que mudou" },
  vendas: { name: "Vendas na Prática", price: 197, slug: "vendas-na-pratica", promise: "ter roteiro de mensagens, acompanhamento de clientes e conteúdo que vende, sem depender de anúncio" },
  caixa: { name: "Lucro & Caixa", price: 247, slug: "lucro-e-caixa", promise: "saber quanto entra, quanto sai e quanto realmente sobra, com uma rotina semanal curta" },
};
export function interestFromPage(page = "") {
  const p = String(page || "").toLowerCase();
  if (/calculadora|lucro|caixa|ferramentas|margem/.test(p)) return "caixa";
  if (/vendas|conteudo-pronto/.test(p)) return "vendas";
  return "ia";
}
const track = (slug, step, interest) => `${SALES}/${slug}?utm_source=email&utm_medium=nurture&utm_campaign=s${step}-${interest}`;

export function nurtureEmail(step, { name, optOutUrl, interest = "ia" }) {
  const hi = name ? `Olá, ${name}!` : "Olá!";
  const sign = `\n\nEquipe ZEVANORY\n${SUPPORT_EMAIL}\n\nNão quer mais receber? ${optOutUrl}`;
  const o = OFFERS[interest] || OFFERS.ia;
  if (step === 0) return { subject: "Seu checklist: 15 minutos por dia para organizar o negócio", text: `${hi}\n\nAqui está o seu checklist gratuito:\n${CHECKLIST_URL}\n\nComece hoje pelo bloco do caixa (5 minutos). Em 2 dias eu te mando dois hábitos simples que evitam perder dinheiro e clientes.` + sign };
  if (step === 1) return { subject: "Dois hábitos que evitam perder dinheiro e clientes", text: `${hi}\n\n1. Toda sexta, olhe três números: quanto entrou, quanto saiu e quanto sobrou. Se quiser fazer a conta de margem em segundos, use a calculadora gratuita:\n${SALES}/calculadora-margem-de-lucro?utm_source=email&utm_medium=nurture&utm_campaign=s1-${interest}\n\n2. Toda conversa com cliente termina com um próximo passo claro (responder a dúvida, mandar a proposta, combinar o retorno). Anote o que ficou combinado para não repetir mensagens.\n\nEsta mensagem é apenas uma dica prática; não contém oferta.` + sign };
  if (step === 2) return { subject: `${o.name}: o próximo passo depois do checklist`, text: `${hi}\n\nPelo que você estava lendo no nosso site, o material que mais combina com o seu momento é o ${o.name} (R$ ${o.price}, pagamento único).\n\nEle serve para ${o.promise}.\n\nVocê recebe tudo por e-mail logo após o pagamento e tem 7 dias de garantia: se não for para você, pede o reembolso integral, sem precisar explicar.\n\nVer o que vem dentro:\n${track(o.slug, 2, interest)}\n\nSe preferir comparar todos os materiais: ${SALES}/solucoes?utm_source=email&utm_medium=nurture&utm_campaign=s2-${interest}` + sign };
  if (step === 3) return { subject: "As dúvidas mais comuns antes de decidir", text: `${hi}\n\nAntes de comprar, quase todo mundo pergunta:\n\n• "Preciso entender de tecnologia?" Não. Tudo vem com o passo a passo no arquivo "Comece aqui".\n• "Quanto tempo leva?" Dá para começar no mesmo dia, seguindo o arquivo "Comece aqui". Depois, a rotina é curta e semanal.\n• "Substitui contador ou consultor?" Não. É um material prático de gestão do dia a dia.\n• "E se eu não gostar?" São 7 dias de garantia, com reembolso integral.\n\nSe alguma dúvida ficou, é só responder este e-mail.\n\n${o.name}: ${track(o.slug, 3, interest)}` + sign };
  return { subject: "Último e-mail desta sequência", text: `${hi}\n\nEste é o último e-mail da sequência do checklist. Depois dele, não envio mais nada sobre isso.\n\nSe você quiser resolver tudo de uma vez (IA, vendas e caixa), o Negócio Completo reúne os três materiais e mais um plano de 30 dias, por R$ 397 (separados custariam R$ 641). Garantia de 7 dias.\n${track("negocio-completo", 4, interest)}\n\nSe agora não é o momento, tudo bem. O checklist continua sendo seu:\n${CHECKLIST_URL}` + sign };
}

async function subscribe(env, sql, { email, name, consent, page }) {
  email = normEmail(email);
  name = String(name || "").trim().replace(/[\r\n<>]/g, " ").slice(0, 60);
  if (!EMAIL_RE.test(email) || email.length > 254) return { status: 400, body: { ok: false, message: "Confira o e-mail." } };
  if (consent !== true) return { status: 400, body: { ok: false, message: "Marque a autorização para receber o material." } };
  await ensureLeadSchema(sql);
  const existing = (await sql.query("select status, confirmed_at from zevanory_leads where email=$1", [email]))[0];
  if (existing?.status === "confirmed") {
    await sendEmail(env, { to: email, subject: "Seu checklist ZEVANORY", text: `Você já está inscrito(a). Aqui está o checklist de novo:\n${CHECKLIST_URL}\n\nNão quer mais receber? ${await leadOptOutLink(env, email)}`, unsubscribeUrl: await leadOptOutLink(env, email) });
    return { status: 200, body: { ok: true, message: "Enviamos o checklist para o seu e-mail." } };
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const ref = await subjectRef(env, email);
  await sql.query(`insert into zevanory_leads (email, email_hash, name, consent_version, consent_at, status, token_hash, token_expires_at, subject_ref)
      values ($1, $2, $3, $4, now(), 'pending', $5, now() + interval '48 hours', $6)
      on conflict (email) do update set name = excluded.name, consent_version = excluded.consent_version, consent_at = now(),
        status = case when zevanory_leads.status = 'unsubscribed' then 'pending' else zevanory_leads.status end,
        unsubscribed_at = null, token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at, subject_ref = excluded.subject_ref`,
    [email, await sha256Hex(email), name || null, CONSENT_VERSION, tokenHash, ref]);
  await recordEvent(sql, ref, "consent_given", CONSENT_VERSION);
  try { if (ref) await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.("zpc:lead:interest:" + ref, interestFromPage(page), { expirationTtl: 45 * 24 * 3600 }); } catch {}
  await emitActivity(env, { type: "lead_captured", channel: "web", status: "pending", ref: "lead:" + (ref || randomToken()) + ":" + new Date().toISOString().slice(0, 10) }).catch(() => null);
  const sent = await sendEmail(env, { to: email, subject: "Confirme seu e-mail para receber o checklist", text: `${name ? `Olá, ${name}!` : "Olá!"}\n\nFalta um clique: confirme seu e-mail para receber o checklist gratuito.\n${CORE}/material-gratuito/confirmar?t=${token}\n\nSe não foi você, ignore esta mensagem: nada será enviado.\n\nEquipe ZEVANORY · ${SUPPORT_EMAIL}` });
  if (!sent) return { status: 503, body: { ok: false, message: "Não conseguimos enviar agora. Tente de novo em instantes." } };
  return { status: 200, body: { ok: true, message: "Quase lá! Enviamos um link de confirmação para o seu e-mail." } };
}

async function confirm(env, sql, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return null;
  await ensureLeadSchema(sql);
  const rows = await sql.query(`update zevanory_leads set status='confirmed', confirmed_at=now(), token_hash=null, token_expires_at=null, nurture_step=1, nurture_at=now()
      where token_hash=$1 and token_expires_at > now() and status='pending' returning email, name, subject_ref, consent_version`, [await sha256Hex(token)]);
  const lead = rows[0];
  if (!lead) return null;
  const ref = lead.subject_ref || (await subjectRef(env, lead.email));
  await recordEvent(sql, ref, "confirmed", lead.consent_version || CONSENT_VERSION);
  const optOutUrl = await leadOptOutLink(env, lead.email);
  const mail = nurtureEmail(0, { name: lead.name, optOutUrl });
  const key = ref || randomToken();
  await sendEmail(env, { to: lead.email, ...mail, unsubscribeUrl: optOutUrl, idempotencyKey: `zevanory-lead-${key}-d0` });
  await emitActivity(env, { type: "lead_captured", channel: "web", status: "confirmed", ref: "lead-confirmed:" + key }).catch(() => null);
  await bridge(env, `lead-${key.slice(0, 12)}`, { kind: "lead", title: "Lead confirmado (material gratuito)", detail: "Pediu o checklist gratuito e confirmou o e-mail (dupla confirmação, consentimento LGPD registrado).", status: "nurture", channel: "email", sourceKey: `lead-magnet:${key.slice(0, 24)}`, evidence: ["double-opt-in", lead.consent_version || CONSENT_VERSION, new Date().toISOString()] });
  return lead;
}

const MIN_DAYS_BEFORE = { 1: 2, 2: 5, 3: 3, 4: 4 };
export async function runLeadNurture(env, { sqlFactory, salesOpen = false, now = Date.now() } = {}) {
  if (!env.DATABASE_URL || !sqlFactory) return { ok: false, reason: "lead_nurture_unconfigured" };
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureLeadSchema(sql);
  // Consent cap in ONE query (not one per lead: the hourly run shares 50 external subrequests).
  for (const [version, followups] of Object.entries(CONSENT_FOLLOWUPS)) {
    await sql.query("update zevanory_leads set nurture_step=$1 where status='confirmed' and consent_version=$2 and nurture_step >= $3 and nurture_step < $1", [NURTURE_DONE, version, 1 + followups]);
  }
  const due = await sql.query(`select email, name, nurture_step, nurture_at, consent_version, subject_ref from zevanory_leads
      where status='confirmed' and nurture_step < $1 and nurture_at < now() - interval '2 days' order by nurture_at asc limit 50`, [NURTURE_DONE]);
  const out = { ok: true, checked: due.length, sent: 0, held: 0 };
  for (const lead of due) {
    const step = Number(lead.nurture_step);
    const since = now - new Date(lead.nurture_at).getTime();
    // The consent text bounds the sequence: never send more e-mails than the person agreed to.
    const cap = 1 + (CONSENT_FOLLOWUPS[lead.consent_version] ?? 0);
    if (step >= cap) { await sql.query("update zevanory_leads set nurture_step=$2 where email=$1 and nurture_step < $2", [lead.email, NURTURE_DONE]); out.capped = (out.capped || 0) + 1; continue; }
    if (step >= 2 && !salesOpen) {
      // Offers only go out while customers can actually buy; give up after 30 days.
      if (since > 30 * DAY) await sql.query("update zevanory_leads set nurture_step=$2 where email=$1 and nurture_step < $2", [lead.email, NURTURE_DONE]);
      out.held += 1; continue;
    }
    if (since < (MIN_DAYS_BEFORE[step] || 2) * DAY) continue;
    const ref = lead.subject_ref || (await subjectRef(env, lead.email));
    let interest = "ia";
    try {
      const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
      interest = String((ref && await kv?.get?.("zpc:lead:interest:" + ref)) || await kv?.get?.("zpc:lead:interest:" + (await sha256Hex(lead.email))) || "ia");
    } catch {}
    const optOutUrl = await leadOptOutLink(env, lead.email);
    const mail = nurtureEmail(step, { name: lead.name, optOutUrl, interest });
    // Idempotency key: same value as before for legacy leads would need the plain hash; a keyed one is used now.
    const ok = await sendEmail(env, { to: lead.email, ...mail, unsubscribeUrl: optOutUrl, idempotencyKey: `zevanory-lead-${ref || (await sha256Hex(lead.email))}-s${step}` });
    if (ok) { await sql.query("update zevanory_leads set nurture_step=$2, nurture_at=now() where email=$1", [lead.email, step + 1]); out.sent += 1; }
  }
  try { out.retention = await runLeadRetention(env, sql); } catch (error) { out.retention = { ok: false, reason: error instanceof Error ? error.message.slice(0, 80) : "retention_failed" }; }
  return out;
}

// Retention (privacy policy): erase unconfirmed requests, revoked leads (legacy rows) and leads
// without interaction for 2 years; prune the pseudonymised event log. Once a day (KV marker), with
// exactly three database queries, because the hourly invocation shares the Workers Free budget of
// 50 external subrequests. Interest keys are KV (internal budget) and also expire on their own.
export const RETENTION_MARKER = "zpc:lead:retention:v1:last";
export async function runLeadRetention(env, sql, { now = Date.now(), force = false } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!force) { try { if ((await kv?.get?.(RETENTION_MARKER)) === day) return { ok: true, skipped: "already_ran_today" }; } catch {} }
  await ensureLeadSchema(sql);
  const erased = await sql.query(`delete from zevanory_leads where email in (select email from zevanory_leads
      where (status='pending' and token_expires_at < now() - make_interval(days => $1))
         or status='unsubscribed'
         or (status='confirmed' and coalesce(nurture_at, confirmed_at, consent_at) < now() - make_interval(days => $2))
      limit $3)
    returning email, subject_ref, consent_version, status`, [PENDING_GRACE_DAYS, INACTIVE_RETENTION_DAYS, RETENTION_BATCH]);
  const EVENT = { pending: "erased_unconfirmed", unsubscribed: "erased_revoked", confirmed: "erased_inactive" };
  const refs = [], events = [], versions = [];
  const counts = { erased_unconfirmed: 0, erased_revoked: 0, erased_inactive: 0 };
  for (const row of erased) {
    const ref = row.subject_ref || (await subjectRef(env, row.email));
    try { if (ref) await kv?.delete?.("zpc:lead:interest:" + ref); } catch {}
    try { await kv?.delete?.("zpc:lead:interest:" + (await sha256Hex(normEmail(row.email)))); } catch {}
    const event = EVENT[row.status] || "erased_inactive";
    counts[event] += 1; refs.push(ref); events.push(event); versions.push(row.consent_version || null);
  }
  if (erased.length) await sql.query("insert into zevanory_lead_events (subject_ref, event, consent_version) select * from unnest($1::text[], $2::text[], $3::text[])", [refs, events, versions]);
  const days = Number(env.LEAD_EVENT_RETENTION_DAYS) > 0 ? Math.floor(Number(env.LEAD_EVENT_RETENTION_DAYS)) : DEFAULT_EVENT_RETENTION_DAYS;
  await sql.query("delete from zevanory_lead_events where at < now() - make_interval(days => $1)", [days]);
  // A full batch means more rows are due: leave the marker unset so the next hour continues.
  if (erased.length < RETENTION_BATCH) { try { await kv?.put?.(RETENTION_MARKER, day, { expirationTtl: 3 * 86400 }); } catch {} }
  return { ok: true, erased: erased.length, ...counts, eventRetentionDays: days };
}

export async function handleLeadMagnet(request, env, { sqlFactory } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const internal = url.hostname === "leads.internal";
  if (!internal && !path.startsWith("/material-gratuito/")) return null;
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { ok: false, message: "Indisponível agora." });
  const sql = sqlFactory(env.DATABASE_URL);

  if (internal) {
    if (path !== "/subscribe" || request.method !== "POST") return json(404, { ok: false });
    let body = {};
    try { body = await request.json(); } catch {}
    try {
      const out = await subscribe(env, sql, body);
      return json(out.status, out.body);
    } catch (error) {
      console.error("lead_subscribe_failed", error instanceof Error ? error.message : String(error));
      return json(503, { ok: false, message: "Não conseguimos registrar agora. Tente de novo em instantes." });
    }
  }

  if (path === "/material-gratuito/confirmar") {
    const token = String(url.searchParams.get("t") || "");
    if (request.method === "GET" || request.method === "HEAD") {
      return html(200, "Confirmar meu e-mail", `<p>Clique para confirmar e receber o checklist gratuito.</p><form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirmar e receber</button></form>`);
    }
    if (request.method !== "POST") return json(405, { ok: false });
    let t = token;
    try { t = String((await request.formData()).get("t") || token); } catch {}
    const lead = await confirm(env, sql, t).catch(() => null);
    if (!lead) return html(400, "Link inválido ou expirado", `<p>Peça o material de novo na página <a href="${SALES}/material-gratuito">material gratuito</a>.</p>`);
    return html(200, "E-mail confirmado!", `<p>Seu checklist também foi enviado para o seu e-mail.</p><p><a class="b" href="${CHECKLIST_URL}">Abrir o checklist agora</a></p>`);
  }

  if (path === "/material-gratuito/sair") {
    // New links: r = keyed subject reference. Links already sent: i = legacy id (still honoured).
    const ref = String(url.searchParams.get("r") || "");
    const id = String(url.searchParams.get("i") || "");
    const t = String(url.searchParams.get("t") || "");
    let match = null;
    if (/^[0-9a-f]{64}$/.test(ref) && /^[0-9a-f]{32}$/.test(t) && privacySecret(env) && (await optOutToken(env, ref)) === t) match = { column: "subject_ref", value: ref };
    else if (/^[0-9a-f]{64}$/.test(id) && /^[0-9a-f]{32}$/.test(t) && secretFor(env) && (await hmacHex(secretFor(env), id)).slice(0, 32) === t) match = { column: "email_hash", value: id };
    const invalid = () => html(400, "Link inválido", "<p>Escreva para o suporte que removemos seu e-mail na hora.</p>");
    if (request.method === "GET" || request.method === "HEAD") return match ? html(200, "Parar de receber e apagar seus dados?", `<p>Você deixa de receber os e-mails do material gratuito e apagamos seu e-mail e seu nome desta lista.</p><form method="post"><button type="submit">Confirmar</button></form>`) : invalid();
    if (request.method !== "POST" || !match) return invalid();
    await ensureLeadSchema(sql);
    // Revocation = erasure of the lead data (privacy policy: kept "até você cancelar").
    const rows = await sql.query(`delete from zevanory_leads where ${match.column}=$1 returning email, subject_ref, consent_version`, [match.value]);
    for (const row of rows) await eraseLead(env, sql, row, "revoked_and_erased");
    if (!rows.length) await recordEvent(sql, match.column === "subject_ref" ? match.value : null, "revocation_without_record");
    return html(200, "Pronto.", "<p>Você não receberá mais e-mails da ZEVANORY sobre o material gratuito, e seu e-mail e seu nome foram apagados desta lista.</p>");
  }
  return null;
}
