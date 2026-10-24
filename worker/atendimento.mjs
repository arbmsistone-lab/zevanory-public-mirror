// Atendimento ao consumidor por formulário web (Decreto 7.962/2013, art. 4º, V: serviço adequado e eficaz
// de atendimento em meio eletrônico, com confirmação imediata do recebimento e resposta em até 5 dias).
// Canal oficial: suporte@zevanory.api.br (a conta de mensagens da Meta foi banida em 2026-10-10;
// data/politica-unica.json, contato_publico). Este formulário complementa o mailto, sem substituí-lo.
//
// Tipos: suporte, reclamação, cancelamento e reembolso/arrependimento. O arrependimento continua
// disponível pela mesma ferramenta usada na contratação (/pedir-reembolso, worker/refund-flow.mjs).
//
// Outbox durável em PostgreSQL (mesmo estilo de zevanory_support_inbound, PR #894, sem depender dele):
//   uma linha por protocolo em zevanory_atendimento_outbox, com TRÊS efeitos externos independentes, cada um
//   com estado, tentativas, primeira tentativa e Idempotency-Key própria no Resend:
//     owner_status    pending -> sent | dead         aviso ao destino (support-config:forward-to)  atendimento-owner/<p>
//     customer_status pending -> sent | dead         confirmação ao cliente, com o protocolo       atendimento-ack/<p>
//     alert_status    none -> pending -> sent | dead  dead-letter ao OWNER_ALERT_EMAIL               atendimento-dead/<p>
//   A linha é gravada ANTES de qualquer envio (registro durável = protocolo). Envios sob lease (2 min; o
//   dead-letter tem lease próprio), recuo exponencial e teto de MAX_ATTEMPTS.
// * Janela de envio < 23 h (SEND_WINDOW_HOURS): a Idempotency-Key do Resend vale 24 h; cada efeito só chama o
//   Resend até 23 h depois da SUA primeira tentativa. Passou disso => "dead" sem nenhuma chamada (aviso e
//   confirmação armam o dead-letter; dead-letter expirado/esgotado => cron vermelho até intervenção manual:
//   `update zevanory_atendimento_outbox set alert_ack_at = now() where protocolo = '<p>'` depois de tratar).
// * Erros do Resend: só rede/tempo esgotado, 429 e 5xx são temporários (nova tentativa com recuo); qualquer
//   outra resposta não-2xx (400, 401, 403, 404, 409, 422…) é permanente => dead na hora + dead-letter na hora.
// * Retomada: (1) o reenvio do mesmo formulário (mesmo protocolo) processa os envios pendentes; (2) o cron
//   horário (runRefundWatchdog -> drainAtendimentoOutbox).
// * Monitor de pendências antigas: pendência mais antiga com >= 2 h (OLD_PENDING_ALERT_HOURS) gera alerta SÓ
//   com contagem (sem protocolo, e-mail ou conteúdo; no máximo um a cada 6 h). Prazo operacional: 6 h
//   (OLD_PENDING_DEADLINE_HOURS) — pendência mais antiga que isso deixa o cron vermelho. O prazo legal de
//   resposta conclusiva (5 dias) não muda; o operacional garante que a confirmação "imediata" não fique parada.
// * Protocolo idempotente: HMAC-SHA256(LEAD_PRIVACY_SECRET) do envio (tipo + e-mail + pedido + mensagem +
//   dia de Brasília) => o mesmo envio no mesmo dia devolve o MESMO protocolo e não duplica e-mails.
// * Cotas ATÔMICAS num único comando SQL (INSERT…ON CONFLICT DO UPDATE … WHERE n < teto) que também grava a
//   linha: 5/h por IP e 4/dia por e-mail (ambos pseudonimizados por HMAC).
// * Fail-closed (503, nada gravado): sem LEAD_PRIVACY_SECRET (>= 32), sem DATABASE_URL, sem RESEND_API_KEY
//   ou sem destino do proprietário válido (SUPPORT_FORWARD_TO ou KV support-config:forward-to, fora de
//   @zevanory.api.br).
// * LGPD / dados mínimos: e-mail, pedido e mensagem ficam em payload só enquanto há envio pendente; com os
//   dois envios feitos o payload é apagado; linha com dead-letter guarda o payload até 30 dias após o alerta.
//   Nenhum log com dado pessoal (o módulo não escreve log). Isca anti-robô; sem captcha de terceiros.
// * Sem JavaScript: POST HTML e confirmação na tela na mesma resposta.
import { LEGAL_IDENTITY, SLA_TEXT, SUPPORT_EMAIL } from "./politica-unica.mjs";

export const ATENDIMENTO_PATH = "/atendimento";
export const ATENDIMENTO_API = "/api/atendimento";
export const FORWARD_TO_KV_KEY = "support-config:forward-to";
export const RESPONSE_DAYS = 5;
export const MAX_ATTEMPTS = 8;
export const SEND_WINDOW_HOURS = 23;
export const OLD_PENDING_ALERT_HOURS = 2;
export const OLD_PENDING_DEADLINE_HOURS = 6;
const MONITOR_EVERY_HOURS = 6;
export const IP_HOURLY_CAP = 5;
export const EMAIL_DAILY_CAP = 4;
export const TIPOS = Object.freeze({
  suporte: "Suporte (dúvida, acesso, entrega ou arquivo)",
  reclamacao: "Reclamação",
  cancelamento: "Cancelamento (assinatura ou pedido)",
  reembolso: "Reembolso ou direito de arrependimento",
});
const MAX_MESSAGE = 4000;
const RESEND = "https://api.resend.com/emails";
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUPPORT_DOMAIN = "zevanory.api.br";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (v, max) => String(v ?? "").normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const brDay = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
const brDate = (ms) => brDay(ms).split("-").reverse().join("/");
const toMs = (v) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const asObj = (v) => (v && typeof v === "object" ? v : (() => { try { return JSON.parse(String(v || "null")); } catch { return null; } })());

