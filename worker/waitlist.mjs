// ZEVANORY | Lista de espera real: "avisar quando as vendas abrirem" (decisão delegada 2026-10-25; Sol AVAL 272, A272-02).
//
// INERTE por padrão. Só existe quando env.WAITLIST_ENABLED === "true" (data/lista-de-espera.json, flag). Desligada:
//   * toda rota /lista-de-espera e /lista-de-espera/* responde 404 antes de qualquer acesso a banco, KV ou rede;
//   * o job de aviso não envia nada (no máximo apaga, uma vez por dia, dados que tenham sobrado de quando estava ligada).
// Nada liga a flag automaticamente: nenhum workflow, wrangler ou gerador a define (tests/waitlist.test.mjs).
//
// Separada do material gratuito (worker/lead-magnet.mjs), por desenho e por teste:
//   * tabelas próprias (zevanory_waitlist, zevanory_waitlist_events, zevanory_waitlist_state); este módulo nunca lê
//     nem escreve zevanory_leads e o material gratuito nunca lê a lista de espera;
//   * consentimento próprio e versionado (finalidade única: UM aviso de abertura das vendas; retenção; saída; controladora);
//   * abrir as vendas avisa SÓ quem confirmou a lista de espera; contato do checklist nunca vira destinatário do aviso.
//
// Fluxo: formulário (GET /lista-de-espera?produto=slug) -> inscrição (POST /lista-de-espera/inscrever, consentimento
// marcado, sem enumeração: resposta sempre igual) -> dupla confirmação (link de uso único, GET mostra botão, POST confirma)
// -> com as vendas ABERTAS (interruptor global do proprietário), o job horário reserva os registros confirmados de um
// contato, envia UM e-mail com todos os produtos dele (Idempotency-Key por contato e abertura) e APAGA os registros.
// Retenção: pendente apagado 7 dias depois de o link expirar; tudo apagado 30 dias depois de as vendas abrirem; teto
// absoluto de 365 dias desde o consentimento; saída (link do e-mail de confirmação) apaga na hora. Registro de eventos
// sem e-mail (referência HMAC com chave própria), para provar consentimento e revogação (LGPD art. 8º, §2º).
import WL from "../data/lista-de-espera.json" with { type: "json" };
import { SUPPLIER, SUPPORT_EMAIL, LEGAL_IDENTITY, WAITLIST_FORM } from "./politica-unica.mjs";
import { brandedEmailHtml } from "./brand-email.mjs";

export const WAITLIST_CONSENT_VERSION = WL.consent.version;
// Produtos da lista: o mesmo mapa nome -> slug que decide o link do CTA (data/politica-unica.json, waitlist_form.produtos).
export const WAITLIST_PRODUCTS = Object.freeze(Object.fromEntries(Object.entries(WAITLIST_FORM.produtos).map(([name, slug]) => [slug, name])));
export const WAITLIST_RETENTION = Object.freeze({ ...WL.retencao });
export const WAITLIST_BATCH = Number(WL.lote_aviso_por_execucao) || 10;
export const WAITLIST_HAS_DATA_KEY = "zpc:waitlist:v1:has-data";
export const WAITLIST_RETENTION_MARKER = "zpc:waitlist:v1:retention-day";
const CORE = "https://zevanory.api.br";
const SALES = "https://vendas.zevanory.api.br";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const PATH = "/lista-de-espera";

export function waitlistEnabled(env) {
  return String(env?.[WL.flag.env] ?? "") === WL.flag.on_value;
}

export function waitlistConsentText(product) {
  const name = WAITLIST_PRODUCTS[product];
  if (!name) throw new Error("waitlist_unknown_product");
  return WL.consent.text
    .replaceAll("{produto}", name)
    .replaceAll("{dias_apos_abertura}", String(WAITLIST_RETENTION.dias_apos_abertura))
    .replaceAll("{teto_meses}", String(Math.round(WAITLIST_RETENTION.teto_dias / 30.4)))
    .replaceAll("{razao_social}", SUPPLIER.razao_social)
    .replaceAll("{cnpj}", SUPPLIER.cnpj)
    .replaceAll("{email}", SUPPORT_EMAIL);
}

