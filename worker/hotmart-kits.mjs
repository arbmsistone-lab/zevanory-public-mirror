// ZEVANORY | Modelo B (Sol ORDEM 313): kits vendidos na Hotmart, entregues SOMENTE pela área de membros (Hotmart Club).
//
// Este módulo faz três coisas, nada mais:
//   1) INGESTÃO: grava o estado de cada compra de kit a partir dos postbacks Hotmart já autenticados por
//      worker/content-service.mjs (hottok em tempo constante). Aprovação/conclusão => approved; reembolso,
//      chargeback e cancelamento => estado terminal (nunca volta a approved, nem com evento fora de ordem);
//      PURCHASE_PROTEST (reembolso solicitado) só marca protest_at, sem revogar (pergunta Q3 ao Sol).
//      Idempotente por (evento, transação) no PostgreSQL; nada vai para o KV (propagação de até 60 s).
//   2) CONTINGÊNCIA (S313-03): quando o Club está fora do ar, o operador autenticado (operador + motivo) pede um
//      link para UMA compra. Fluxo obrigatório: identifica a transação -> lê o estado atual sincronizado pelos
//      postbacks (falha na leitura = nenhum link, 503) -> confere que o e-mail informado é o do comprador (HMAC) ->
//      calcula os arquivos autorizados (dia 1 sempre; dia 8 só depois de 8 dias inteiros desde a aprovação, fuso
//      America/Sao_Paulo) -> gera link individual, curto e revogável, enviado SÓ ao e-mail do comprador -> registra o
//      evento sem token nem e-mail -> cada acesso revalida compra, link, contingência e dia 8 (reembolso, chargeback
//      ou cancelamento bloqueiam até link já emitido). Um serviço único para os 5 kits; DESLIGADO por padrão (estado
//      no PostgreSQL, ligado só pelo operador com motivo, por no máximo 72 h).
//   3) Nunca entrega o ZIP completo do KV legado (catálogo v1.1): o catálogo da contingência é o de data/hotmart-kits.json.
//
// Sem credencial neste arquivo: a autenticação do operador é injetada pelo roteador (isOperator), que usa o resolvedor
// único worker/operator-credential.mjs. Dados pessoais: transação e e-mail só como HMAC (chave KITS_PRIVACY_SECRET,
// ou LEAD_PRIVACY_SECRET na falta dela, sempre com separação de domínio).
import KITS from "../data/hotmart-kits.json" with { type: "json" };
import { ENTREGA_CLUB } from "./politica-unica.mjs";
import { brandedEmailHtml } from "./brand-email.mjs";

export const KITS_DATA = KITS;
export const TZ = KITS.fuso;
export const RELEASE_RULE = Object.freeze({ ...KITS.liberacao_dia8 });
export const CONTINGENCY = Object.freeze({ ...KITS.contingencia });
const enc = new TextEncoder();
const HOUR = 3_600_000;

// ---------- produto Hotmart -> SKU (configurável: data/hotmart-kits.json + HOTMART_KIT_PRODUCT_IDS "id=SKU,id=SKU") ----------
const SKUS = new Set(KITS.kits.map((k) => k.sku));
export function kitProductMap(env = {}) {
  const map = new Map();
  for (const k of KITS.kits) for (const id of k.hotmart_product_ids || []) map.set(String(id), k.sku);
  for (const pair of String(env.HOTMART_KIT_PRODUCT_IDS || "").split(",")) {
    const [id, sku] = pair.split("=").map((x) => String(x || "").trim());
    if (/^\d{1,20}$/.test(id) && SKUS.has(sku)) map.set(id, sku);
  }
  return map;
}
export function kitSkuFor(data = {}, env = {}) {
  const id = String(data?.product?.id ?? "").trim();
  return id ? kitProductMap(env).get(id) || null : null;
}
export const kitName = (sku) => (KITS.kits.find((k) => k.sku === sku) || {}).nome || "kit ZEVANORY";

