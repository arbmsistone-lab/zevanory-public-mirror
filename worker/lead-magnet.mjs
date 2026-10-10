import { brandedEmailHtml } from "./brand-email.mjs";
// Lead magnet: free checklist in exchange for an e-mail, with explicit LGPD consent and double
// opt-in. Inbound only: nobody receives anything without asking for it and confirming the address.
// * Subscribe arrives only through the sales Worker's private binding (host leads.internal).
// * Confirmation link is single-use (token hash stored) and needs a click (POST), so mail scanners
//   never confirm on the person's behalf.
// * Nurture: D0 checklist, D+2 practical tips, D+5 catalog (only while sales are open). Every
//   e-mail carries one-click unsubscribe (RFC 8058). Activity is mirrored to the panel, masked.

const CORE = "https://zevanory.api.br";
const SALES = "https://vendas.zevanory.api.br";
const CHECKLIST_URL = `${SALES}/checklist-15-minutos`;
const SUPPORT_EMAIL = "suporte@zevanory.api.br";
const CONSENT_VERSION = "lead-magnet-v1-2026-10-07";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const DAY = 86_400_000;
let schemaReady = false;

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (status, title, body) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf6;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{width:100%;max-width:480px;background:#111a2c;border:1px solid #1f2b44;border-radius:12px;padding:28px}h1{font-size:21px;margin:0 0 12px}p{color:#a9b6c9;line-height:1.55}button,a.b{display:block;width:100%;box-sizing:border-box;text-align:center;background:#2dd4a7;color:#04241b;border:0;border-radius:8px;padding:14px 20px;font-weight:700;font-size:16px;cursor:pointer;text-decoration:none;min-height:44px}a{color:#2dd4a7}</style></head><body><main><h1>${esc(title)}</h1>${body}<p>Dúvidas: ${SUPPORT_EMAIL}</p></main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });

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
function secretFor(env) { return env.RESEND_API_KEY ? "zevanory-lead-optout-v1:" + env.RESEND_API_KEY : ""; }

export async function leadOptOutLink(env, email) {
  const id = await sha256Hex(String(email).trim().toLowerCase());
  const secret = secretFor(env);
  const t = secret ? (await hmacHex(secret, id)).slice(0, 32) : "";
  return `${CORE}/material-gratuito/sair?i=${id}&t=${t}`;
}

export async function ensureLeadSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_leads (
    email text primary key, email_hash text not null, name text, source text not null default 'material-gratuito',
    consent_version text not null, consent_at timestamptz not null, status text not null default 'pending',
    token_hash text, token_expires_at timestamptz, created_at timestamptz not null default now(),
    confirmed_at timestamptz, unsubscribed_at timestamptz, nurture_step integer not null default 0, nurture_at timestamptz)`, []);
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
  return Boolean(r?.ok);
}

async function bridge(env, key, entry) {
  try { await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(`zpc-activity:v1:${entry.kind}:${Date.now()}:${key}`, JSON.stringify(entry), { expirationTtl: 30 * 24 * 3600 }); } catch {}
}

export function nurtureEmail(step, { name, optOutUrl }) {
  const hi = name ? `Olá, ${name}!` : "Olá!";
  const sign = `\n\nEquipe ZEVANORY\n${SUPPORT_EMAIL}\n\nNão quer mais receber? ${optOutUrl}`;
  if (step === 0) return { subject: "Seu checklist: 15 minutos por dia para organizar o negócio", text: `${hi}\n\nAqui está o seu checklist gratuito:\n${CHECKLIST_URL}\n\nComece hoje pelo bloco do caixa (5 minutos). Em 2 dias eu te mando um jeito simples de não perder clientes por falta de follow-up.` + sign };
  if (step === 1) return { subject: "Follow-up: o hábito que reduz oportunidades perdidas", text: `${hi}\n\nUm processo comercial melhora quando cada conversa tem um próximo passo claro.\n\nTeste esta semana:\n1. Registre apenas contatos que iniciaram a conversa ou deram consentimento.\n2. Responda a dúvida concreta antes de sugerir qualquer próximo passo.\n3. Anote o resultado para não repetir mensagens.\n\nEsta mensagem é apenas uma dica prática; não contém oferta.` + sign };
  return { subject: "Os 5 pacotes da ZEVANORY (com garantia de 7 dias)", text: `${hi}\n\nSe o checklist ajudou, estes materiais aprofundam cada parte com modelos, planilhas e passo a passo:\n\n• IA na Prática — R$ 197\n• Vendas na Prática — R$ 197\n• Lucro & Caixa — R$ 247\n• Combo IA + Vendas — R$ 297\n• Negócio Completo — R$ 397\n\nTodos são digitais, chegam por e-mail após o pagamento e têm 7 dias de garantia.\n${SALES}/solucoes` + sign };
}

async function subscribe(env, sql, { email, name, consent }) {
  email = String(email || "").trim().toLowerCase();
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
  await sql.query(`insert into zevanory_leads (email, email_hash, name, consent_version, consent_at, status, token_hash, token_expires_at)
      values ($1, $2, $3, $4, now(), 'pending', $5, now() + interval '48 hours')
      on conflict (email) do update set name = excluded.name, consent_version = excluded.consent_version, consent_at = now(),
        status = case when zevanory_leads.status = 'unsubscribed' then 'pending' else zevanory_leads.status end,
        unsubscribed_at = null, token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at`,
    [email, await sha256Hex(email), name || null, CONSENT_VERSION, tokenHash]);
  const sent = await sendEmail(env, { to: email, subject: "Confirme seu e-mail para receber o checklist", text: `${name ? `Olá, ${name}!` : "Olá!"}\n\nFalta um clique: confirme seu e-mail para receber o checklist gratuito.\n${CORE}/material-gratuito/confirmar?t=${token}\n\nSe não foi você, ignore esta mensagem: nada será enviado.\n\nEquipe ZEVANORY · ${SUPPORT_EMAIL}` });
  if (!sent) return { status: 503, body: { ok: false, message: "Não conseguimos enviar agora. Tente de novo em instantes." } };
  return { status: 200, body: { ok: true, message: "Quase lá! Enviamos um link de confirmação para o seu e-mail." } };
}

async function confirm(env, sql, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return null;
  await ensureLeadSchema(sql);
  const rows = await sql.query(`update zevanory_leads set status='confirmed', confirmed_at=now(), token_hash=null, token_expires_at=null, nurture_step=1, nurture_at=now()
      where token_hash=$1 and token_expires_at > now() and status='pending' returning email, name`, [await sha256Hex(token)]);
  const lead = rows[0];
  if (!lead) return null;
  const optOutUrl = await leadOptOutLink(env, lead.email);
  const mail = nurtureEmail(0, { name: lead.name, optOutUrl });
  await sendEmail(env, { to: lead.email, ...mail, unsubscribeUrl: optOutUrl, idempotencyKey: `zevanory-lead-${await sha256Hex(lead.email)}-d0` });
  await bridge(env, `lead-${(await sha256Hex(lead.email)).slice(0, 12)}`, { kind: "lead", title: `Lead confirmado (material gratuito) · ${maskEmail(lead.email)}`, detail: "Pediu o checklist gratuito e confirmou o e-mail (dupla confirmação, consentimento LGPD registrado).", status: "nurture", channel: "email", sourceKey: `lead-magnet:${(await sha256Hex(lead.email)).slice(0, 24)}`, evidence: ["double-opt-in", CONSENT_VERSION, new Date().toISOString()] });
  return lead;
}

export async function runLeadNurture(env, { sqlFactory, salesOpen = false, now = Date.now() } = {}) {
  if (!env.DATABASE_URL || !sqlFactory) return { ok: false, reason: "lead_nurture_unconfigured" };
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureLeadSchema(sql);
  const due = await sql.query(`select email, name, nurture_step, nurture_at from zevanory_leads
      where status='confirmed' and nurture_step < 3 and nurture_at < now() - interval '2 days' order by nurture_at asc limit 50`, []);
  const out = { ok: true, checked: due.length, sent: 0, held: 0 };
  for (const lead of due) {
    const step = Number(lead.nurture_step);
    if (step === 2 && !salesOpen) {
      // The catalog e-mail only goes out while customers can actually buy; give up after 30 days.
      if (now - new Date(lead.nurture_at).getTime() > 30 * DAY) await sql.query("update zevanory_leads set nurture_step=3 where email=$1", [lead.email]);
      out.held += 1; continue;
    }
    if (step === 2 && now - new Date(lead.nurture_at).getTime() < 5 * DAY) continue; // one and only offer at D+7 overall
    const optOutUrl = await leadOptOutLink(env, lead.email);
    const mail = nurtureEmail(step, { name: lead.name, optOutUrl });
    const ok = await sendEmail(env, { to: lead.email, ...mail, unsubscribeUrl: optOutUrl, idempotencyKey: `zevanory-lead-${await sha256Hex(lead.email)}-s${step}` });
    if (ok) { await sql.query("update zevanory_leads set nurture_step=$2, nurture_at=now() where email=$1", [lead.email, step + 1]); out.sent += 1; }
  }
  return out;
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
    const id = String(url.searchParams.get("i") || "");
    const t = String(url.searchParams.get("t") || "");
    const secret = secretFor(env);
    const valid = Boolean(secret) && /^[0-9a-f]{64}$/.test(id) && /^[0-9a-f]{32}$/.test(t) && (await hmacHex(secret, id)).slice(0, 32) === t;
    if (request.method === "GET" || request.method === "HEAD") return valid ? html(200, "Parar de receber e-mails?", `<form method="post"><button type="submit">Confirmar descadastro</button></form>`) : html(400, "Link inválido", "<p>Escreva para o suporte que removemos seu e-mail na hora.</p>");
    if (request.method !== "POST" || !valid) return html(400, "Link inválido", "<p>Escreva para o suporte que removemos seu e-mail na hora.</p>");
    await ensureLeadSchema(sql);
    await sql.query("update zevanory_leads set status='unsubscribed', unsubscribed_at=now(), token_hash=null where email_hash=$1", [id]);
    return html(200, "Pronto.", "<p>Você não receberá mais e-mails da ZEVANORY sobre o material gratuito.</p>");
  }
  return null;
}