// ---------- segredo, pseudônimos e configuração ----------
export function privacySecret(env) {
  const v = String(env?.LEAD_PRIVACY_SECRET || "");
  return v.length >= 32 ? v : "";
}
async function hmacHex(secret, domain, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("zevanory-atendimento-v1:" + domain + ":" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Protocolo: ZEV-AAAAMMDD-XXXXXXXXXX (dia de Brasília + 10 hex do HMAC do envio).
export async function protocolFor(secret, input, nowMs) {
  const day = brDay(nowMs);
  const mac = await hmacHex(secret, "protocolo", [input.tipo, input.email, input.pedido, input.mensagem.replace(/\s+/g, " "), day].join("␟"));
  return `ZEV-${day.replaceAll("-", "")}-${mac.slice(0, 10).toUpperCase()}`;
}
export async function ownerTarget(env) {
  let v = String(env?.SUPPORT_FORWARD_TO || "").trim().toLowerCase();
  if (!v && env?.ZEVANORY_PRIVATE_ARTIFACTS?.get) {
    try { v = String((await env.ZEVANORY_PRIVATE_ARTIFACTS.get(FORWARD_TO_KV_KEY)) || "").trim().toLowerCase(); } catch {}
  }
  if (!EMAIL_RE.test(v) || v.endsWith("@" + SUPPORT_DOMAIN)) return "";
  return v;
}
// Contexto de execução; `missing` lista o que falta (fail-closed).
export async function atendimentoContext(env = {}, { sqlFactory, fetchImpl = globalThis.fetch, q = ATENDIMENTO_SQL, transient = resendFailureIsTransient } = {}) {
  const missing = [];
  const secret = privacySecret(env);
  if (!secret) missing.push("LEAD_PRIVACY_SECRET");
  if (!env.DATABASE_URL || typeof sqlFactory !== "function") missing.push("DATABASE_URL");
  if (!String(env.RESEND_API_KEY || "")) missing.push("RESEND_API_KEY");
  const owner = await ownerTarget(env);
  if (!owner) missing.push(FORWARD_TO_KV_KEY);
  if (missing.length) return { missing };
  return { env, secret, owner, sql: sqlFactory(env.DATABASE_URL), fetchImpl, q, transient, alertTo: String(env.OWNER_ALERT_EMAIL || owner) };
}

// ---------- outbox (PostgreSQL) ----------
const PENDING = "(owner_status = 'pending' or customer_status = 'pending')";
const WINDOW = `interval '${SEND_WINDOW_HOURS} hours'`;
export const ATENDIMENTO_SQL = Object.freeze({
  schema: [
    `/*atendimento:schema*/ create table if not exists zevanory_atendimento_outbox (
      protocolo text primary key,
      tipo text not null check (tipo in ('suporte','reclamacao','cancelamento','reembolso')),
      email_ref text not null,
      owner_status text not null default 'pending' check (owner_status in ('pending','sent','dead')),
      customer_status text not null default 'pending' check (customer_status in ('pending','sent','dead')),
      owner_attempts integer not null default 0, customer_attempts integer not null default 0,
      owner_first_attempt_at timestamptz, customer_first_attempt_at timestamptz,
      owner_message_id text, customer_message_id text, last_error text,
      next_attempt_at timestamptz not null default now(), lease_until timestamptz,
      alert_status text not null default 'none' check (alert_status in ('none','pending','sent','dead')),
      alert_attempts integer not null default 0, alert_first_attempt_at timestamptz, alert_next_at timestamptz,
      alert_lease_until timestamptz, alert_error text, alert_ack_at timestamptz, dead_alerted_at timestamptz,
      payload jsonb,
      recebido_em timestamptz not null default now(), responder_ate timestamptz not null,
      updated_at timestamptz not null default now())`,
    `/*atendimento:schema*/ create table if not exists zevanory_atendimento_quota (
      bucket text primary key, n integer not null default 0, expires_at timestamptz not null)`,
    `/*atendimento:schema*/ create table if not exists zevanory_atendimento_monitor (
      key text primary key, last_alert_at timestamptz not null)`,
    "/*atendimento:schema*/ create index if not exists zevanory_atendimento_outbox_due_idx on zevanory_atendimento_outbox (next_attempt_at) where owner_status = 'pending' or customer_status = 'pending'",
    "/*atendimento:schema*/ create index if not exists zevanory_atendimento_outbox_alert_idx on zevanory_atendimento_outbox (alert_next_at) where alert_status = 'pending'",
  ],
  find: `/*atendimento:find*/ select protocolo, tipo, owner_status, customer_status, recebido_em, responder_ate from zevanory_atendimento_outbox where protocolo = $1`,
  // Cota por IP (q1) e por e-mail (q2) e gravação da linha (ins) num ÚNICO comando: concorrência resolvida
  // pelo próprio PostgreSQL (trava de linha do ON CONFLICT), nunca por leitura-e-escrita separadas.
  admit: `/*atendimento:admit*/ with q1 as (
      insert into zevanory_atendimento_quota (bucket, n, expires_at) values ($2, 1, now() + interval '2 hours')
      on conflict (bucket) do update set n = zevanory_atendimento_quota.n + 1 where zevanory_atendimento_quota.n < $3
      returning 1 as ok
    ), q2 as (
      insert into zevanory_atendimento_quota (bucket, n, expires_at) select $4, 1, now() + interval '2 days' from q1
      on conflict (bucket) do update set n = zevanory_atendimento_quota.n + 1 where zevanory_atendimento_quota.n < $5
      returning 1 as ok
    ), ins as (
      insert into zevanory_atendimento_outbox (protocolo, tipo, email_ref, payload, responder_ate)
      select $1, $6, $7, $8::jsonb, now() + make_interval(days => $9::int) from q2
      on conflict (protocolo) do nothing
      returning protocolo, recebido_em, responder_ate
    ) select (select count(*) from q1)::int as ip_ok, (select count(*) from q2)::int as email_ok,
        ins.protocolo, ins.recebido_em, ins.responder_ate
      from (select 1) one left join ins on true`,
  // Lease + marca da PRIMEIRA tentativa de cada envio pendente; *_window_ok = ainda dentro de < 23 h dela.
  lease: `/*atendimento:lease*/ update zevanory_atendimento_outbox set lease_until = now() + interval '2 minutes', updated_at = now(),
      owner_first_attempt_at = case when owner_status = 'pending' then coalesce(owner_first_attempt_at, now()) else owner_first_attempt_at end,
      customer_first_attempt_at = case when customer_status = 'pending' then coalesce(customer_first_attempt_at, now()) else customer_first_attempt_at end
    where protocolo = $1 and ${PENDING} and next_attempt_at <= now() and (lease_until is null or lease_until < now())
    returning protocolo, tipo, owner_status, customer_status, owner_attempts, customer_attempts, payload, recebido_em, responder_ate,
      (owner_first_attempt_at > now() - ${WINDOW}) as owner_window_ok, (customer_first_attempt_at > now() - ${WINDOW}) as customer_window_ok`,
  ownerSent: `/*atendimento:owner_sent*/ update zevanory_atendimento_outbox set owner_status = 'sent', owner_message_id = $2, updated_at = now()
    where protocolo = $1 and owner_status = 'pending'`,
  customerSent: `/*atendimento:customer_sent*/ update zevanory_atendimento_outbox set customer_status = 'sent', customer_message_id = $2, updated_at = now()
    where protocolo = $1 and customer_status = 'pending'`,
  // $2 teto, $3 motivo, $4 permanente (erro permanente ou janela expirada => dead já).
  ownerFailed: `/*atendimento:owner_failed*/ update zevanory_atendimento_outbox set owner_attempts = owner_attempts + 1,
      owner_status = case when $4::boolean or owner_attempts + 1 >= $2 then 'dead' else 'pending' end, last_error = $3, updated_at = now()
    where protocolo = $1 and owner_status = 'pending' returning owner_status, owner_attempts`,
  customerFailed: `/*atendimento:customer_failed*/ update zevanory_atendimento_outbox set customer_attempts = customer_attempts + 1,
      customer_status = case when $4::boolean or customer_attempts + 1 >= $2 then 'dead' else 'pending' end, last_error = $3, updated_at = now()
    where protocolo = $1 and customer_status = 'pending' returning customer_status, customer_attempts`,
  // Solta o lease e agenda; com os dois envios feitos apaga o conteúdo; com algum dead arma na hora o
  // dead-letter (alert_status none -> pending), que tem estado, lease e janela próprios.
  release: `/*atendimento:release*/ update zevanory_atendimento_outbox set lease_until = null, updated_at = now(),
      next_attempt_at = now() + make_interval(mins => $2::int),
      payload = case when owner_status = 'sent' and customer_status = 'sent' then null else payload end,
      alert_status = case when alert_status = 'none' and (owner_status = 'dead' or customer_status = 'dead') then 'pending' else alert_status end,
      alert_next_at = case when alert_status = 'none' and (owner_status = 'dead' or customer_status = 'dead') then now() else alert_next_at end
    where protocolo = $1
    returning owner_status, customer_status, alert_status`,
  due: `/*atendimento:due*/ select protocolo from zevanory_atendimento_outbox where ${PENDING} and next_attempt_at <= now()
      and (lease_until is null or lease_until < now()) order by next_attempt_at limit $1`,
  alertDue: `/*atendimento:alert_due*/ select protocolo from zevanory_atendimento_outbox where alert_status = 'pending' and alert_next_at <= now()
      and (alert_lease_until is null or alert_lease_until < now()) order by alert_next_at limit $1`,
  alertLease: `/*atendimento:alert_lease*/ update zevanory_atendimento_outbox set alert_lease_until = now() + interval '2 minutes',
      alert_first_attempt_at = coalesce(alert_first_attempt_at, now()), updated_at = now()
    where protocolo = $1 and alert_status = 'pending' and alert_next_at <= now() and (alert_lease_until is null or alert_lease_until < now())
    returning protocolo, tipo, owner_status, customer_status, recebido_em, payload, alert_attempts,
      (coalesce(alert_first_attempt_at, now()) > now() - ${WINDOW}) as alert_window_ok`,
  alertSent: `/*atendimento:alert_sent*/ update zevanory_atendimento_outbox set alert_status = 'sent', dead_alerted_at = now(), alert_lease_until = null, updated_at = now()
    where protocolo = $1 and alert_status = 'pending'`,
  alertFailed: `/*atendimento:alert_failed*/ update zevanory_atendimento_outbox set alert_attempts = alert_attempts + 1, alert_error = $3, alert_lease_until = null,
      alert_status = case when $4::boolean or alert_attempts + 1 >= $2 then 'dead' else 'pending' end,
      alert_next_at = now() + make_interval(mins => $5::int), updated_at = now()
    where protocolo = $1 and alert_status = 'pending' returning alert_status, alert_attempts`,
  // Vermelho: dead-letter esgotado sem reconhecimento manual, ou pendência além do prazo operacional.
  health: `/*atendimento:health*/ select
      (select count(*) from zevanory_atendimento_outbox where alert_status = 'dead' and alert_ack_at is null)::int as alert_dead,
      (select count(*) from zevanory_atendimento_outbox where ${PENDING})::int as pending,
      (select count(*) from zevanory_atendimento_outbox where ${PENDING} and recebido_em <= now() - make_interval(hours => $1::int))::int as old_alert,
      (select count(*) from zevanory_atendimento_outbox where ${PENDING} and recebido_em <= now() - make_interval(hours => $2::int))::int as old_deadline,
      coalesce(extract(epoch from now() - (select min(recebido_em) from zevanory_atendimento_outbox where ${PENDING})) / 3600, 0)::float as oldest_hours`,
  // Monitor: no máximo um alerta de contagem a cada 6 h (reserva atômica).
  monitorClaim: `/*atendimento:monitor_claim*/ insert into zevanory_atendimento_monitor (key, last_alert_at) values ('old_pending', now())
    on conflict (key) do update set last_alert_at = now() where zevanory_atendimento_monitor.last_alert_at < now() - make_interval(hours => $1::int)
    returning to_char(last_alert_at at time zone 'UTC', 'YYYYMMDDHH24') as bucket`,
  stuck: `/*atendimento:stuck*/ select count(*)::int as n from zevanory_atendimento_outbox where ${PENDING} or alert_status = 'pending' or (alert_status = 'dead' and alert_ack_at is null)`,
  housekeeping: `/*atendimento:housekeeping*/ with a as (delete from zevanory_atendimento_quota where expires_at < now() returning 1),
      b as (update zevanory_atendimento_outbox set payload = null where payload is not null and dead_alerted_at < now() - interval '30 days' returning 1)
    select (select count(*) from a)::int as quotas, (select count(*) from b)::int as purged`,
});
const schemaReady = new WeakSet();
export async function ensureAtendimentoSchema(sql, q = ATENDIMENTO_SQL) {
  if (schemaReady.has(sql)) return;
  for (const s of q.schema) await sql.query(s, []);
  schemaReady.add(sql);
}
const backoffMinutes = (attempts) => Math.min(360, 2 ** Math.max(1, Math.min(9, attempts)));
const truthy = (v) => v === true || v === "t" || v === "true" || v === 1;

// Só rede/tempo esgotado, 429 e 5xx são temporários; qualquer outra resposta não-2xx é permanente.
export function resendFailureIsTransient(status) {
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}
async function resendSend(c, { idempotencyKey, to, subject, text, replyTo }) {
  try {
    const r = await c.fetchImpl(RESEND, {
      method: "POST",
      headers: { authorization: `Bearer ${c.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ from: `ZEVANORY <${SUPPORT_EMAIL}>`, to: [to], reply_to: replyTo || SUPPORT_EMAIL, subject, text }),
      signal: AbortSignal.timeout(10000),
    });
    let data = null;
    try { data = await r.json(); } catch {}
    if (r.ok) return { ok: true, id: String(data?.id || "") };
    return { ok: false, permanent: !c.transient(r.status), reason: `resend_${r.status}` };
  } catch { return { ok: false, permanent: false, reason: "resend_network" }; }
}

function ownerMessage(row, p) {
  return {
    subject: `ZEVANORY atendimento ${row.protocolo} — ${TIPOS[row.tipo]}`,
    text: `Protocolo: ${row.protocolo}\nTipo: ${TIPOS[row.tipo]}\nRecebido em: ${new Date(toMs(row.recebido_em)).toISOString()}\nResponder até: ${brDate(toMs(row.responder_ate))} (resposta conclusiva em até ${RESPONSE_DAYS} dias)\nPedido: ${p.pedido || "não informado"}\nResponder para: ${p.email} (responda este e-mail)\n\n${p.mensagem}\n`,
  };
}
function customerMessage(row) {
  const reembolso = row.tipo === "reembolso"
    ? `\nSe o pedido foi pago, você também pode registrar o reembolso automaticamente, pela mesma ferramenta usada na compra: https://zevanory.api.br/pedir-reembolso (código do pedido + e-mail do pagamento).`
    : "";
  return {
    subject: `ZEVANORY — recebemos sua solicitação (protocolo ${row.protocolo})`,
    text: `Recebemos sua solicitação.\n\nProtocolo: ${row.protocolo}\nTipo: ${TIPOS[row.tipo]}\nRecebida em: ${brDate(toMs(row.recebido_em))}\nResposta conclusiva até: ${brDate(toMs(row.responder_ate))}, por este e-mail.${reembolso}\n\nPara acrescentar informações, responda este e-mail informando o protocolo.\n\n${LEGAL_IDENTITY} · ${SUPPORT_EMAIL}`,
  };
}

// Um envio: fora da janela de < 23 h => dead sem chamar o Resend; senão chama e classifica o erro.
async function sendStep(c, protocolo, { pending, windowOk, key, to, replyTo, message, sentQ, failedQ, statusCol, attemptsCol, hasPayload }) {
  if (!pending) return null;
  let r;
  if (!truthy(windowOk)) r = { ok: false, permanent: true, reason: "window_expired" };
  else if (!hasPayload) r = { ok: false, permanent: true, reason: "payload_missing" };
  else r = await resendSend(c, { idempotencyKey: key, to, replyTo, ...message });
  if (r.ok) { await c.sql.query(sentQ, [protocolo, r.id]); return { status: "sent", attempts: 0 }; }
  const f = (await c.sql.query(failedQ, [protocolo, MAX_ATTEMPTS, r.reason, Boolean(r.permanent)]))?.[0];
  return { status: f?.[statusCol] || "pending", attempts: Number(f?.[attemptsCol] || 0), reason: r.reason };
}

// Processa UMA linha sob lease: tenta cada envio pendente uma vez. Ocupada, em recuo ou concluída => nada.
export async function processAtendimento(c, protocolo) {
  const rows = await c.sql.query(c.q.lease, [protocolo]);
  const row = rows?.[0];
  if (!row) return { leased: false };
  const p = asObj(row.payload) || {};
  const out = { leased: true, owner: row.owner_status, customer: row.customer_status };
  const o = await sendStep(c, protocolo, { pending: row.owner_status === "pending", windowOk: row.owner_window_ok, key: `atendimento-owner/${protocolo}`, to: c.owner, replyTo: p.email, message: ownerMessage(row, p), sentQ: c.q.ownerSent, failedQ: c.q.ownerFailed, statusCol: "owner_status", attemptsCol: "owner_attempts", hasPayload: Boolean(p.email) });
  if (o) { out.owner = o.status; out.owner_attempts = o.attempts; if (o.reason) out.owner_reason = o.reason; }
  const k = await sendStep(c, protocolo, { pending: row.customer_status === "pending", windowOk: row.customer_window_ok, key: `atendimento-ack/${protocolo}`, to: p.email, message: customerMessage(row), sentQ: c.q.customerSent, failedQ: c.q.customerFailed, statusCol: "customer_status", attemptsCol: "customer_attempts", hasPayload: Boolean(p.email) });
  if (k) { out.customer = k.status; out.customer_attempts = k.attempts; if (k.reason) out.customer_reason = k.reason; }
  const attempts = Math.max(out.owner === "pending" ? out.owner_attempts || 0 : 0, out.customer === "pending" ? out.customer_attempts || 0 : 0);
  const rel = (await c.sql.query(c.q.release, [protocolo, backoffMinutes(attempts)]))?.[0];
  out.alert = rel?.alert_status;
  return out;
}

// Dead-letter de UMA linha: estado, lease, tentativas e janela de < 23 h próprios.
export async function processDeadLetter(c, protocolo) {
  const d = (await c.sql.query(c.q.alertLease, [protocolo]))?.[0];
  if (!d) return { leased: false };
  const p = asObj(d.payload) || {};
  let r;
  if (!truthy(d.alert_window_ok)) r = { ok: false, permanent: true, reason: "window_expired" };
  else {
    const lines = [`Protocolo: ${d.protocolo}`, `Tipo: ${TIPOS[d.tipo] || d.tipo}`, `Recebido em: ${new Date(toMs(d.recebido_em)).toISOString()}`,
      `Aviso ao proprietário: ${d.owner_status}`, `Confirmação ao cliente: ${d.customer_status}`];
    if (d.owner_status === "dead" && p.email) lines.push("", `Responder para: ${p.email}`, `Pedido: ${p.pedido || "não informado"}`, "", String(p.mensagem || ""));
    if (d.customer_status === "dead") lines.push("", "O cliente NÃO recebeu a confirmação por e-mail: confirme o recebimento ao responder.");
    r = await resendSend(c, { idempotencyKey: `atendimento-dead/${d.protocolo}`, to: c.alertTo, replyTo: p.email || SUPPORT_EMAIL, subject: `ZEVANORY atendimento ${d.protocolo} — envio esgotado (dead-letter)`, text: lines.join("\n") });
  }
  if (r.ok) { await c.sql.query(c.q.alertSent, [protocolo]); return { leased: true, alert: "sent" }; }
  const f = (await c.sql.query(c.q.alertFailed, [protocolo, MAX_ATTEMPTS, r.reason, Boolean(r.permanent), backoffMinutes(Number(d.alert_attempts || 0) + 1)]))?.[0];
  return { leased: true, alert: f?.alert_status || "pending", reason: r.reason };
}

export function parseInput(raw = {}) {
  const tipo = clean(raw.tipo, 20);
  return {
    tipo: Object.hasOwn(TIPOS, tipo) ? tipo : "",
    email: clean(raw.email, 254).toLowerCase(),
    pedido: clean(raw.pedido, 64).toLowerCase(),
    mensagem: clean(raw.mensagem, MAX_MESSAGE + 1),
    isca: clean(raw.website, 200),
  };
}

export function validate(input) {
  const errors = {};
  if (!input.tipo) errors.tipo = "Escolha o tipo de solicitação.";
  if (!EMAIL_RE.test(input.email) || input.email.endsWith("@" + SUPPORT_DOMAIN)) errors.email = "Informe um e-mail válido: a resposta chega por ele.";
  if (input.pedido && !UUID.test(input.pedido)) errors.pedido = "O código do pedido está no e-mail de entrega (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Deixe em branco se não tiver.";
  if (input.mensagem.length < 10) errors.mensagem = "Descreva a solicitação (pelo menos 10 caracteres).";
  if (input.mensagem.length > MAX_MESSAGE) errors.mensagem = `Use no máximo ${MAX_MESSAGE} caracteres.`;
  return errors;
}

const view = (r) => ({ protocolo: String(r.protocolo), tipo: String(r.tipo), recebido_em: new Date(toMs(r.recebido_em)).toISOString(), responder_ate: new Date(toMs(r.responder_ate)).toISOString(), canal_resposta: "email" });

// Registra (ou reencontra) a solicitação e tenta os envios na hora. Retorna {status, body}.
export async function registerRequest(env, input, { ip = "unknown", now = Date.now(), sqlFactory, fetchImpl, q, transient } = {}) {
  if (input.isca) return { status: 200, body: { received: true, ignored: true } };
  const errors = validate(input);
  if (Object.keys(errors).length) return { status: 400, body: { error: "dados_invalidos", errors } };
  const c = await atendimentoContext(env, { sqlFactory, fetchImpl, q, transient });
  if (c.missing) return { status: 503, body: { error: "atendimento_indisponivel", missing: c.missing } };
  await ensureAtendimentoSchema(c.sql, c.q);
  const protocolo = await protocolFor(c.secret, input, now);
  let row = (await c.sql.query(c.q.find, [protocolo]))?.[0];
  let duplicate = Boolean(row);
  if (!row) {
    const ipBucket = `ip:${(await hmacHex(c.secret, "ip", ip)).slice(0, 32)}:${new Date(now).toISOString().slice(0, 13)}`;
    const emailRef = (await hmacHex(c.secret, "email", input.email)).slice(0, 40);
    const emailBucket = `em:${emailRef}:${brDay(now)}`;
    const payload = JSON.stringify({ email: input.email, pedido: input.pedido, mensagem: input.mensagem });
    const a = (await c.sql.query(c.q.admit, [protocolo, ipBucket, IP_HOURLY_CAP, emailBucket, EMAIL_DAILY_CAP, input.tipo, emailRef, payload, RESPONSE_DAYS]))?.[0] || {};
    if (Number(a.ip_ok) !== 1 || Number(a.email_ok) !== 1) return { status: 429, body: { error: "muitas_tentativas" } };
    if (a.protocolo) row = { protocolo: a.protocolo, tipo: input.tipo, recebido_em: a.recebido_em, responder_ate: a.responder_ate, owner_status: "pending", customer_status: "pending" };
    else { row = (await c.sql.query(c.q.find, [protocolo]))?.[0]; duplicate = true; }
    if (!row) return { status: 503, body: { error: "atendimento_indisponivel" } };
  }
  // Registro durável feito: tenta os envios pendentes agora (inclusive de um envio anterior interrompido).
  let customer = String(row.customer_status);
  if (row.owner_status === "pending" || row.customer_status === "pending") {
    try {
      const res = await processAtendimento(c, protocolo);
      if (res.leased) customer = res.customer;
      // Erro permanente (ou janela expirada): dead-letter na hora, sem esperar o cron.
      if (res.alert === "pending") await processDeadLetter(c, protocolo);
    } catch {}
  }
  return { status: 200, body: { received: true, duplicate, ...view(row), email_confirmacao: customer === "sent" ? "enviado" : "pendente" } };
}

// Cron horário: retoma envios pendentes, processa dead-letters, monitora pendências antigas e faz a limpeza.
// ok=false (cron vermelho) com: dead-letter esgotado sem reconhecimento manual, pendência além do prazo
// operacional (OLD_PENDING_DEADLINE_HOURS) ou alerta de pendência antiga que não saiu.
export async function drainAtendimentoOutbox(env = {}, { sqlFactory, fetchImpl = globalThis.fetch, limit = 3, q, transient } = {}) {
  if (!env.DATABASE_URL || typeof sqlFactory !== "function") return { ok: true, skipped: "no_database" };
  const c = await atendimentoContext(env, { sqlFactory, fetchImpl, q, transient });
  if (c.missing) {
    // Sem configuração o formulário recusa (503) e nada novo entra; só fica vermelho se houver envio parado.
    let stuck = 0;
    try { stuck = Number((await sqlFactory(env.DATABASE_URL).query((q || ATENDIMENTO_SQL).stuck, []))?.[0]?.n || 0); } catch {}
    return { ok: stuck === 0, skipped: "unconfigured", missing: c.missing, stuck };
  }
  await ensureAtendimentoSchema(c.sql, c.q);
  const n = Math.max(1, Math.min(10, limit));
  const out = { ok: true, checked: 0, done: 0, pending: 0, dead: 0, dead_alerted: 0, alert_pending: 0, alert_dead: 0, old_pending: 0, oldest_hours: 0, monitor_alert: null };
  for (const r of (await c.sql.query(c.q.due, [n])) || []) {
    out.checked++;
    const res = await processAtendimento(c, String(r.protocolo));
    if (!res.leased) continue;
    if (res.owner === "dead" || res.customer === "dead") out.dead++;
    else if (res.owner === "pending" || res.customer === "pending") out.pending++;
    else out.done++;
  }
  for (const r of (await c.sql.query(c.q.alertDue, [n])) || []) {
    const res = await processDeadLetter(c, String(r.protocolo));
    if (res.alert === "sent") out.dead_alerted++;
    else if (res.alert === "pending") out.alert_pending++;
  }
  const h = (await c.sql.query(c.q.health, [OLD_PENDING_ALERT_HOURS, OLD_PENDING_DEADLINE_HOURS]))?.[0] || {};
  out.alert_dead = Number(h.alert_dead || 0);
  out.old_pending = Number(h.old_alert || 0);
  out.oldest_hours = Math.round(Number(h.oldest_hours || 0) * 10) / 10;
  if (out.old_pending > 0) {
    // Alerta só com contagem (sem protocolo, e-mail ou conteúdo), no máximo um a cada 6 h.
    const claim = (await c.sql.query(c.q.monitorClaim, [MONITOR_EVERY_HOURS]))?.[0];
    if (claim?.bucket) {
      const r = await resendSend(c, { idempotencyKey: `atendimento-monitor/${claim.bucket}`, to: c.alertTo, subject: "ZEVANORY atendimento — envios pendentes há mais de 2 h",
        text: `Há ${out.old_pending} solicitação(ões) de atendimento com envio pendente há ${OLD_PENDING_ALERT_HOURS} h ou mais (a mais antiga há ${out.oldest_hours} h). Prazo operacional: ${OLD_PENDING_DEADLINE_HOURS} h. Verifique RESEND_API_KEY, o destino support-config:forward-to e o painel do Resend.` });
      out.monitor_alert = r.ok ? "sent" : "failed";
    } else out.monitor_alert = "throttled";
  }
  try { await c.sql.query(c.q.housekeeping, []); } catch {}
  if (out.alert_dead > 0 || Number(h.old_deadline || 0) > 0 || out.monitor_alert === "failed") out.ok = false;
  return out;
}

const STYLE = "body{margin:0;font-family:system-ui,sans-serif;background:#05070b;color:#e7ecf7}main{max-width:560px;margin:0 auto;padding:32px 20px}.zv-brand{display:block;margin:0 0 22px}.zv-brand img{display:block;height:44px;width:auto}a{color:#7fd3ff}h1{font-size:26px}p,li{color:#b9c4dc;line-height:1.5}fieldset{border:1px solid #24324f;border-radius:10px;margin:18px 0 0;padding:10px 14px}legend{font-weight:600;padding:0 6px}.opt{display:flex;gap:10px;align-items:center;min-height:44px}.opt input{width:22px;height:22px}label.f{display:block;margin:18px 0 6px;font-weight:600}input[type=email],input[type=text],textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #24324f;background:#0b1220;color:#fff;font-size:16px}textarea{min-height:140px}:focus-visible{outline:3px solid #7fd3ff;outline-offset:2px}.hint{font-size:14px;color:#94a3bf;margin:4px 0 0}.err{color:#ffb4b4;font-weight:600;margin:6px 0 0}button{margin-top:22px;width:100%;min-height:48px;padding:14px;border:0;border-radius:10px;background:#00b8ff;color:#04121f;font-weight:700;font-size:16px;cursor:pointer}.isca{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}.ok{border:1px solid #2f6f4f;background:#0b1a14;border-radius:10px;padding:16px}.proto{font-size:22px;font-weight:700;color:#fff;letter-spacing:.02em}.zv-legal{margin-top:24px;padding-top:14px;border-top:1px solid #1c2a44;font-size:12px;color:#7f8ca3;line-height:1.6}";

function shell(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ZEVANORY</title><meta name="robots" content="noindex"><link rel="icon" href="/brand/export/avatar-400.png"><style>${STYLE}</style></head><body><main id="conteudo"><a class="zv-brand" href="https://vendas.zevanory.api.br/"><img src="/brand/zevanory-logo-dark.svg" alt="ZEVANORY" width="224" height="51"></a>${body}<p class="zv-legal">${esc(LEGAL_IDENTITY)} · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> · <a href="https://vendas.zevanory.api.br/termos">Termos</a> · <a href="https://vendas.zevanory.api.br/privacidade">Privacidade</a> · <a href="https://vendas.zevanory.api.br/reembolso">Reembolso</a></p></main></body></html>`;
}

export function formPage({ values = {}, errors = {}, tipo = "" } = {}) {
  const sel = values.tipo || (Object.hasOwn(TIPOS, tipo) ? tipo : "");
  const err = (k) => errors[k] ? `<p class="err" id="err-${k}">${esc(errors[k])}</p>` : "";
  const desc = (k, hint) => `aria-describedby="${hint ? `hint-${k}` : ""}${errors[k] ? ` err-${k}` : ""}"${errors[k] ? ' aria-invalid="true"' : ""}`;
  const summary = Object.keys(errors).length ? `<div role="alert"><p class="err">Corrija os campos indicados abaixo.</p></div>` : "";
  const opts = Object.entries(TIPOS).map(([k, label]) => `<div class="opt"><input type="radio" id="tipo-${k}" name="tipo" value="${k}" required${sel === k ? " checked" : ""}><label for="tipo-${k}">${esc(label)}</label></div>`).join("");
  return shell("Atendimento", `<h1>Atendimento</h1>
<p>Suporte, reclamação, cancelamento ou reembolso. Você recebe na hora um <strong>número de protocolo</strong>, na tela e por e-mail. ${esc(SLA_TEXT)} A resposta chega pelo e-mail que você informar.</p>
<p>Prefere e-mail? Escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Para desistir de uma compra (direito de arrependimento), use também a <a href="/pedir-reembolso">mesma ferramenta usada na compra</a>.</p>
${summary}<form method="post" action="${ATENDIMENTO_API}" novalidate>
<fieldset ${errors.tipo ? 'aria-describedby="err-tipo" aria-invalid="true"' : ""}><legend>Tipo de solicitação</legend>${opts}${err("tipo")}</fieldset>
<label class="f" for="email">Seu e-mail (a resposta chega por ele)</label><input id="email" name="email" type="email" required autocomplete="email" inputmode="email" maxlength="254" value="${esc(values.email || "")}" ${desc("email", false)}>${err("email")}
<label class="f" for="pedido">Código do pedido (opcional)</label><input id="pedido" name="pedido" type="text" autocomplete="off" maxlength="64" value="${esc(values.pedido || "")}" ${desc("pedido", true)}><p class="hint" id="hint-pedido">Está no e-mail de entrega. Deixe em branco se não tiver.</p>${err("pedido")}
<label class="f" for="mensagem">Descreva a solicitação</label><textarea id="mensagem" name="mensagem" required minlength="10" maxlength="${MAX_MESSAGE}" ${desc("mensagem", true)}>${esc(values.mensagem || "")}</textarea><p class="hint" id="hint-mensagem">Não envie senhas nem dados de cartão.</p>${err("mensagem")}
<div class="isca" aria-hidden="true"><label for="website">Não preencha este campo</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button type="submit">Enviar e receber protocolo</button></form>
<p class="hint">Usamos seu e-mail e a mensagem só para responder esta solicitação (LGPD, art. 7º, V). Detalhes na <a href="https://vendas.zevanory.api.br/privacidade">Política de Privacidade</a>.</p>`);
}

export function confirmationPage(view, { emailSent = true } = {}) {
  const reembolso = view.tipo === "reembolso" ? `<p>Se o pedido foi pago, você também pode registrar o reembolso automaticamente, pela mesma ferramenta usada na compra: <a href="/pedir-reembolso">zevanory.api.br/pedir-reembolso</a>.</p>` : "";
  return shell("Solicitação recebida", `<div class="ok" role="status" aria-live="polite"><h1>Solicitação recebida</h1><p>Seu número de protocolo:</p><p class="proto" id="protocolo">${esc(view.protocolo)}</p>
<p>Tipo: ${esc(TIPOS[view.tipo] || view.tipo)}. Resposta conclusiva até <strong>${esc(brDate(Date.parse(view.responder_ate)))}</strong>, pelo e-mail informado.</p>
<p>${emailSent ? "Enviamos uma confirmação com este protocolo para o seu e-mail." : `A confirmação por e-mail será reenviada automaticamente em instantes. Guarde este protocolo; se ela não chegar, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> informando o protocolo.`}</p>${reembolso}</div>
<p><a href="${ATENDIMENTO_PATH}">Enviar outra solicitação</a></p>`);
}

// Página de erro com texto fixo por status (nenhum dado da requisição é interpolado).
const ERROR_TEXT = Object.freeze({
  429: `Muitas solicitações em pouco tempo. Tente de novo mais tarde ou escreva para ${SUPPORT_EMAIL}.`,
  503: `Não foi possível registrar agora. Escreva para ${SUPPORT_EMAIL}.`,
});
const ERROR_PAGES = Object.freeze(Object.fromEntries(Object.entries(ERROR_TEXT).map(([k, msg]) => [k, shell("Atendimento", `<div role="alert"><h1>Não foi possível registrar agora</h1><p>${esc(msg)}</p></div><p><a href="${ATENDIMENTO_PATH}">Voltar ao formulário</a></p>`)])));
const IGNORED_PAGE = shell("Atendimento", '<div role="status"><h1>Recebido</h1></div>');
function errorPage(status) {
  return ERROR_PAGES[status] || ERROR_PAGES[503];
}

export async function handleAtendimento(request, env = {}, { sqlFactory, fetchImpl, now = Date.now(), q, transient } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== ATENDIMENTO_PATH && url.pathname !== ATENDIMENTO_API) return null;
  if (url.pathname === ATENDIMENTO_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method_not_allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    return new Response(formPage({ tipo: url.searchParams.get("tipo") || "" }), { status: 200, headers: HTML_HEADERS });
  }
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...JSON_HEADERS, allow: "POST" } });
  const type = String(request.headers.get("content-type") || "");
  const wantsJson = type.includes("application/json");
  let raw = {};
  try {
    if (wantsJson) raw = await request.json();
    else { const f = await request.formData(); for (const k of ["tipo", "email", "pedido", "mensagem", "website"]) raw[k] = f.get(k) || ""; }
  } catch {}
  const input = parseInput(raw);
  let out;
  try { out = await registerRequest(env, input, { ip: request.headers.get("cf-connecting-ip") || "unknown", now, sqlFactory, fetchImpl, q, transient }); }
  catch { out = { status: 503, body: { error: "atendimento_indisponivel" } }; }
  if (wantsJson) {
    const body = out.status === 503 ? { error: "atendimento_indisponivel", message: ERROR_TEXT[503] } : out.status === 429 ? { error: "muitas_tentativas", message: ERROR_TEXT[429] } : out.body;
    return new Response(JSON.stringify(body), { status: out.status, headers: JSON_HEADERS });
  }
  if (out.status === 400) return new Response(formPage({ values: input, errors: out.body.errors }), { status: 400, headers: HTML_HEADERS });
  if (out.status !== 200) return new Response(errorPage(out.status), { status: out.status, headers: HTML_HEADERS });
  if (out.body.ignored) return new Response(IGNORED_PAGE, { status: 200, headers: HTML_HEADERS });
  return new Response(confirmationPage(out.body, { emailSent: out.body.email_confirmacao === "enviado" }), { status: 200, headers: HTML_HEADERS });
}