// ---------- regra do dia 8 ----------
function wall(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
function offsetMs(ms, tz) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}
// Liberação = o MAIS TARDIO entre (a) aprovação + horas_minimas e (b) o mesmo horário de parede de America/Sao_Paulo
// no dia civil aprovação + dias_civis. Sem horário de verão os dois coincidem (8 dias = 192 h); com horário de verão,
// (b) impede que a mudança de relógio antecipe a liberação. Nunca antes de approved + 192 h.
export function day8ReleaseAt(approvedMs, { rule = RELEASE_RULE, tz = TZ } = {}) {
  const a = Number(approvedMs);
  if (!Number.isFinite(a)) return Infinity;
  const byHours = a + Number(rule.horas_minimas) * HOUR;
  const w = wall(a, tz);
  const target = Date.UTC(w.y, w.m - 1, w.d + Number(rule.dias_civis), w.h, w.mi, w.s) + (((a % 1000) + 1000) % 1000);
  let inst = target - offsetMs(target, tz);
  inst = target - offsetMs(inst, tz);
  return Math.max(byHours, inst);
}
export const day8Released = (approvedMs, nowMs, opts) => Number(nowMs) >= day8ReleaseAt(approvedMs, opts);
export function brt(ms) {
  const w = wall(ms, TZ);
  const z = (n) => String(n).padStart(2, "0");
  return `${z(w.d)}/${z(w.m)}/${w.y} às ${z(w.h)}:${z(w.mi)}`;
}
export function catalogFor(sku, catalog = KITS.catalogo_contingencia) { return (catalog || {})[sku] || []; }
// Arquivos autorizados AGORA para uma compra aprovada: dia 1 sempre; dia 8 só depois da liberação.
export function authorizedFiles(sku, approvedMs, nowMs, catalog = KITS.catalogo_contingencia) {
  const open8 = day8Released(approvedMs, nowMs);
  return catalogFor(sku, catalog).filter((f) => f.liberacao === "dia1" || (f.liberacao === "dia8" && open8));
}

// ---------- privacidade ----------
export function privacySecret(env = {}) {
  const v = String(env.KITS_PRIVACY_SECRET || env.LEAD_PRIVACY_SECRET || "");
  return v.length >= 32 ? v : "";
}
export async function ref(secret, domain, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode("zevanory-kits-v1:" + domain + ":" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(String(value))))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const normTxn = (t) => String(t || "").trim().toUpperCase();
const normEmail = (e) => String(e || "").trim().toLowerCase();
async function sha256Hex(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join(""); }

