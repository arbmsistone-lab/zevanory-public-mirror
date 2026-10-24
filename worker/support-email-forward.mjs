// suporte@ / contato@ — o e-mail oficial do consumidor (CDC + Decreto 7.962/2013) chega ao proprietário.
//
// Caminho: MX do apex -> Resend Receiving -> webhook `email.received` assinado (Svix) em
// POST /api/webhooks/resend -> outbox durável em PostgreSQL -> encaminhamento ao dono -> confirmação ao cliente.
//
// * Assinatura Svix verificada com RESEND_WEBHOOK_SECRET ANTES de tudo; segredo ausente, assinatura
//   errada ou carimbo fora de 5 min => 401 (fail-closed).
// * Só `email.received` para suporte@/contato@. Outros eventos/destinatários (incluindo prova-sandbox@)
//   devolvem `null` e o Worker segue para o handler legado, sem mudança.
// * Outbox (tabela zevanory_support_inbound, uma linha por email_id do Resend, sem conteúdo):
//     forward_pending --encaminhou--> ack_pending --confirmou--> done
//                     \--sem confirmação (auto-resposta, cota, desligada)--> done
//   Cada passo tem lease (2 min), tentativas com recuo exponencial e Idempotency-Key própria no Resend
//   (support-fwd/<id>, support-ack/<id>). Falha => continua pendente; o webhook (redelivery) e o cron
//   horário (drainSupportOutbox) retomam. Após MAX_ATTEMPTS => forward_dead / ack_dead.
//   Nada de conteúdo nem endereço é guardado: o passo seguinte relê o e-mail no Resend pelo id.
// * Cota da confirmação reservada ATOMICAMENTE no mesmo comando SQL que muda o estado
//   (INSERT…ON CONFLICT em zevanory_support_ack_quota): 1 por remetente por dia UTC, ACK_DAILY_CAP no total.
// * Remetente pseudonimizado com HMAC-SHA256 (LEAD_PRIVACY_SECRET, separação de domínio própria);
//   sem segredo => 503 (nunca hash simples).
// * O dono nunca aparece: encaminhamento e confirmação saem de suporte@; Reply-To do encaminhamento é o
//   cliente; Reply-To da confirmação é suporte@. Responder como suporte@ no Gmail: docs/ops/EMAIL_SUPORTE.md.
// * HTML higienizado por lista de permissão (sem script/estilo/iframe/form/img/on*/javascript:), com tetos
//   de tamanho; anexos com teto de quantidade/tamanho, tamanho desconhecido recusado, executáveis recusados.
// * Logs sem conteúdo, assunto ou endereço.

import { LEGAL_IDENTITY } from "./politica-unica.mjs";

export const SUPPORT_DOMAIN = "zevanory.api.br";
export const SUPPORT_ADDRESS = `suporte@${SUPPORT_DOMAIN}`;
export const SUPPORT_ALIASES = Object.freeze(["suporte", "contato"]);
export const FORWARD_SUBJECT_PREFIX = "[ZEVANORY suporte]";
export const FORWARD_TO_KV_KEY = "support-config:forward-to";
export const ACK_DAILY_CAP = 30;
// Orçamentos separados por passo: falha de LEITURA do conteúdo não consome tentativas de ENVIO (e vice-versa).
export const MAX_READ_FAILURES = 10;
export const MAX_SEND_FAILURES = 10;
// Teto absoluto de leases por passo (leitura + envio).
export const MAX_ATTEMPTS = MAX_READ_FAILURES + MAX_SEND_FAILURES;
// 404 na leitura é transitório por tempo limitado (consistência eventual do provedor); depois disso, permanente.
export const NOT_FOUND_GRACE_MINUTES = 30;
// Resend guarda Idempotency-Key por 24 h (https://resend.com/docs/dashboard/emails/idempotency-keys).
// Nenhuma tentativa acontece depois de 23 h da chegada: toda repetição fica dentro da janela da chave.
export const RETRY_LIFETIME_HOURS = 23;
export const ALERT_EVERY_HOURS = 6;
// Remetentes de plataforma que nunca recebem confirmação automática (lista da aplicação; comparação exata,
// sem diferenciar maiúsculas). O encaminhamento ao dono continua obrigatório. Não usa a supressão global do Resend.
export const ACK_SUPPRESSED_SENDERS = Object.freeze(["support@support.whatsapp.com"]);
// Chamado do suporte do WhatsApp: From fixo + Reply-To numérico do ticket. A resposta humana deve ir ao ticket.
export const WHATSAPP_SUPPORT_FROM = "support@support.whatsapp.com";
export const WHATSAPP_TICKET_RE = /^[0-9]{5,20}@support\.whatsapp\.com$/;
export const DRAIN_PATH = "/api/internal/support/outbox/drain";
export const BACKLOG_ALERT_COUNT = 5;
export const BACKLOG_ALERT_AGE_MINUTES = 120;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL = 20 * 1024 * 1024;
export const MAX_HTML_IN = 512 * 1024;
export const MAX_HTML_OUT = 200 * 1024;
export const MAX_TEXT = 100 * 1024;
const RECEIVING_KEY_KV = "sandbox-config:resend-receiving-key";
const RESEND = "https://api.resend.com";
const FROM = `ZEVANORY suporte <${SUPPORT_ADDRESS}>`;
const MAX_BODY = 256 * 1024;
const TOLERANCE_S = 300;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
let schemaReady = false;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
});
const log = (event, fields = {}) => { try { console.log("SUPPORT_EMAIL", JSON.stringify({ event, ...fields })); } catch {} };

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function safeEqual(a, b) {
  const x = String(a), y = String(b);
  if (!x || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}
async function hmacSign(keyBytes, message) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// Svix (formato do Resend): HMAC-SHA256(base64(secret sem "whsec_"), `${id}.${ts}.${body}`).
export async function verifySvixSignature({ payload, id, timestamp, signature, secret, nowMs = Date.now() }) {
  if (!payload || !id || !timestamp || !signature || !String(secret || "").startsWith("whsec_")) return false;
  if (!/^\d{1,12}$/.test(String(timestamp))) return false;
  const ts = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > TOLERANCE_S) return false;
  let keyBytes;
  try { keyBytes = b64ToBytes(String(secret).slice(6)); } catch { return false; }
  if (!keyBytes.length) return false;
  const expected = bytesToB64(await hmacSign(keyBytes, `${id}.${timestamp}.${payload}`));
  return String(signature).split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && Boolean(value) && safeEqual(value, expected);
  });
}