export const WAITLIST_SQL = Object.freeze({
  schema: [
    `create table if not exists zevanory_waitlist (
      email text not null, product text not null, subject_ref text not null,
      status text not null default 'pending' check (status in ('pending','confirmed','notifying')),
      consent_version text not null, consent_at timestamptz not null default now(),
      token_hash text, token_expires_at timestamptz, confirmed_at timestamptz, notify_claimed_at timestamptz,
      created_at timestamptz not null default now(), primary key (email, product))`,
    `create table if not exists zevanory_waitlist_events (id bigserial primary key, subject_ref text, product text,
      event text not null, consent_version text, at timestamptz not null default now())`,
    `create table if not exists zevanory_waitlist_state (k text primary key, v timestamptz not null)`,
  ],
});

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (v) => hex(await crypto.subtle.digest("SHA-256", enc.encode(String(v))));
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(String(value))));
}
function randomToken() { const b = new Uint8Array(32); crypto.getRandomValues(b); return hex(b); }
// Chave própria (separação de domínio) a partir do mesmo segredo de privacidade do material gratuito: uma referência da
// lista de espera nunca coincide com a do checklist para o mesmo e-mail (não dá para cruzar as duas listas pelo registro).
const keyOf = (v) => (v && String(v).length >= 32 ? "zevanory-waitlist-privacy-v1:" + v : "");
const privacyKeys = (env) => [keyOf(env.LEAD_PRIVACY_SECRET), keyOf(env.LEAD_PRIVACY_SECRET_PREVIOUS)].filter(Boolean);
const normEmail = (e) => String(e || "").trim().toLowerCase();
export async function waitlistSubjectRef(env, email) {
  const k = privacyKeys(env)[0];
  return k ? hmacHex(k, "subject:" + normEmail(email)) : null;
}
const optOutToken = async (key, ref) => (await hmacHex(key, "waitlist-optout:" + ref)).slice(0, 32);
export async function waitlistOptOutLink(env, ref) {
  return `${CORE}${PATH}/sair?r=${ref}&t=${await optOutToken(privacyKeys(env)[0], ref)}`;
}
async function optOutValid(env, ref, t) {
  for (const k of privacyKeys(env)) if ((await optOutToken(k, ref)) === t) return true;
  return false;
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
export const notFound = () => new Response("not_found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE } });
const page = (status, title, body) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ZEVANORY</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#040a12;color:#f5f8fc;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{width:100%;max-width:520px;background:#07111d;border:1px solid #16304a;border-radius:12px;padding:28px}h1{font-size:21px;margin:0 0 12px}p,label{color:#c3cede;line-height:1.55}input[type=email]{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #24324f;background:#0b1220;color:#fff;font-size:16px;min-height:44px}.c{display:flex;gap:10px;align-items:flex-start;margin:16px 0}.c input{width:22px;height:22px;flex:none;margin-top:3px}.hp{position:absolute;left:-10000px}button{display:block;width:100%;background:#00b8ff;color:#03101c;border:0;border-radius:8px;padding:14px 20px;font-weight:700;font-size:16px;cursor:pointer;min-height:44px}a{color:#21e6f3}small{color:#8796ad}</style></head><body><main><h1>${esc(title)}</h1>${body}<p><small>${esc(LEGAL_IDENTITY)} · ${esc(SUPPORT_EMAIL)}</small></p></main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE, "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });
const GENERIC_OK = "Se o e-mail estiver correto, você vai receber agora um link para confirmar. Sem a confirmação, nada fica guardado por mais de 10 dias.";

async function ensureSchema(sql) { for (const s of WAITLIST_SQL.schema) await sql.query(s, []); }
async function recordEvent(sql, ref, product, event, version = null) {
  await sql.query("insert into zevanory_waitlist_events (subject_ref, product, event, consent_version) values ($1, $2, $3, $4)", [ref, product, event, version]);
}

async function sendEmail(env, fetchImpl, { to, subject, text, idempotencyKey, unsubscribeUrl }) {
  if (!env.RESEND_API_KEY) return false;
  const headers = { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey };
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST", headers,
    body: JSON.stringify({ from: `ZEVANORY <${SUPPORT_EMAIL}>`, to: [to], reply_to: SUPPORT_EMAIL, subject, text, html: brandedEmailHtml(text, { unsubscribeUrl }),
      ...(unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=sair-lista-de-espera>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } } : {}),
      tags: [{ name: "flow", value: "waitlist" }] }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return Boolean(r?.ok);
}

async function rateLimited(env, request) {
  try {
    const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const key = `zpc:waitlist:rate:${new Date().toISOString().slice(0, 13)}:${await sha256Hex(ip)}`;
    const n = Number((await kv?.get?.(key)) || 0);
    if (n >= 6) return true;
    await kv?.put?.(key, String(n + 1), { expirationTtl: 3600 });
  } catch {}
  return false;
}

function formPage(product, error = "") {
  return page(error ? 400 : 200, `Avise-me quando as vendas do ${WAITLIST_PRODUCTS[product]} abrirem`, `${error ? `<p role="alert">${esc(error)}</p>` : ""}
<form method="post" action="${PATH}/inscrever"><input type="hidden" name="produto" value="${esc(product)}">
<label for="wl-email">Seu e-mail</label><input id="wl-email" name="email" type="email" required autocomplete="email" maxlength="254">
<div class="hp" aria-hidden="true"><label for="wl-site">Não preencha</label><input id="wl-site" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="c"><input id="wl-consent" type="checkbox" name="consentimento" value="sim" required><label for="wl-consent">${esc(waitlistConsentText(product))} <a href="${SALES}/privacidade">Política de Privacidade</a>.</label></div>
<input type="hidden" name="versao_consentimento" value="${esc(WAITLIST_CONSENT_VERSION)}">
<button type="submit">Quero ser avisado</button></form>`);
}

async function subscribe(env, sql, fetchImpl, { email, product, consent, version }, salesOpen) {
  email = normEmail(email);
  if (!Object.prototype.hasOwnProperty.call(WAITLIST_PRODUCTS, product)) return notFound();
  if (salesOpen === true) return page(200, "As vendas estão abertas", `<p>Não é preciso entrar na lista de espera: as vendas do ${esc(WAITLIST_PRODUCTS[product])} estão abertas agora.</p><p><a href="${SALES}/${esc(product)}">Ver o produto</a></p>`);
  if (!EMAIL_RE.test(email) || email.length > 254) return formPage(product, "Confira o e-mail.");
  // O consentimento registrado é o texto que a pessoa viu: a versão enviada pelo formulário tem de ser a atual.
  if (consent !== "sim" || version !== WAITLIST_CONSENT_VERSION) return formPage(product, "Marque a autorização para receber o aviso.");
  const ref = await waitlistSubjectRef(env, email);
  await ensureSchema(sql);
  const token = randomToken();
  const rows = await sql.query(`insert into zevanory_waitlist (email, product, subject_ref, status, consent_version, consent_at, token_hash, token_expires_at)
      values ($1, $2, $3, 'pending', $4, now(), $5, now() + ($6::int * interval '1 hour'))
      on conflict (email, product) do update set consent_version = excluded.consent_version, consent_at = now(),
        token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at
        where zevanory_waitlist.status = 'pending'
      returning status`, [email, product, ref, WAITLIST_CONSENT_VERSION, await sha256Hex(token), WAITLIST_RETENTION.link_confirmacao_horas]);
  // Já confirmado (ou em aviso): nada muda e nada é enviado; a resposta é a mesma (sem revelar quem está na lista).
  if (!rows.length) return page(200, "Quase lá!", `<p>${esc(GENERIC_OK)}</p>`);
  await recordEvent(sql, ref, product, "consent_given", WAITLIST_CONSENT_VERSION);
  try { await env.ZEVANORY_PRIVATE_ARTIFACTS?.put?.(WAITLIST_HAS_DATA_KEY, "1", { expirationTtl: 400 * 86400 }); } catch {}
  const optOut = await waitlistOptOutLink(env, ref);
  const sent = await sendEmail(env, fetchImpl, {
    to: email, idempotencyKey: `zevanory-waitlist-confirm-${ref}-${product}-${(await sha256Hex(token)).slice(0, 16)}`, unsubscribeUrl: optOut,
    subject: `Confirme: aviso de abertura das vendas do ${WAITLIST_PRODUCTS[product]}`,
    text: `Olá!\n\nFalta um clique para você ser avisado(a) quando as vendas do ${WAITLIST_PRODUCTS[product]} abrirem:\n${CORE}${PATH}/confirmar?t=${token}\n\nO que você autorizou: ${waitlistConsentText(product)}\n\nSe não foi você, ignore esta mensagem: sem a confirmação, nada é enviado e o pedido é apagado em até 10 dias.\nSair da lista e apagar seus dados agora: ${optOut}\n\nEquipe ZEVANORY · ${SUPPORT_EMAIL}\n${LEGAL_IDENTITY}`,
  });
  if (!sent) return page(503, "Não foi possível concluir", "<p>Não conseguimos enviar o e-mail de confirmação agora. Tente de novo em instantes.</p>");
  return page(200, "Quase lá!", `<p>${esc(GENERIC_OK)}</p>`);
}

async function confirm(env, sql, token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ""))) return null;
  await ensureSchema(sql);
  const rows = await sql.query(`update zevanory_waitlist set status='confirmed', confirmed_at=now(), token_hash=null, token_expires_at=null
      where token_hash=$1 and token_expires_at > now() and status='pending' returning subject_ref, product, consent_version`, [await sha256Hex(token)]);
  if (!rows[0]) return null;
  await recordEvent(sql, rows[0].subject_ref, rows[0].product, "confirmed", rows[0].consent_version);
  return rows[0];
}