// ---------- PostgreSQL ----------
const REVOKED = "('refunded','chargeback','canceled')";
export const KITS_SQL = Object.freeze({
  schema: [
    `/*kits:schema*/ create table if not exists hotmart_kit_purchases (
      transaction_ref text primary key, sku text not null,
      status text not null check (status in ('unknown','approved','refunded','chargeback','canceled')),
      approved_at timestamptz, buyer_email_ref text, protest_at timestamptz, revoked_at timestamptz,
      last_event text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
    `/*kits:schema*/ create table if not exists hotmart_kit_events (
      event_key text primary key, transaction_ref text not null, event text not null, received_at timestamptz not null default now())`,
    `/*kits:schema*/ create table if not exists hotmart_kit_links (
      token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'), transaction_ref text not null, sku text not null,
      expires_at timestamptz not null, revoked_at timestamptz, uses integer not null default 0, max_uses integer not null,
      actor text not null, created_at timestamptz not null default now())`,
    `/*kits:schema*/ create table if not exists hotmart_kit_contingency (
      id integer primary key check (id = 1), enabled boolean not null, until timestamptz not null,
      actor text not null, reason text not null, at timestamptz not null default now())`,
    `/*kits:schema*/ create table if not exists hotmart_kit_audit (
      id bigserial primary key, at timestamptz not null default now(), kind text not null, transaction_ref text,
      actor text, reason text, outcome text not null)`,
  ],
  // Um comando: o evento só altera a compra se for novo (ON CONFLICT DO NOTHING no registro do evento).
  // Estado terminal é pegajoso; PROTEST não muda o estado; approved_at e e-mail só são preenchidos uma vez.
  ingest: `/*kits:ingest*/ with ev as (
      insert into hotmart_kit_events (event_key, transaction_ref, event) values ($1, $2, $3)
      on conflict (event_key) do nothing returning 1)
    insert into hotmart_kit_purchases (transaction_ref, sku, status, approved_at, buyer_email_ref, protest_at, revoked_at, last_event)
    select $2, $4, case when $5 = 'protest' then 'unknown' else $5 end, $6::timestamptz, $7,
      case when $5 = 'protest' then now() end, case when $5 in ${REVOKED} then now() end, $3 from ev
    on conflict (transaction_ref) do update set
      status = case when hotmart_kit_purchases.status in ${REVOKED} then hotmart_kit_purchases.status
                    when excluded.status = 'unknown' then hotmart_kit_purchases.status else excluded.status end,
      approved_at = coalesce(hotmart_kit_purchases.approved_at, excluded.approved_at),
      buyer_email_ref = coalesce(hotmart_kit_purchases.buyer_email_ref, excluded.buyer_email_ref),
      protest_at = coalesce(hotmart_kit_purchases.protest_at, excluded.protest_at),
      revoked_at = coalesce(hotmart_kit_purchases.revoked_at, excluded.revoked_at),
      last_event = excluded.last_event, updated_at = now()
    returning status`,
  revokeLinks: `/*kits:revoke-links*/ update hotmart_kit_links set revoked_at = now() where transaction_ref = $1 and revoked_at is null returning 1`,
  purchase: `/*kits:purchase*/ select sku, status, buyer_email_ref, (protest_at is not null)::text as protest,
      (extract(epoch from approved_at) * 1000)::bigint::text as approved_ms from hotmart_kit_purchases where transaction_ref = $1`,
  state: `/*kits:state*/ select enabled::text as enabled, (extract(epoch from until) * 1000)::bigint::text as until_ms,
      (enabled and until > now())::text as open from hotmart_kit_contingency where id = 1`,
  setState: `/*kits:set-state*/ insert into hotmart_kit_contingency (id, enabled, until, actor, reason) values (1, $1::boolean, now() + make_interval(hours => $2::int), $3, $4)
    on conflict (id) do update set enabled = excluded.enabled, until = excluded.until, actor = excluded.actor, reason = excluded.reason, at = now()
    returning (extract(epoch from until) * 1000)::bigint::text as until_ms`,
  issue: `/*kits:issue*/ insert into hotmart_kit_links (token_sha256, transaction_ref, sku, expires_at, max_uses, actor)
    select $1, $2, $3, least(now() + make_interval(mins => $4::int), c.until), $5::int, $6
      from hotmart_kit_contingency c where c.id = 1 and c.enabled and c.until > now()
    returning (extract(epoch from expires_at) * 1000)::bigint::text as expires_ms`,
  // Validação de cada acesso: link vivo + compra aprovada e não revogada + contingência ligada. O download conta um uso
  // no MESMO comando (sem ler-e-depois-escrever).
  view: `/*kits:view*/ select l.transaction_ref, l.sku, (extract(epoch from p.approved_at) * 1000)::bigint::text as approved_ms,
      (extract(epoch from l.expires_at) * 1000)::bigint::text as expires_ms
    from hotmart_kit_links l join hotmart_kit_purchases p on p.transaction_ref = l.transaction_ref
    join hotmart_kit_contingency c on c.id = 1 and c.enabled and c.until > now()
    where l.token_sha256 = $1 and l.revoked_at is null and l.expires_at > now() and l.uses < l.max_uses
      and p.status = 'approved' and p.revoked_at is null and p.approved_at is not null`,
  use: `/*kits:use*/ update hotmart_kit_links l set uses = l.uses + 1
    from hotmart_kit_purchases p, hotmart_kit_contingency c
    where l.token_sha256 = $1 and l.revoked_at is null and l.expires_at > now() and l.uses < l.max_uses
      and p.transaction_ref = l.transaction_ref and p.status = 'approved' and p.revoked_at is null and p.approved_at is not null
      and c.id = 1 and c.enabled and c.until > now()
    returning l.transaction_ref, l.sku, (extract(epoch from p.approved_at) * 1000)::bigint::text as approved_ms`,
  revokeLink: `/*kits:revoke-link*/ update hotmart_kit_links set revoked_at = now() where token_sha256 = $1 and revoked_at is null`,
  audit: `/*kits:audit*/ insert into hotmart_kit_audit (kind, transaction_ref, actor, reason, outcome) values ($1, $2, $3, $4, $5)`,
});
const schemaDone = new WeakSet();
async function ensureSchema(sql, q = KITS_SQL) {
  if (schemaDone.has(sql)) return;
  for (const s of q.schema) await sql.query(s, []);
  schemaDone.add(sql);
}
const one = (rows) => (Array.isArray(rows) ? rows[0] : rows?.rows?.[0]) || null;
const rowsOf = (rows) => (Array.isArray(rows) ? rows : rows?.rows || []);

// ---------- 1) ingestão dos postbacks (chamada por content-service.mjs, já autenticado) ----------
export const KIT_EVENTS = Object.freeze({
  PURCHASE_APPROVED: "approved", PURCHASE_COMPLETE: "approved",
  PURCHASE_REFUNDED: "refunded", PURCHASE_CHARGEBACK: "chargeback", PURCHASE_CANCELED: "canceled",
  PURCHASE_PROTEST: "protest",
});
// approved_date do postback (ms). Ausente, inválido, no futuro ou anterior a 2020 => horário de chegada (nunca antecipa).
export function approvedAtMs(data = {}, receivedMs = Date.now()) {
  const v = Number(data?.purchase?.approved_date);
  if (Number.isFinite(v) && v >= Date.UTC(2020, 0, 1) && v <= receivedMs + 5 * 60_000) return Math.trunc(v);
  return receivedMs;
}
export async function ingestKitPostback(env, { event, data }, { sqlFactory, now = Date.now(), q = KITS_SQL } = {}) {
  const sku = kitSkuFor(data, env);
  if (!sku) return { kit: false };
  const state = KIT_EVENTS[String(event || "").toUpperCase()];
  if (!state) return { kit: true, sku, ignored: true };
  const secret = privacySecret(env);
  if (!secret) throw new Error("kits_privacy_secret_missing");
  if (!env.DATABASE_URL || typeof sqlFactory !== "function") throw new Error("kits_database_unavailable");
  const txn = normTxn(data?.purchase?.transaction);
  if (!/^[A-Z0-9-]{6,64}$/.test(txn)) throw new Error("kits_transaction_invalid");
  const sql = sqlFactory(env.DATABASE_URL);
  await ensureSchema(sql, q);
  const tref = await ref(secret, "transaction", txn);
  const eventKey = await ref(secret, "event", String(event).toUpperCase() + "|" + txn);
  const email = normEmail(data?.buyer?.email);
  const emailRef = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? await ref(secret, "email", email) : null;
  const approved = state === "approved" ? new Date(approvedAtMs(data, now)).toISOString() : null;
  const out = one(await sql.query(q.ingest, [eventKey, tref, String(event).toUpperCase(), sku, state, approved, emailRef]));
  if (["refunded", "chargeback", "canceled"].includes(state)) await sql.query(q.revokeLinks, [tref]);
  return { kit: true, sku, duplicate: !out, status: out?.status || null };
}

// ---------- 2) contingência ----------
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (status, title, inner) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ZEVANORY</title></head><body><main><h1>${esc(title)}</h1>${inner}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });
const OPERATOR_RE = /^[A-Za-z0-9 ._@:-]{3,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4096) return { error: json(413, { error: "payload_too_large" }) };
  try { return { body: JSON.parse(text || "{}") }; } catch { return { error: json(400, { error: "invalid_json" }) }; }
}
function operatorAndReason(body) {
  const operator = String(body?.operator || "").trim(), reason = String(body?.reason || "").replace(/\s+/g, " ").trim();
  if (!OPERATOR_RE.test(operator)) return { error: json(400, { error: "operator_required" }) };
  if (reason.length < 10 || reason.length > 500) return { error: json(400, { error: "reason_required" }) };
  return { operator, reason };
}
async function audit(sql, q, kind, tref, actor, reason, outcome) {
  try { await sql.query(q.audit, [kind, tref || null, actor || null, reason ? String(reason).slice(0, 500) : null, String(outcome).slice(0, 80)]); } catch {}
}
async function contingencyOpen(sql, q) {
  const s = one(await sql.query(q.state, []));
  return s?.open === "true" || s?.open === true || s?.open === "t";
}
async function sendMail(env, fetchImpl, to, subject, text) {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + String(env.RESEND_API_KEY), "content-type": "application/json" },
    body: JSON.stringify({ from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"), to: [to], reply_to: "suporte@zevanory.api.br", subject, text, html: brandedEmailHtml(text) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return Boolean(r?.ok);
}
export function contingencyEmail({ sku, link, expiresMs, approvedMs, nowMs }) {
  const produto = kitName(sku);
  const dia8 = day8Released(approvedMs, nowMs) ? ENTREGA_CLUB.dia8_liberado : ENTREGA_CLUB.dia8_pendente.replaceAll("{data}", brt(day8ReleaseAt(approvedMs)));
  const subject = ENTREGA_CLUB.email_contingencia_assunto.replaceAll("{produto}", produto);
  const text = ENTREGA_CLUB.email_contingencia.replaceAll("{produto}", produto).replaceAll("{link}", link).replaceAll("{expira}", brt(expiresMs)).replaceAll("{dia8}", dia8);
  return { subject, text };
}

async function adminRoute(path, request, env, ctx) {
  const { sql, q, fetchImpl, nowFn } = ctx;
  const parsed = await readBody(request);
  if (parsed.error) return parsed.error;
  const who = operatorAndReason(parsed.body);
  if (who.error) return who.error;
  const { operator, reason } = who;
  if (path === "/api/admin/kits/contingencia/estado") {
    const enabled = parsed.body.enabled === true;
    const hours = enabled ? Math.trunc(Number(parsed.body.hours)) : 0;
    if (enabled && !(hours >= 1 && hours <= Number(CONTINGENCY.horas_max_ligada))) return json(400, { error: "hours_out_of_range", max: CONTINGENCY.horas_max_ligada });
    const r = one(await sql.query(q.setState, [enabled, enabled ? hours : 0, operator, reason]));
    await audit(sql, q, enabled ? "contingency_on" : "contingency_off", null, operator, reason, "ok");
    return json(200, { ok: true, enabled, until: enabled && r?.until_ms ? new Date(Number(r.until_ms)).toISOString() : null });
  }
  const secret = privacySecret(env);
  if (!secret) return json(503, { error: "kits_privacy_secret_missing" });
  const txn = normTxn(parsed.body.transaction);
  if (!/^[A-Z0-9-]{6,64}$/.test(txn)) return json(400, { error: "transaction_required" });
  const tref = await ref(secret, "transaction", txn);
  if (path === "/api/admin/kits/contingencia/revogar") {
    const n = rowsOf(await sql.query(q.revokeLinks, [tref])).length;
    await audit(sql, q, "contingency_revoke", tref, operator, reason, "revoked:" + n);
    return json(200, { ok: true, revoked: n });
  }
  // path === link
  const email = normEmail(parsed.body.email);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) return json(400, { error: "email_required" });
  let open;
  try { open = await contingencyOpen(sql, q); } catch { open = null; }
  if (open === null) return json(503, { issued: false, error: "purchase_state_unavailable", action: "Nenhum link emitido. Confira a compra no painel da Hotmart e tente de novo; não envie arquivos por outro canal." });
  if (!open) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:contingency_closed"); return json(409, { issued: false, error: "contingency_closed" }); }
  let p;
  try { p = one(await sql.query(q.purchase, [tref])); } catch {
    // Leitura do estado falhou: fail-closed, nada é emitido; o operador confere no painel Hotmart e repete.
    return json(503, { issued: false, error: "purchase_state_unavailable", action: "Nenhum link emitido. Confira a compra no painel da Hotmart e tente de novo; não envie arquivos por outro canal." });
  }
  if (!p) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:purchase_not_found"); return json(404, { issued: false, error: "purchase_not_found", action: "Compra sem registro sincronizado (postback não recebido). Nenhum link emitido; confira no painel da Hotmart e peça o reenvio do postback." }); }
  if (p.status !== "approved") { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:status_" + p.status); return json(p.status === "unknown" ? 409 : 410, { issued: false, error: "purchase_not_active", status: p.status }); }
  const approvedMs = Number(p.approved_ms);
  if (!Number.isFinite(approvedMs) || approvedMs <= 0) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:no_approval_time"); return json(409, { issued: false, error: "purchase_not_active" }); }
  const emailRef = await ref(secret, "email", email);
  if (!p.buyer_email_ref || p.buyer_email_ref !== emailRef) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:recipient_not_buyer"); return json(403, { issued: false, error: "recipient_not_buyer" }); }
  const nowMs = nowFn();
  const files = authorizedFiles(p.sku, approvedMs, nowMs, ctx.catalog);
  if (!files.length) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:no_files"); return json(409, { issued: false, error: "no_authorized_files" }); }
  const ttl = Math.min(Number(CONTINGENCY.ttl_minutos_max), Math.max(5, Math.trunc(Number(parsed.body.ttl_minutes) || Number(CONTINGENCY.ttl_minutos_padrao))));
  const token = randomToken();
  const tokenSha = await sha256Hex(enc.encode(token));
  const issued = one(await sql.query(q.issue, [tokenSha, tref, p.sku, ttl, Number(CONTINGENCY.usos_max_por_link), operator]));
  if (!issued) { await audit(sql, q, "contingency_link", tref, operator, reason, "denied:contingency_closed"); return json(409, { issued: false, error: "contingency_closed" }); }
  const expiresMs = Number(issued.expires_ms);
  const link = "https://zevanory.api.br/entrega/contingencia?t=" + token;
  const mail = contingencyEmail({ sku: p.sku, link, expiresMs, approvedMs, nowMs });
  const sent = await sendMail(env, fetchImpl, email, mail.subject, mail.text);
  if (!sent) {
    await sql.query(q.revokeLink, [tokenSha]);
    await audit(sql, q, "contingency_link", tref, operator, reason, "failed:email");
    return json(502, { issued: false, error: "email_failed" });
  }
  const released = day8Released(approvedMs, nowMs);
  await audit(sql, q, "contingency_link", tref, operator, reason, (released ? "issued:dia1+dia8" : "issued:dia1") + (p.protest === "true" ? ":refund_requested" : ""));
  // O token só vai ao e-mail do comprador: nunca na resposta ao operador nem em log.
  return json(201, { issued: true, sku: p.sku, expires_at: new Date(expiresMs).toISOString(), files: files.length, day8_released: released,
    day8_release_at: new Date(day8ReleaseAt(approvedMs)).toISOString(), refund_requested: p.protest === "true" });
}

async function customerRoute(path, request, env, ctx) {
  const { sql, q, nowFn } = ctx;
  const url = new URL(request.url);
  if (path === "/entrega/contingencia") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
    const token = String(url.searchParams.get("t") || "");
    if (!TOKEN_RE.test(token)) return page(404, "Link inválido", "<p>Este link não é válido. Fale com suporte@zevanory.api.br.</p>");
    let row = null;
    try { row = one(await sql.query(q.view, [await sha256Hex(enc.encode(token))])); } catch { return page(503, "Indisponível", "<p>Tente novamente em instantes.</p>"); }
    if (!row) return page(410, "Link indisponível", "<p>Este link expirou, foi revogado ou a compra não está ativa. Fale com suporte@zevanory.api.br.</p>");
    const approvedMs = Number(row.approved_ms), nowMs = nowFn();
    const files = authorizedFiles(row.sku, approvedMs, nowMs, ctx.catalog);
    const items = files.map((f) => `<li><form method="post" action="/entrega/contingencia/arquivo"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="f" value="${esc(f.id)}"><button type="submit">${esc(f.caminho)}</button></form></li>`).join("");
    const dia8 = day8Released(approvedMs, nowMs) ? ENTREGA_CLUB.dia8_liberado : ENTREGA_CLUB.dia8_pendente.replaceAll("{data}", brt(day8ReleaseAt(approvedMs)));
    return page(200, kitName(row.sku) + ": seus arquivos", `<p>Link individual e temporário (válido até ${esc(brt(Number(row.expires_ms)))}, horário de Brasília).</p><p>${esc(dia8)}</p><ul>${items}</ul><p>${esc(ENTREGA_CLUB.aviso_licenca)}</p>`);
  }
  // /entrega/contingencia/arquivo
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  let token = "", fid = "";
  try { const form = await request.formData(); token = String(form.get("t") || ""); fid = String(form.get("f") || ""); } catch {}
  if (!TOKEN_RE.test(token) || !/^[0-9a-f]{16}$/.test(fid)) return json(404, { error: "download_unavailable" });
  let row = null;
  try { row = one(await sql.query(q.use, [await sha256Hex(enc.encode(token))])); } catch { return json(503, { error: "download_validation_unavailable" }); }
  if (!row) { await audit(sql, q, "contingency_download", null, null, null, "denied:link_or_purchase"); return json(410, { error: "download_unavailable" }); }
  const file = authorizedFiles(row.sku, Number(row.approved_ms), nowFn(), ctx.catalog).find((f) => f.id === fid);
  if (!file) { await audit(sql, q, "contingency_download", row.transaction_ref, null, null, "denied:file_not_authorized"); return json(403, { error: "file_not_authorized" }); }
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  const bytes = kv?.get ? await kv.get(file.kv_key, "arrayBuffer") : null;
  if (!bytes) { await audit(sql, q, "contingency_download", row.transaction_ref, null, null, "failed:missing"); return json(503, { error: "artifact_missing" }); }
  const digest = (await sha256Hex(bytes)).toUpperCase();
  if (digest !== file.sha256) { await audit(sql, q, "contingency_download", row.transaction_ref, null, null, "failed:integrity"); return json(503, { error: "artifact_integrity_failed" }); }
  await audit(sql, q, "contingency_download", row.transaction_ref, null, null, "ok:" + file.liberacao);
  return new Response(bytes, { status: 200, headers: {
    "content-type": file.content_type, "content-disposition": `attachment; filename="${file.arquivo.replace(/"/g, "")}"`,
    "content-length": String(bytes.byteLength), "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  } });
}