// Pseudônimo com chave: sem LEAD_PRIVACY_SECRET (>= 32) não há pseudônimo (e o fluxo para), nunca hash simples.
export function senderSecret(env) {
  const v = String(env?.LEAD_PRIVACY_SECRET || "");
  return v.length >= 32 ? v : "";
}
export async function senderRef(secret, address) {
  const mac = await hmacSign(new TextEncoder().encode("zevanory-support-sender-v1:" + secret), "sender:" + String(address || "invalid").toLowerCase());
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export function addressOf(raw) {
  const v = raw && typeof raw === "object" ? (raw.email || raw.address || "") : raw;
  const s = String(v || "").trim().toLowerCase();
  const m = /<([^<>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim();
  return EMAIL_RE.test(addr) ? addr : "";
}
// Remetente pela METADADO autenticado do provedor (campo `from` da API do Resend), nunca por cabeçalho do corpo.
// Normaliza caixa, nome de exibição e espaços; mais de um endereço (ou quebra de linha) => inválido.
export function providerAddress(raw) {
  if (Array.isArray(raw)) return raw.length === 1 ? providerAddress(raw[0]) : "";
  const v = raw && typeof raw === "object" ? (raw.email || raw.address || "") : raw;
  const s = String(v ?? "");
  if (/[\r\n\0]/.test(s) || (s.match(/@/g) || []).length !== 1) return "";
  return addressOf(s.trim());
}
const list = (raw) => (Array.isArray(raw) ? raw : raw ? [raw] : []).map(addressOf).filter(Boolean);

export function supportAlias(data) {
  const all = [...list(data?.to), ...list(data?.received_for), ...list(data?.cc)];
  for (const alias of SUPPORT_ALIASES) if (all.includes(`${alias}@${SUPPORT_DOMAIN}`)) return alias;
  return "";
}

function headerMap(raw) {
  const out = {};
  if (Array.isArray(raw)) for (const h of raw) { if (h && h.name) out[String(h.name).toLowerCase()] = String(h.value ?? ""); }
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  return out;
}

// RFC 3834 + práticas comuns: qualquer sinal de mensagem automática => não confirmar (evita laço/backscatter).
export function isAutomated({ from, subject, headers, forwardTo }) {
  const addr = providerAddress(from);
  if (!addr) return "sender_invalid";
  if (ACK_SUPPRESSED_SENDERS.includes(addr)) return "automated_provider";
  const [local, domain] = addr.split("@");
  if (domain === SUPPORT_DOMAIN || domain.endsWith("." + SUPPORT_DOMAIN)) return "own_domain";
  if (forwardTo && addr === String(forwardTo).toLowerCase()) return "owner_address";
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notify|auto-?reply|autoresponder)([+._-]|$)/i.test(local)) return "noreply_sender";
  const h = headerMap(headers);
  const auto = String(h["auto-submitted"] || "").trim().toLowerCase();
  if (auto && auto !== "no") return "auto_submitted";
  if (/^(bulk|junk|list|auto_reply)$/i.test(String(h.precedence || "").trim())) return "precedence";
  for (const k of ["x-autoreply", "x-autorespond", "x-auto-response-suppress", "list-id", "list-unsubscribe", "x-failed-recipients", "feedback-id"]) if (h[k]) return "auto_header";
  if (String(h["return-path"] || "").trim() === "<>") return "null_return_path";
  if (/multipart\/report/i.test(String(h["content-type"] || ""))) return "delivery_report";
  if (/^\s*(auto(matic)?[ -]?reply|out of office|resposta autom[aá]tica|ausente|f[eé]rias|undeliverable|undelivered|delivery status notification|mail delivery (failed|subsystem)|returned mail|n[aã]o entregue)/i.test(String(subject || ""))) return "auto_subject";
  return "";
}

// ---------- higienização de HTML (lista de permissão) ----------
const DROP_WITH_CONTENT = ["script", "style", "head", "title", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "noscript", "xml", "textarea", "select", "button", "form"];
const ALLOWED_TAGS = new Set(["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "small", "sub", "sup"]);
const VOID_TAGS = new Set(["br", "hr"]);
const decodeEntities = (s) => String(s).replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32)).replace(/&colon;/gi, ":").replace(/&tab;|&newline;/gi, "").replace(/&amp;/gi, "&");
export function safeHref(raw) {
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]+/g, "");
  return /^(https?:|mailto:)/i.test(v) ? v.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E") : "";
}
export function sanitizeHtml(input) {
  let s = String(input || "");
  if (s.length > MAX_HTML_IN) return "";
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/gi, "").replace(/<![^>]*>/g, "").replace(/<\?[\s\S]*?(\?>|$)/g, "");
  const drop = new RegExp(`<\\s*(${DROP_WITH_CONTENT.join("|")})\\b[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi");
  const dropOpen = new RegExp(`<\\s*(${DROP_WITH_CONTENT.join("|")})\\b[\\s\\S]*$`, "gi");
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(drop, ""); }
  s = s.replace(dropOpen, "");
  let out = "";
  let last = 0;
  const tag = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g;
  const text = (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (let m; (m = tag.exec(s));) {
    out += text(s.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) { if (!VOID_TAGS.has(name)) out += `</${name}>`; continue; }
    let attrs = "";
    if (name === "a") {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[3]);
      const safe = href ? safeHref(href[1] ?? href[2] ?? href[3] ?? "") : "";
      if (safe) attrs = ` href="${safe}" rel="noopener noreferrer nofollow"`;
    }
    out += `<${name}${attrs}>`;
  }
  out += text(s.slice(last));
  return out.length > MAX_HTML_OUT ? "" : out;
}

// ---------- anexos ----------
const EXEC_EXT = /\.(exe|com|bat|cmd|scr|pif|msi|msp|mst|dll|cpl|sys|drv|ocx|jar|js|jse|mjs|vbs|vbe|wsf|wsh|ws|ps1|psm1|psd1|hta|lnk|reg|inf|sh|bash|zsh|csh|ksh|run|bin|app|dmg|pkg|deb|rpm|apk|aab|ipa|xap|appx|msix|iso|img|vhd|vhdx|gadget|application|scf|url|chm|docm|xlsm|pptm|xlam|dotm)$/i;
const EXEC_TYPE = /(x-msdownload|x-msdos-program|x-dosexec|x-executable|x-mach-binary|x-elf|x-sh|x-shellscript|x-bat|x-msi|java-archive|vnd\.android\.package-archive|x-apple-diskimage|x-iso9660-image|javascript|ecmascript|vbscript|hta|x-ms-shortcut|vnd\.microsoft\.portable-executable|macroenabled)/i;
export function selectAttachments(rows) {
  const accepted = [];
  let rejected = 0, total = 0;
  for (const a of Array.isArray(rows) ? rows : []) {
    const filename = String(a?.filename || "").replace(/[\u0000-\u001f\u007f"\\/]+/g, "_").trim().slice(0, 120);
    const url = String(a?.download_url || "");
    const size = Number(a?.size);
    const type = String(a?.content_type || "");
    const ok = filename && /^https:\/\//.test(url) && Number.isFinite(size) && size > 0 && size <= MAX_ATTACHMENT_BYTES &&
      total + size <= MAX_ATTACHMENTS_TOTAL && accepted.length < MAX_ATTACHMENTS && !EXEC_EXT.test(filename) && !EXEC_TYPE.test(type);
    if (!ok) { rejected++; continue; }
    total += size;
    accepted.push({ path: url, filename });
  }
  return { accepted, rejected };
}

const cleanSubject = (s) => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "(sem assunto)";

async function forwardTarget(env) {
  let v = String(env.SUPPORT_FORWARD_TO || "").trim().toLowerCase();
  if (!v && env.ZEVANORY_PRIVATE_ARTIFACTS?.get) {
    try { v = String((await env.ZEVANORY_PRIVATE_ARTIFACTS.get(FORWARD_TO_KV_KEY)) || "").trim().toLowerCase(); } catch {}
  }
  if (!EMAIL_RE.test(v)) return "";
  if (v.endsWith("@" + SUPPORT_DOMAIN)) return ""; // suporte@ -> suporte@ seria laço
  return v;
}

async function receivingKey(env) {
  let key = String(env.RESEND_RECEIVING_API_KEY || "");
  if (!key && env.ZEVANORY_PRIVATE_ARTIFACTS?.get) {
    try { key = String((await env.ZEVANORY_PRIVATE_ARTIFACTS.get(RECEIVING_KEY_KV)) || ""); } catch {}
  }
  return key;
}

async function resendCall(fetchImpl, path, { key, method = "GET", body, idempotencyKey } = {}) {
  const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
  if (body) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let r;
  try {
    r = await fetchImpl(RESEND + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    const m = [error?.name, error?.message, error?.code, error?.cause?.code, error?.cause?.message].map((x) => String(x || "")).join(" ");
    const kind = /timeout|abort/i.test(m) ? "timeout" : /ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(m) ? "network_dns" : /ECONNRESET|EPIPE|reset|hang up/i.test(m) ? "network_reset" : "network";
    return { status: 0, ok: false, data: null, error: kind };
  }
  let data = null, parsed = true;
  try { data = await r.json(); } catch { parsed = false; }
  return { status: r.status, ok: r.ok, data, parsed };
}

// Classe da falha: transient (repete), config (repete e alerta o dono), permanent (morre já),
// not_found (transitório por NOT_FOUND_GRACE_MINUTES da chegada, depois permanente).
export function failureClass(reason) {
  if (/key_permission/.test(reason)) return "config";
  if (/^http_404/.test(reason)) return "not_found";
  if (/^http_(400|422)/.test(reason)) return "permanent";
  if (/^(http_429|http_5xx|timeout|network|invalid_json|unexpected_body)/.test(reason)) return "transient";
  if (/^http_4\d\d/.test(reason)) return "permanent";
  return "transient";
}

// Código de motivo SEM dado pessoal: distingue permissão da chave, endpoint/id, limite e falha do provedor.
export function resendReason(res) {
  const st = Number(res?.status) || 0;
  if (!st) return ["timeout", "network_dns", "network_reset"].includes(res?.error) ? res.error : "network";
  if (st === 401 || st === 403) return `http_${st}_key_permission`;
  if (st === 404) return "http_404_not_found";
  if (st === 422 || st === 400) return `http_${st}_invalid_request`;
  if (st === 429) return "http_429_rate_limited";
  if (st >= 500) return "http_5xx";
  if (res?.ok && res?.parsed === false) return "invalid_json";
  if (res?.ok) return "unexpected_body";
  return `http_${st}`;
}

// ---------- outbox (PostgreSQL) ----------
export async function ensureSupportSchema(sql) {
  if (schemaReady) return;
  await sql.query(`/*support:schema*/ create table if not exists zevanory_support_inbound (
    email_id text primary key, alias text not null, sender_ref text not null,
    state text not null default 'forward_pending' check (state in ('forward_pending','ack_pending','done','forward_dead','ack_dead')),
    attempts integer not null default 0, next_attempt_at timestamptz not null default now(), lease_until timestamptz,
    forward_id text, forwarded_at timestamptz, ack_status text, ack_sent_at timestamptz,
    alerted_at timestamptz, last_reason text, read_failures integer not null default 0, send_failures integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`, []);
  await sql.query(`/*support:schema*/ create table if not exists zevanory_support_alerts (
    kind text primary key, last_sent_at timestamptz not null)`, []);
  await sql.query(`/*support:schema*/ create table if not exists zevanory_support_ack_quota (
    bucket text not null, day date not null, n integer not null default 0, primary key (bucket, day))`, []);
  await sql.query("/*support:schema*/ alter table zevanory_support_inbound add column if not exists last_reason text, add column if not exists read_failures integer not null default 0, add column if not exists send_failures integer not null default 0", []);
  await sql.query("/*support:schema*/ create index if not exists zevanory_support_inbound_due_idx on zevanory_support_inbound (state, next_attempt_at)", []);
  schemaReady = true;
}
export function resetSupportSchemaCache() { schemaReady = false; }

const SQL = Object.freeze({
  record: `/*support:record*/ insert into zevanory_support_inbound (email_id, alias, sender_ref) values ($1, $2, $3)
    on conflict (email_id) do nothing returning email_id`,
  lease: `/*support:lease*/ update zevanory_support_inbound set lease_until = now() + interval '2 minutes', attempts = attempts + 1, updated_at = now()
    where email_id = $1 and state in ('forward_pending','ack_pending') and next_attempt_at <= now()
      and (lease_until is null or lease_until < now())
      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)
      and read_failures < $4 and send_failures < $5
    returning state, alias, attempts, sender_ref, read_failures, send_failures, floor(extract(epoch from now() - created_at))::int as age_s`,
  // Falha de um passo: incrementa SÓ o contador do tipo (leitura ou envio); morre se permanente, se o contador
  // do tipo atingir o teto ou se o orçamento geral acabou.
  retry: `/*support:retry*/ update zevanory_support_inbound set lease_until = null, updated_at = now(), last_reason = $4,
      read_failures = read_failures + case when $5 = 'read' then 1 else 0 end,
      send_failures = send_failures + case when $5 = 'send' then 1 else 0 end,
      next_attempt_at = now() + make_interval(mins => $2::int),
      state = case when $3::boolean
          or ($5 = 'read' and read_failures + 1 >= $6::int)
          or ($5 = 'send' and send_failures + 1 >= $7::int)
        then (case state when 'forward_pending' then 'forward_dead' else 'ack_dead' end) else state end
    where email_id = $1 and state in ('forward_pending','ack_pending')
    returning state`,
  // Passo de encaminhamento concluído sem confirmação (auto-resposta, desligada, remetente inválido).
  forwardedNoAck: `/*support:forwarded_no_ack*/ update zevanory_support_inbound set state = 'done', ack_status = $2, forward_id = $3,
      forwarded_at = now(), lease_until = null, attempts = 0, next_attempt_at = now(), updated_at = now()
    where email_id = $1 and state = 'forward_pending'`,
  // Passo de encaminhamento concluído + reserva ATÔMICA da cota da confirmação, num único comando:
  // r trava a linha; s reserva a vaga do remetente no dia (1, ON CONFLICT DO NOTHING); g só consome a vaga
  // global se s reservou e n < teto (ON CONFLICT DO UPDATE ... WHERE); u muda o estado conforme o resultado.
  // Falha de g depois de s consome só a vaga do próprio remetente (erra para MENOS confirmações, nunca mais).
  forwardedReserveAck: `/*support:forwarded_reserve_ack*/ with r as (
      select email_id, sender_ref from zevanory_support_inbound where email_id = $1 and state = 'forward_pending' for update
    ), s as (
      insert into zevanory_support_ack_quota (bucket, day, n) select 's:' || r.sender_ref, $2::date, 1 from r
      on conflict (bucket, day) do nothing returning 1 as ok
    ), g as (
      insert into zevanory_support_ack_quota (bucket, day, n) select 'all', $2::date, 1 from s
      on conflict (bucket, day) do update set n = zevanory_support_ack_quota.n + 1 where zevanory_support_ack_quota.n < $3
      returning 1 as ok
    ), u as (
      update zevanory_support_inbound i set
        state = case when exists (select 1 from g) then 'ack_pending' else 'done' end,
        ack_status = case when exists (select 1 from g) then 'pending' when exists (select 1 from s) then 'rate_limited_daily' else 'rate_limited_sender' end,
        -- com confirmação a fazer, o lease continua com este processo (o passo de confirmação segue na mesma execução)
        lease_until = case when exists (select 1 from g) then now() + interval '2 minutes' else null end,
        attempts = case when exists (select 1 from g) then 1 else 0 end, read_failures = 0, send_failures = 0,
        forward_id = $4, forwarded_at = now(), next_attempt_at = now(), updated_at = now()
      from r where i.email_id = r.email_id returning i.state, i.ack_status
    ) select state, ack_status from u`,
  acked: `/*support:acked*/ update zevanory_support_inbound set state = 'done', ack_status = 'sent', ack_sent_at = now(), lease_until = null, updated_at = now()
    where email_id = $1 and state = 'ack_pending'`,
  due: `/*support:due*/ select email_id from zevanory_support_inbound where state in ('forward_pending','ack_pending') and next_attempt_at <= now()
      and (lease_until is null or lease_until < now())
      and attempts < $2 and created_at > now() - make_interval(hours => $3::int)
      and read_failures < $4 and send_failures < $5 order by next_attempt_at limit $1`,
  // Linhas fora do orçamento (tentativas ou janela da Idempotency-Key) viram *_dead sem novo efeito externo.
  reap: `/*support:reap*/ update zevanory_support_inbound set state = case state when 'forward_pending' then 'forward_dead' else 'ack_dead' end,
      lease_until = null, updated_at = now()
    where state in ('forward_pending','ack_pending') and (lease_until is null or lease_until < now())
      and (attempts >= $1 or created_at <= now() - make_interval(hours => $2::int) or read_failures >= $3 or send_failures >= $4)`,
  stats: `/*support:stats*/ select
      count(*) filter (where state in ('forward_dead','ack_dead') and alerted_at is null)::int as dead_new,
      count(*) filter (where state in ('forward_pending','ack_pending'))::int as pending,
      coalesce(floor(extract(epoch from now() - min(created_at) filter (where state in ('forward_pending','ack_pending'))) / 60), 0)::int as oldest_min
    from zevanory_support_inbound`,
  // Limite de alertas por tipo, reservado atomicamente (um alerta por ALERT_EVERY_HOURS).
  alertReserve: `/*support:alert_reserve*/ insert into zevanory_support_alerts (kind, last_sent_at) values ($1, now())
    on conflict (kind) do update set last_sent_at = now() where zevanory_support_alerts.last_sent_at < now() - make_interval(hours => $2::int)
    returning kind`,
  alertRelease: `/*support:alert_release*/ update zevanory_support_alerts set last_sent_at = to_timestamp(0) where kind = $1`,
  deadAlerted: `/*support:dead_alerted*/ update zevanory_support_inbound set alerted_at = now()
    where state in ('forward_dead','ack_dead') and alerted_at is null`
});

// Orçamento conferido antes de TODA chamada externa (além da condição do lease no SQL).
export function withinBudget(row, nowAgeS = Number(row?.age_s)) {
  return Number(row?.attempts) >= 1 && Number(row?.attempts) <= MAX_ATTEMPTS && Number.isFinite(nowAgeS) && nowAgeS >= 0 && nowAgeS < RETRY_LIFETIME_HOURS * 3600
    && Number(row?.read_failures || 0) < MAX_READ_FAILURES && Number(row?.send_failures || 0) < MAX_SEND_FAILURES;
}
const backoffMinutes = (attempts) => Math.min(360, 2 ** Math.max(0, Math.min(9, attempts)));

// Reply-To do encaminhamento: o cliente (From), exceto chamado do suporte do WhatsApp, cuja resposta humana
// precisa ir ao endereço numérico do ticket informado no Reply-To original.
export function forwardReplyTo(detail) {
  const sender = providerAddress(detail?.from);
  if (sender === WHATSAPP_SUPPORT_FROM) {
    // Só o reply_to do METADADO do provedor; exatamente UM endereço, e ele precisa casar com o ticket.
    const rt = Array.isArray(detail?.reply_to) ? detail.reply_to : detail?.reply_to ? [detail.reply_to] : [];
    if (rt.length === 1) {
      const ticket = providerAddress(rt[0]);
      if (ticket && WHATSAPP_TICKET_RE.test(ticket)) return ticket;
    }
  }
  return sender;
}

function forwardBody(alias, sender, emailId, detail, notes) {
  const head = [
    `Mensagem recebida em ${alias}@${SUPPORT_DOMAIN}.`,
    `De: ${sender || "(remetente inválido)"}`,
    `Recebida em: ${String(detail?.created_at || "")}`,
    `ID Resend: ${emailId}`,
    sender ? "Responder a este e-mail responde direto ao cliente (Reply-To). Responda como suporte@ (veja docs/ops/EMAIL_SUPORTE.md)." : "Remetente inválido: não responda por este e-mail.",
    ...notes
  ].filter(Boolean);
  let original = String(detail?.text || "");
  if (original.length > MAX_TEXT) original = original.slice(0, MAX_TEXT) + "\n[texto cortado: veja a mensagem completa no painel Resend > Receiving]";
  const text = head.join("\n") + "\n\n---------- Mensagem original ----------\n" + (original || "(sem versão em texto)");
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clean = detail?.html ? sanitizeHtml(detail.html) : "";
  const html = clean ? `<div style="font:13px/1.5 system-ui,sans-serif;color:#334;border-left:3px solid #2dd4a7;padding:6px 10px;margin:0 0 14px">${head.map(esc).join("<br>")}</div>${clean}` : undefined;
  return { text, html, htmlDropped: Boolean(detail?.html) && !clean };
}

function ackText() {
  return [
    "Olá,",
    "",
    `Recebemos sua mensagem enviada para ${SUPPORT_ADDRESS} e ela já está com a nossa equipe. Vamos responder por e-mail.`,
    "",
    "Se a mensagem for sobre uma compra, ajuda muito informar o e-mail usado na compra e o número do pedido ao responder.",
    "",
    "Esta é uma confirmação automática de recebimento.",
    "",
    "ZEVANORY",
    LEGAL_IDENTITY
  ].join("\n");
}

// GET /emails/receiving/{email_id} (docs oficiais: o webhook traz só metadados; corpo, headers e anexos vêm daqui).
async function readReceived(c, emailId, row) {
  if (!c.rKey) return { reason: "receiving_key_missing" };
  if (!withinBudget(row)) return { reason: "budget_exhausted" };
  const got = await resendCall(c.fetchImpl, `/emails/receiving/${encodeURIComponent(emailId)}`, { key: c.rKey });
  if (got.ok && got.data && typeof got.data === "object" && !Array.isArray(got.data)) return { detail: got.data };
  const reason = resendReason(got);
  if (/key_permission/.test(reason)) await alertKeyRejected(c, reason).catch(() => null);
  return { reason };
}

// kind: "read" (leitura do conteúdo) ou "send" (envio). permanent: morre sem nova tentativa.
async function retry(c, emailId, row, step, kind, reason, { permanent = false } = {}) {
  const failures = Number(kind === "read" ? row?.read_failures : row?.send_failures) || 0;
  const force = permanent || Number(row?.attempts) >= MAX_ATTEMPTS || !withinBudget(row);
  const res = await c.sql.query(SQL.retry, [emailId, backoffMinutes(failures + 1), force, String(reason).slice(0, 60), kind, MAX_READ_FAILURES, MAX_SEND_FAILURES]);
  const state = String(res?.[0]?.state || (force ? step + "_dead" : step + "_pending"));
  const dead = /_dead$/.test(state);
  log(dead ? step + "_dead" : step + "_retry", { kind, reason, failures: failures + 1 });
  return { state: dead ? step + "_dead" : step + "_pending", reason };
}
// Falha de leitura/envio do Resend -> retry com a classe certa (404 limitado no tempo; 400/422 permanentes).
function failRead(c, emailId, row, step, reason) {
  const cls = failureClass(reason);
  const permanent = cls === "permanent" || (cls === "not_found" && Number(row?.age_s) >= NOT_FOUND_GRACE_MINUTES * 60);
  return retry(c, emailId, row, step, "read", "content_" + reason + (permanent && cls === "not_found" ? "_permanent" : ""), { permanent });
}
function failSend(c, emailId, row, step, res) {
  const reason = resendReason(res);
  const cls = failureClass(reason);
  return retry(c, emailId, row, step, "send", "send_" + reason, { permanent: cls === "permanent" || cls === "not_found" });
}

async function stepForward(c, emailId, row) {
  if (!withinBudget(row)) return retry(c, emailId, row, "forward", "read", "budget_exhausted", { permanent: true });
  const read = await readReceived(c, emailId, row);
  const detail = read.detail;
  if (!detail) return failRead(c, emailId, row, "forward", read.reason);
  const sender = providerAddress(detail.from);
  const notes = [];
  let attachments = [];
  const meta = Array.isArray(detail.attachments) ? detail.attachments : [];
  if (meta.length && withinBudget(row)) {
    const listed = await resendCall(c.fetchImpl, `/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { key: c.rKey }).catch(() => ({ ok: false }));
    const picked = selectAttachments(listed.ok && Array.isArray(listed.data?.data) ? listed.data.data : []);
    attachments = picked.accepted;
    const missing = meta.length - attachments.length;
    if (missing > 0) notes.push(`Atenção: ${missing} anexo(s) não copiados (executável, tamanho desconhecido/excessivo ou acima de ${MAX_ATTACHMENTS}); veja no painel Resend > Receiving.`);
  }
  const replyTo = forwardReplyTo(detail);
  if (replyTo && replyTo !== sender) notes.push("Chamado do suporte do WhatsApp: \"Responder\" vai para o endereço do chamado (Reply-To original).");
  const { text, html, htmlDropped } = forwardBody(row.alias, sender, emailId, detail, notes);
  const body = {
    from: FROM, to: [c.forwardTo], subject: `${FORWARD_SUBJECT_PREFIX} ${cleanSubject(detail.subject)}`,
    text: htmlDropped ? text + "\n\n[versão HTML omitida por segurança/tamanho]" : text,
    ...(html ? { html } : {}), ...(replyTo ? { reply_to: [replyTo] } : {}), ...(attachments.length ? { attachments } : {})
  };
  if (!withinBudget(row)) return retry(c, emailId, row, "forward", "send", "budget_exhausted", { permanent: true });
  const sent = await resendCall(c.fetchImpl, "/emails", { key: c.sendKey, method: "POST", body, idempotencyKey: `support-fwd/${emailId}` });
  // 409 invalid_idempotent_request: a mesma chave já foi aceita antes com outro corpo (as URLs temporárias
  // dos anexos mudam a cada leitura). Dentro da janela de 24 h isso significa "já encaminhado": não reenviar.
  const already = sent?.status === 409 && String(sent?.data?.name || "") === "invalid_idempotent_request";
  const forwardId = already ? "idempotent:" + emailId.slice(0, 100) : String(sent?.data?.id || "").slice(0, 128);
  // Encaminhamento ao dono é obrigatório: sem ele a linha NUNCA vira done/skipped (nem para provedor automático).
  if (!(sent.ok || already) || !forwardId) return failSend(c, emailId, row, "forward", sent);
  const automated = String(c.env.SUPPORT_AUTO_ACK || "").toLowerCase() === "false" ? "disabled"
    : isAutomated({ from: detail.from, subject: detail.subject, headers: detail.headers, forwardTo: c.forwardTo });
  if (automated) {
    const status = automated === "disabled" ? "disabled" : "skipped_" + automated;
    await c.sql.query(SQL.forwardedNoAck, [emailId, status, forwardId]);
    log("forwarded", { alias: row.alias, attachments: attachments.length, ack: status });
    return { state: "done", ack: status };
  }
  const day = new Date(c.nowMs).toISOString().slice(0, 10);
  const res = await c.sql.query(SQL.forwardedReserveAck, [emailId, day, ACK_DAILY_CAP, forwardId]);
  const st = res?.[0] || {};
  log("forwarded", { alias: row.alias, attachments: attachments.length, ack: st.ack_status || "unknown" });
  if (st.state === "ack_pending") return stepAck(c, emailId, { ...row, attempts: 1, read_failures: 0, send_failures: 0 }, detail);
  return { state: st.state || "done", ack: st.ack_status };
}