export async function handleWaitlist(request, env, { sqlFactory, fetchImpl = fetch, salesOpen = false } = {}) {
  let url;
  try { url = new URL(request.url); } catch { return null; }
  const path = url.pathname;
  if (path !== PATH && !path.startsWith(PATH + "/")) return null;
  // Desligada: 404 antes de qualquer banco, KV ou rede.
  if (!waitlistEnabled(env)) return notFound();
  const method = String(request.method || "GET").toUpperCase();
  if (!sqlFactory || !env.DATABASE_URL || !privacyKeys(env).length || !env.RESEND_API_KEY) return page(503, "Indisponível agora", "<p>Tente de novo mais tarde.</p>");
  const sql = sqlFactory(env.DATABASE_URL);

  if (path === PATH || path === PATH + "/") {
    if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD", ...NO_STORE } });
    const product = String(url.searchParams.get("produto") || "");
    if (!Object.prototype.hasOwnProperty.call(WAITLIST_PRODUCTS, product)) return notFound();
    if (salesOpen === true) return page(200, "As vendas estão abertas", `<p>As vendas do ${esc(WAITLIST_PRODUCTS[product])} estão abertas agora.</p><p><a href="${SALES}/${esc(product)}">Ver o produto</a></p>`);
    return formPage(product);
  }
  if (path === PATH + "/inscrever") {
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });
    if (await rateLimited(env, request)) return page(429, "Muitas tentativas", "<p>Aguarde um pouco e tente de novo.</p>");
    let form; try { form = await request.formData(); } catch { form = new FormData(); }
    if (String(form.get("website") || "")) return page(200, "Quase lá!", `<p>${esc(GENERIC_OK)}</p>`);
    return subscribe(env, sql, fetchImpl, { email: form.get("email"), product: String(form.get("produto") || ""), consent: String(form.get("consentimento") || ""), version: String(form.get("versao_consentimento") || "") }, salesOpen);
  }
  if (path === PATH + "/confirmar") {
    const token = String(url.searchParams.get("t") || "");
    if (method === "GET" || method === "HEAD") return page(200, "Confirmar o aviso", `<p>Clique para confirmar que quer receber um único e-mail quando as vendas abrirem.</p><form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirmar</button></form>`);
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, HEAD, POST", ...NO_STORE } });
    let t = token; try { t = String((await request.formData()).get("t") || token); } catch {}
    const row = await confirm(env, sql, t).catch(() => null);
    if (!row) return page(400, "Link inválido ou expirado", "<p>Peça o aviso de novo na página do produto.</p>");
    return page(200, "Pronto!", `<p>Você será avisado(a) por e-mail, uma única vez, quando as vendas do ${esc(WAITLIST_PRODUCTS[row.product] || "produto")} abrirem. Depois do aviso, seus dados são apagados.</p>`);
  }
  if (path === PATH + "/sair") {
    const ref = String(url.searchParams.get("r") || ""), t = String(url.searchParams.get("t") || "");
    const ok = /^[0-9a-f]{64}$/.test(ref) && /^[0-9a-f]{32}$/.test(t) && (await optOutValid(env, ref, t));
    if (!ok) return page(400, "Link inválido", `<p>Escreva para ${esc(SUPPORT_EMAIL)} que removemos seu e-mail na hora.</p>`);
    if (method === "GET" || method === "HEAD") return page(200, "Sair da lista de espera e apagar seus dados?", `<form method="post"><button type="submit">Confirmar</button></form>`);
    if (method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, HEAD, POST", ...NO_STORE } });
    await ensureSchema(sql);
    const rows = await sql.query("delete from zevanory_waitlist where subject_ref=$1 returning product, consent_version", [ref]);
    for (const r of rows) await recordEvent(sql, ref, r.product, "revoked_and_erased", r.consent_version);
    if (!rows.length) await recordEvent(sql, ref, null, "revocation_without_record");
    return page(200, "Pronto.", "<p>Você saiu da lista de espera e seus dados foram apagados.</p>");
  }
  return notFound();
}