export const KITS_ADMIN_PATHS = Object.freeze(["/api/admin/kits/contingencia/estado", "/api/admin/kits/contingencia/link", "/api/admin/kits/contingencia/revogar"]);
export const KITS_CUSTOMER_PATHS = Object.freeze(["/entrega/contingencia", "/entrega/contingencia/arquivo"]);
// Devolve null para caminhos que não são deste módulo.
export async function handleKitsRequest(request, env = {}, { sqlFactory, isOperator, fetchImpl = globalThis.fetch, now = () => Date.now(), q = KITS_SQL, catalog = KITS.catalogo_contingencia } = {}) {
  const path = new URL(request.url).pathname;
  const admin = KITS_ADMIN_PATHS.includes(path), customer = KITS_CUSTOMER_PATHS.includes(path);
  if (!admin && !customer) return null;
  if (admin) {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (typeof isOperator !== "function" || !(await isOperator(request))) return json(401, { error: "operator_auth_required" });
  }
  if (!env.DATABASE_URL || typeof sqlFactory !== "function") return admin ? json(503, { error: "purchase_state_unavailable" }) : page(503, "Indisponível", "<p>Tente novamente em instantes.</p>");
  const sql = sqlFactory(env.DATABASE_URL);
  try { await ensureSchema(sql, q); } catch { return admin ? json(503, { issued: false, error: "purchase_state_unavailable", action: "Nenhum link emitido. Confira a compra no painel da Hotmart e tente de novo; não envie arquivos por outro canal." }) : page(503, "Indisponível", "<p>Tente novamente em instantes.</p>"); }
  const ctx = { sql, q, fetchImpl, catalog, nowFn: typeof now === "function" ? now : () => Number(now) };
  try {
    return admin ? await adminRoute(path, request, env, ctx) : await customerRoute(path, request, env, ctx);
  } catch (error) {
    console.error("kits_route_error", path, String(error?.message || error).slice(0, 80).replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]"));
    return json(503, { error: "kits_unavailable" });
  }
}