async function stepAck(c, emailId, row, detailIn) {
  if (!withinBudget(row)) return retry(c, emailId, row, "ack", "read", "budget_exhausted", { permanent: true });
  const read = detailIn ? { detail: detailIn } : await readReceived(c, emailId, row);
  const detail = read.detail;
  if (!detail) return failRead(c, emailId, row, "ack", read.reason);
  const sender = providerAddress(detail.from);
  if (!sender) return retry(c, emailId, row, "ack", "send", "sender_invalid", { permanent: true });
  const messageId = String(detail.message_id || "").trim();
  const headers = { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" };
  if (/^<[^<>\s]{3,250}>$/.test(messageId)) { headers["In-Reply-To"] = messageId; headers.References = messageId; }
  if (!withinBudget(row)) return retry(c, emailId, row, "ack", "send", "budget_exhausted", { permanent: true });
  const sent = await resendCall(c.fetchImpl, "/emails", {
    key: c.sendKey, method: "POST", idempotencyKey: `support-ack/${emailId}`,
    body: { from: FROM, to: [sender], reply_to: [SUPPORT_ADDRESS], subject: "Recebemos sua mensagem — ZEVANORY", text: ackText(), headers }
  });
  if (!sent.ok) return failSend(c, emailId, row, "ack", sent);
  await c.sql.query(SQL.acked, [emailId]);
  log("acked", { alias: row.alias });
  return { state: "done", ack: "sent" };
}

// Executa o passo pendente de UMA linha, sob lease. Linha ocupada, em recuo ou concluída => nada.
export async function processSupportEmail(c, emailId) {
  const leased = await c.sql.query(SQL.lease, [emailId, MAX_ATTEMPTS, RETRY_LIFETIME_HOURS, MAX_READ_FAILURES, MAX_SEND_FAILURES]);
  const row = leased?.[0];
  if (!row) return { state: "not_due" };
  try {
    if (row.state === "forward_pending") return await stepForward(c, emailId, row);
    if (row.state === "ack_pending") return await stepAck(c, emailId, row);
    return { state: row.state };
  } catch {
    return retry(c, emailId, row, row.state === "ack_pending" ? "ack" : "forward", "send", "exception").catch(() => ({ state: "error" }));
  }
}

async function context(env, { sqlFactory, fetchImpl, nowMs }) {
  const forwardTo = await forwardTarget(env);
  const sendKey = String(env.RESEND_API_KEY || "");
  const secret = senderSecret(env);
  // Sem a chave de leitura do Resend a mensagem nunca poderia ser lida: recusar ANTES de aceitar (503, o Resend repete).
  const rKey = await receivingKey(env);
  const missing = [!forwardTo && "forward_to", !sendKey && "send_key", !rKey && "receiving_key", !secret && "privacy_secret", !(sqlFactory && env.DATABASE_URL) && "database"].filter(Boolean);
  if (missing.length) return { missing };
  return { env, forwardTo, sendKey, secret, rKey, sql: sqlFactory(env.DATABASE_URL), fetchImpl, nowMs };
}

// Webhook: devolve Response quando trata; `null` quando não é deste fluxo (o Worker segue normal).
export async function handleSupportInboundWebhook(request, env, { sqlFactory, fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/webhooks/resend") return null;
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  const raw = await request.clone().text();
  if (raw.length > MAX_BODY) return null;
  const ok = await verifySvixSignature({
    payload: raw,
    id: request.headers.get("svix-id") || "",
    timestamp: request.headers.get("svix-timestamp") || "",
    signature: request.headers.get("svix-signature") || "",
    secret: env.RESEND_WEBHOOK_SECRET,
    nowMs
  });
  if (!ok) {
    log("signature_rejected");
    return json(401, { error: "webhook_auth_failed", accepted: false });
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json(400, { error: "invalid_json", accepted: false }); }
  if (event?.type !== "email.received") return null;
  const data = event.data || {};
  const alias = supportAlias(data);
  if (!alias) return null;
  const emailId = String(data.email_id || "");
  if (!ID_RE.test(emailId)) return json(400, { error: "email_id_invalid", accepted: false });
  const c = await context(env, { sqlFactory, fetchImpl, nowMs });
  if (c.missing) {
    log("unconfigured", { alias, missing: c.missing });
    return json(503, { error: "support_forward_unconfigured", accepted: false, missing: c.missing });
  }
  let recorded;
  try {
    await ensureSupportSchema(c.sql);
    recorded = await c.sql.query(SQL.record, [emailId, alias, await senderRef(c.secret, addressOf(data.from))]);
  } catch {
    log("outbox_unavailable", { alias });
    return json(503, { error: "support_outbox_unavailable", accepted: false });
  }
  // Registro durável feito: daqui em diante o outbox garante as tentativas (webhook repetido e cron).
  const duplicate = !(Array.isArray(recorded) && recorded.length);
  let result;
  try { result = await processSupportEmail(c, emailId); } catch { result = { state: "error" }; }
  if (duplicate) log("redelivery", { alias, state: result.state });
  return json(200, { accepted: true, duplicate, alias, state: result.state, ack: result.ack });
}

// Cron horário: retoma passos pendentes (poucos por execução: limite de 50 subrequisições do Workers Free).
export async function drainSupportOutbox(env, opts = {}) {
  let out;
  try { out = await drainOnce(env, opts); } catch (error) { out = { ok: false, error: errorClass(error) }; }
  // Uma linha por execução, só contagens/códigos (sem conteúdo, endereço ou id).
  log("drain", { source: opts.source || "direct", ...out });
  return out;
}
export function errorClass(error) {
  const m = String(error?.message || error || "");
  if (/too many subrequests/i.test(m)) return "too_many_subrequests";
  if (/timeout|abort/i.test(m)) return "timeout";
  if (/postgres|neon|sql|relation|syntax|connect/i.test(m)) return "database";
  return "exception";
}
async function drainOnce(env, { sqlFactory, fetchImpl = globalThis.fetch, nowMs = Date.now(), limit = 2 } = {}) {
  const c = await context(env, { sqlFactory, fetchImpl, nowMs });
  if (c.missing) return { ok: true, skipped: "unconfigured", missing: c.missing };
  await ensureSupportSchema(c.sql);
  await c.sql.query(SQL.reap, [MAX_ATTEMPTS, RETRY_LIFETIME_HOURS, MAX_READ_FAILURES, MAX_SEND_FAILURES]);
  const due = await c.sql.query(SQL.due, [Math.max(1, Math.min(5, limit)), MAX_ATTEMPTS, RETRY_LIFETIME_HOURS, MAX_READ_FAILURES, MAX_SEND_FAILURES]);
  const out = { ok: true, checked: 0, done: 0, pending: 0, dead: 0 };
  for (const r of Array.isArray(due) ? due : []) {
    out.checked++;
    const res = await processSupportEmail(c, String(r.email_id));
    if (res.state === "done") out.done++; else if (/_dead$/.test(res.state)) out.dead++; else out.pending++;
  }
  let st = {};
  try { st = (await c.sql.query(SQL.stats, []))?.[0] || {}; } catch {}
  const pendingNow = Number(st.pending) || 0, oldestNow = Number(st.oldest_min) || 0;
  out.backlog = pendingNow;
  out.oldest_min = oldestNow;
  // Fila vencida (pendente há >= BACKLOG_ALERT_AGE_MINUTES) deixa a execução do cron VERMELHA.
  out.overdue = pendingNow > 0 && oldestNow >= BACKLOG_ALERT_AGE_MINUTES;
  try { out.alerts = await alertOwner(c, st); } catch { out.alerts = "error"; }
  return out;
}

// Chave de leitura recusada pelo Resend (401/403): alerta operacional imediato ao dono (1 a cada 6 h).
async function alertKeyRejected(c, reason) {
  const reserved = await c.sql.query(SQL.alertReserve, ["receiving_key", ALERT_EVERY_HOURS]);
  if (!Array.isArray(reserved) || !reserved.length) return false;
  const r = await resendCall(c.fetchImpl, "/emails", {
    key: c.sendKey, method: "POST",
    body: { from: FROM, to: [c.forwardTo], subject: `${FORWARD_SUBJECT_PREFIX} ALERTA: chave de leitura do Resend recusada`, text: [
      `O Resend recusou a leitura de mensagens recebidas (${reason.replace(/_key_permission$/, "").replace("http_", "HTTP ")}).`,
      "A chave guardada em sandbox-config:resend-receiving-key precisa ser uma API key com permissão Full access da MESMA conta Resend que recebe zevanory.api.br.",
      "",
      "Veja o passo a passo em docs/ops/EMAIL_SUPORTE.md."
    ].join("\n") }
  });
  if (!r.ok) { await c.sql.query(SQL.alertRelease, ["receiving_key"]).catch(() => null); return false; }
  log("owner_alert", { kinds: ["receiving_key"], reason });
  return true;
}

// Alerta ao destino do dono (só contagens, sem conteúdo, assunto, endereço ou id): linhas mortas e fila
// acumulada/antiga. No máximo um por tipo a cada ALERT_EVERY_HOURS (reserva atômica em zevanory_support_alerts).
async function alertOwner(c, stIn) {
  const st = stIn || (await c.sql.query(SQL.stats, []))?.[0] || {};
  const dead = Number(st.dead_new) || 0, pending = Number(st.pending) || 0, oldest = Number(st.oldest_min) || 0;
  const sent = [];
  const send = async (kind, subject, lines) => {
    const reserved = await c.sql.query(SQL.alertReserve, [kind, ALERT_EVERY_HOURS]);
    if (!Array.isArray(reserved) || !reserved.length) return false;
    const r = await resendCall(c.fetchImpl, "/emails", {
      key: c.sendKey, method: "POST",
      body: { from: FROM, to: [c.forwardTo], subject: `${FORWARD_SUBJECT_PREFIX} ${subject}`, text: [...lines, "", "Veja as mensagens no painel Resend > Receiving e o passo a passo em docs/ops/EMAIL_SUPORTE.md."].join("\n") }
    }).catch(() => ({ ok: false }));
    if (!r.ok) { await c.sql.query(SQL.alertRelease, [kind]).catch(() => null); return false; }
    sent.push(kind);
    return true;
  };
  if (dead > 0 && await send("dead", "ALERTA: mensagens de clientes não entregues", [
    `${dead} mensagem(ns) para suporte@/contato@ esgotaram as tentativas (encaminhamento ou confirmação) e não serão mais tentadas.`
  ])) await c.sql.query(SQL.deadAlerted, []);
  if (pending >= BACKLOG_ALERT_COUNT || (pending > 0 && oldest >= BACKLOG_ALERT_AGE_MINUTES)) await send("backlog", "ALERTA: fila de suporte atrasada", [
    `${pending} mensagem(ns) ainda pendente(s); a mais antiga chegou há ${oldest} min.`
  ]);
  if (sent.length) log("owner_alert", { kinds: sent, dead, pending, oldest_min: oldest });
  return sent;
}

// ---------- dreno em invocação própria ----------
// O cron horário divide 50 subrequisições (Workers Free) com várias tarefas; o dreno roda numa invocação
// separada via binding SELF (orçamento próprio), autenticada por HMAC de minuto com LEAD_PRIVACY_SECRET.
async function drainToken(secret, minute) {
  const mac = await hmacSign(new TextEncoder().encode("zevanory-support-drain-v1:" + secret), String(minute));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function handleSupportDrainRequest(request, env, { sqlFactory, fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  const url = new URL(request.url);
  if (url.pathname !== DRAIN_PATH) return null;
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const secret = senderSecret(env);
  const given = String(request.headers.get("x-support-drain-token") || "");
  const minute = Math.floor(nowMs / 60000);
  let okToken = false;
  if (secret && /^[0-9a-f]{64}$/.test(given)) for (let d = -5; d <= 5 && !okToken; d++) okToken = safeEqual(given, await drainToken(secret, minute + d));
  if (!okToken) return json(401, { error: "unauthorized" });
  const out = await drainSupportOutbox(env, { sqlFactory, fetchImpl, nowMs, limit: 3, source: "self" });
  return json(out.ok === false ? 503 : 200, out);
}
export async function dispatchSupportDrain(env, { sqlFactory, fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  const secret = senderSecret(env);
  const self = env?.SELF;
  if (secret && self && typeof self.fetch === "function") {
    try {
      const token = await drainToken(secret, Math.floor(nowMs / 60000));
      const r = await self.fetch(new Request("https://zevanory.api.br" + DRAIN_PATH, { method: "POST", headers: { "x-support-drain-token": token, "x-zevanory-internal": "service-binding" }, signal: AbortSignal.timeout(45000) }));
      let body = null;
      try { body = await r.json(); } catch {}
      log("drain_dispatch", { via: "self", status: r.status });
      return { via: "self", status: r.status, ...(body && typeof body === "object" ? { result: body } : {}) };
    } catch (error) {
      log("drain_dispatch", { via: "self", status: 0, error: errorClass(error) });
    }
  }
  // Sem SELF (ou falhou): dreno na própria invocação do cron.
  return { via: "inline", result: await drainSupportOutbox(env, { sqlFactory, fetchImpl, nowMs, source: "cron_inline" }) };
}