function noticeText(products) {
  const lines = products.map((p) => `• ${WAITLIST_PRODUCTS[p] || p}: ${SALES}/${p}?utm_source=email&utm_medium=waitlist&utm_campaign=aviso-abertura`);
  return `Olá!\n\nVocê pediu para ser avisado(a) quando as vendas abrissem. Elas abriram:\n\n${lines.join("\n")}\n\nEste é o único aviso: depois deste envio, seu e-mail foi apagado da lista de espera e você não receberá outras mensagens por causa dela.\n\nEquipe ZEVANORY · ${SUPPORT_EMAIL}\n${LEGAL_IDENTITY}`;
}

// Retenção (uma vez por dia; também com a flag desligada, se a lista já guardou algo).
export async function runWaitlistRetention(env, sql, { now = Date.now(), force = false } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!force) { try { if ((await kv?.get?.(WAITLIST_RETENTION_MARKER)) === day) return { ok: true, skipped: "already_ran_today" }; } catch {} }
  await ensureSchema(sql);
  const R = WAITLIST_RETENTION;
  const erased = await sql.query(`delete from zevanory_waitlist w where
        (w.status='pending' and w.token_expires_at < now() - ($1::int * interval '1 day'))
     or (w.consent_at < now() - ($2::int * interval '1 day'))
     or exists (select 1 from zevanory_waitlist_state s where s.k='sales_open_since' and s.v < now() - ($3::int * interval '1 day'))
    returning subject_ref, product, consent_version, status`, [R.pendente_dias_apos_expirar, R.teto_dias, R.dias_apos_abertura]);
  if (erased.length) await sql.query("insert into zevanory_waitlist_events (subject_ref, product, event, consent_version) select * from unnest($1::text[], $2::text[], $3::text[], $4::text[])",
    [erased.map((r) => r.subject_ref), erased.map((r) => r.product), erased.map((r) => (r.status === "pending" ? "erased_unconfirmed" : "erased_retention")), erased.map((r) => r.consent_version)]);
  await sql.query("delete from zevanory_waitlist_events where at < now() - ($1::int * interval '1 day')", [R.eventos_dias]);
  try { await kv?.put?.(WAITLIST_RETENTION_MARKER, day, { expirationTtl: 3 * 86400 }); } catch {}
  return { ok: true, erased: erased.length };
}

// Job horário. Envia SOMENTE com a flag ligada E as vendas abertas (interruptor global, fail-closed: só salesOpen === true).
export async function runWaitlistNotify(env, { sqlFactory, salesOpen = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const enabled = waitlistEnabled(env);
  if (!enabled) {
    let hadData = null;
    try { hadData = await env.ZEVANORY_PRIVATE_ARTIFACTS?.get?.(WAITLIST_HAS_DATA_KEY); } catch {}
    if (!hadData || !env.DATABASE_URL || !sqlFactory) return { ok: true, skipped: "waitlist_disabled", sent: 0 };
    return { ok: true, skipped: "waitlist_disabled", sent: 0, retention: await runWaitlistRetention(env, sqlFactory(env.DATABASE_URL), { now }) };
  }
  if (!env.DATABASE_URL || !sqlFactory) return { ok: false, reason: "waitlist_unconfigured", sent: 0 };
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureSchema(sql);
  const out = { ok: true, sent: 0, failed: 0, contacts: 0 };
  if (salesOpen !== true) {
    // Vendas fechadas: nada é enviado; uma próxima abertura recomeça a contagem dos 30 dias.
    await sql.query("delete from zevanory_waitlist_state where k='sales_open_since'", []);
    out.reason = "sales_closed";
    out.retention = await runWaitlistRetention(env, sql, { now });
    return out;
  }
  await sql.query("insert into zevanory_waitlist_state (k, v) values ('sales_open_since', now()) on conflict (k) do nothing", []);
  const opening = (await sql.query("select to_char(v at time zone 'UTC', 'YYYYMMDDHH24MISS') as stamp from zevanory_waitlist_state where k='sales_open_since'", []))[0]?.stamp || "x";
  // Reserva abandonada (queda entre reservar e terminar): volta para confirmado; a mesma Idempotency-Key impede 2º envio.
  await sql.query("update zevanory_waitlist set status='confirmed', notify_claimed_at=null where status='notifying' and notify_claimed_at < now() - interval '1 hour'", []);
  const due = await sql.query("select email from zevanory_waitlist where status='confirmed' group by email order by min(confirmed_at) limit $1", [WAITLIST_BATCH]);
  for (const { email } of due) {
    // Reserva atômica de TODOS os registros confirmados do contato: um único aviso por contato, mesmo com execuções simultâneas.
    const claimed = await sql.query("update zevanory_waitlist set status='notifying', notify_claimed_at=now() where email=$1 and status='confirmed' returning product, subject_ref, consent_version", [email]);
    if (!claimed.length) continue;
    out.contacts += 1;
    const products = [...new Set(claimed.map((r) => r.product))].sort();
    const ref = claimed[0].subject_ref;
    const ok = await sendEmail(env, fetchImpl, { to: email, idempotencyKey: `zevanory-waitlist-notice-${ref}-${opening}`, subject: products.length === 1 ? `As vendas do ${WAITLIST_PRODUCTS[products[0]]} abriram` : "As vendas abriram", text: noticeText(products) });
    if (!ok) {
      await sql.query("update zevanory_waitlist set status='confirmed', notify_claimed_at=null where email=$1 and status='notifying'", [email]);
      out.failed += 1;
      continue;
    }
    // Finalidade cumprida: apaga na hora.
    const gone = await sql.query("delete from zevanory_waitlist where email=$1 and status='notifying' returning product, consent_version", [email]);
    for (const r of gone) await recordEvent(sql, ref, r.product, "notified_and_erased", r.consent_version);
    out.sent += 1;
  }
  out.retention = await runWaitlistRetention(env, sql, { now });
  return out;
}
