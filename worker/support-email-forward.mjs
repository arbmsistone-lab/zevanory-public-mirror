// suporte@ / contato@ — o e-mail oficial do consumidor (CDC + Decreto 7.962/2013) chega ao proprietário.
//
// Caminho: MX do apex -> Resend Receiving -> webhook `email.received` assinado (Svix) em
// POST /api/webhooks/resend -> esta função -> e-mail encaminhado ao endereço configurado pelo dono.
//
// * Assinatura Svix verificada com RESEND_WEBHOOK_SECRET ANTES de qualquer outra coisa; segredo
//   ausente, assinatura errada ou carimbo fora de 5 min => recusa (fail-closed).
// * Só trata `email.received` destinado a suporte@ ou contato@ (`SUPPORT_ALIASES`). Qualquer outro
//   evento (entregas/bounces do envio) ou destinatário (incluindo prova-sandbox@) devolve `null` e o
//   Worker segue para o handler legado, sem mudança de comportamento.
// * Destino NUNCA fixo no código: env SUPPORT_FORWARD_TO ou, sem gastar slot de variável (cota de 64
//   do plano Free), a chave privada KV `support-config:forward-to`. Sem destino => 503 (Resend tenta de novo).
// * Idempotente por email_id do Resend em PostgreSQL (zero escrita em KV; cota diária de 1.000 é
//   compartilhada). Duplicado => 200 sem reencaminhar. Também envia Idempotency-Key ao Resend.
// * Logs sem conteúdo, sem endereço, sem assunto: só contadores/estado.
// * Confirmação automática ao remetente só quando não há risco de laço (auto-resposta, bounce,
//   lista, no-reply, o próprio domínio, o próprio dono) e no máximo 1 por remetente a cada 24 h e
//   ACK_DAILY_CAP por dia no total (limita backscatter de remetente forjado). SUPPORT_AUTO_ACK=false desliga.

import { LEGAL_IDENTITY } from "./politica-unica.mjs";

export const SUPPORT_DOMAIN = "zevanory.api.br";
export const SUPPORT_ALIASES = Object.freeze(["suporte", "contato"]);
export const FORWARD_SUBJECT_PREFIX = "[ZEVANORY suporte]";
export const FORWARD_TO_KV_KEY = "support-config:forward-to";
export const ACK_DAILY_CAP = 30;
const RECEIVING_KEY_KV = "sandbox-config:resend-receiving-key";
const RESEND = "https://api.resend.com";
const FROM = "ZEVANORY suporte <suporte@zevanory.api.br>";
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
async function sha256Hex(value) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Svix (formato usado pelo Resend): HMAC-SHA256(base64(secret sem "whsec_"), `${id}.${ts}.${body}`),
// cabeçalho `svix-signature` = lista "v1,<base64>" separada por espaço.
export async function verifySvixSignature({ payload, id, timestamp, signature, secret, nowMs = Date.now() }) {
  if (!payload || !id || !timestamp || !signature || !String(secret || "").startsWith("whsec_")) return false;
  if (!/^\d{1,12}$/.test(String(timestamp))) return false;
  const ts = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > TOLERANCE_S) return false;
  let keyBytes;
  try { keyBytes = b64ToBytes(String(secret).slice(6)); } catch { return false; }
  if (!keyBytes.length) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${payload}`)));
  const expected = bytesToB64(mac);
  return String(signature).split(" ").some((part) => {
    const [version, value] = part.split(",");
    return version === "v1" && Boolean(value) && safeEqual(value, expected);
  });
}

export function addressOf(raw) {
  const v = raw && typeof raw === "object" ? (raw.email || raw.address || "") : raw;
  const s = String(v || "").trim().toLowerCase();
  const m = /<([^<>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim();
  return EMAIL_RE.test(addr) ? addr : "";
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
  const addr = addressOf(from);
  if (!addr) return "sender_invalid";
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

const cleanSubject = (s) => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "(sem assunto)";

async function forwardTarget(env) {
  let v = String(env.SUPPORT_FORWARD_TO || "").trim().toLowerCase();
  if (!v && env.ZEVANORY_PRIVATE_ARTIFACTS?.get) {
    try { v = String((await env.ZEVANORY_PRIVATE_ARTIFACTS.get(FORWARD_TO_KV_KEY)) || "").trim().toLowerCase(); } catch {}
  }
  if (!EMAIL_RE.test(v)) return "";
  // Encaminhar para o próprio domínio recebido criaria laço (suporte@ -> suporte@).
  if (v.endsWith("@" + SUPPORT_DOMAIN)) return "";
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
  const r = await fetchImpl(RESEND + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, ok: r.ok, data };
}

export async function ensureSupportSchema(sql) {
  if (schemaReady) return;
  await sql.query(`create table if not exists zevanory_support_inbound (
    email_id text primary key, alias text not null, sender_hash text not null,
    status text not null default 'claimed' check (status in ('claimed','forwarded','failed')),
    attempts integer not null default 1, claimed_at timestamptz not null default now(),
    forwarded_at timestamptz, forward_id text, ack_status text, ack_sent_at timestamptz,
    created_at timestamptz not null default now())`, []);
  await sql.query("create index if not exists zevanory_support_inbound_ack_idx on zevanory_support_inbound (sender_hash, ack_sent_at)", []);
  schemaReady = true;
}
export function resetSupportSchemaCache() { schemaReady = false; }

// Reivindica o email_id. Linha nova, ou tentativa anterior que falhou / ficou presa > 5 min => devolve linha.
// Já encaminhado (ou em andamento agora) => nenhuma linha => duplicado.
const CLAIM_SQL = `insert into zevanory_support_inbound (email_id, alias, sender_hash) values ($1, $2, $3)
  on conflict (email_id) do update set status = 'claimed', attempts = zevanory_support_inbound.attempts + 1, claimed_at = now()
  where zevanory_support_inbound.status = 'failed'
     or (zevanory_support_inbound.status = 'claimed' and zevanory_support_inbound.claimed_at < now() - interval '5 minutes')
  returning email_id, attempts`;

function forwardBody(alias, sender, data, detail, attachmentNote) {
  const when = String(detail?.created_at || data?.created_at || "");
  const head = [
    `Mensagem recebida em ${alias}@${SUPPORT_DOMAIN}.`,
    `De: ${sender || "(remetente inválido)"}`,
    `Recebida em: ${when}`,
    `ID Resend: ${String(data.email_id)}`,
    sender ? "Responder a este e-mail responde direto ao cliente (Reply-To)." : "Remetente inválido: não responda por este e-mail.",
    attachmentNote
  ].filter(Boolean);
  const text = head.join("\n") + "\n\n---------- Mensagem original ----------\n" + String(detail?.text || "(sem versão em texto; veja a versão HTML)");
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = detail?.html
    ? `<div style="font:13px/1.5 system-ui,sans-serif;color:#334;border-left:3px solid #2dd4a7;padding:6px 10px;margin:0 0 14px">${head.map(esc).join("<br>")}</div>${String(detail.html)}`
    : undefined;
  return { text, html };
}

function ackText() {
  return [
    "Olá,",
    "",
    `Recebemos sua mensagem enviada para suporte@${SUPPORT_DOMAIN} e ela já está com a nossa equipe. Vamos responder por e-mail.`,
    "",
    "Se a mensagem for sobre uma compra, ajuda muito informar o e-mail usado na compra e o número do pedido ao responder.",
    "",
    "Esta é uma confirmação automática de recebimento.",
    "",
    "ZEVANORY",
    LEGAL_IDENTITY
  ].join("\n");
}

async function maybeAck({ env, sql, fetchImpl, data, sender, senderHash, automated, sendKey }) {
  if (String(env.SUPPORT_AUTO_ACK || "").toLowerCase() === "false") return "disabled";
  if (automated) return "skipped_" + automated;
  const recent = await sql.query("select count(*)::int as n from zevanory_support_inbound where sender_hash = $1 and ack_sent_at > now() - interval '1 day'", [senderHash]);
  if (Number(recent?.[0]?.n) > 0) return "rate_limited_sender";
  const day = await sql.query("select count(*)::int as n from zevanory_support_inbound where ack_sent_at > now() - interval '1 day'", []);
  if (Number(day?.[0]?.n) >= ACK_DAILY_CAP) return "rate_limited_daily";
  const messageId = String(data?.message_id || "").trim();
  const headers = { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" };
  if (/^<[^<>\s]{3,250}>$/.test(messageId)) { headers["In-Reply-To"] = messageId; headers.References = messageId; }
  const sent = await resendCall(fetchImpl, "/emails", {
    key: sendKey, method: "POST", idempotencyKey: `support-ack/${data.email_id}`,
    body: { from: FROM, to: [sender], reply_to: [`suporte@${SUPPORT_DOMAIN}`], subject: "Recebemos sua mensagem — ZEVANORY", text: ackText(), headers }
  }).catch(() => ({ ok: false }));
  if (!sent.ok) return "send_failed";
  await sql.query("update zevanory_support_inbound set ack_status = 'sent', ack_sent_at = now() where email_id = $1", [String(data.email_id)]);
  return "sent";
}

// Devolve Response quando trata a requisição; `null` quando ela não é deste fluxo (o Worker segue normal).
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
  if (!ID_RE.test(String(data.email_id || ""))) return json(400, { error: "email_id_invalid", accepted: false });

  const forwardTo = await forwardTarget(env);
  const sendKey = String(env.RESEND_API_KEY || "");
  if (!forwardTo || !sendKey) {
    log("forward_unconfigured", { alias, forward_to: Boolean(forwardTo), send_key: Boolean(sendKey) });
    return json(503, { error: "support_forward_unconfigured", accepted: false });
  }
  if (!sqlFactory || !env.DATABASE_URL) {
    log("dedupe_unavailable", { alias });
    return json(503, { error: "support_dedupe_unavailable", accepted: false });
  }
  const sender = addressOf(data.from);
  const senderHash = (await sha256Hex("support-sender:" + (sender || "invalid"))).slice(0, 32);
  let sql, claim;
  try {
    sql = sqlFactory(env.DATABASE_URL);
    await ensureSupportSchema(sql);
    claim = await sql.query(CLAIM_SQL, [String(data.email_id), alias, senderHash]);
  } catch {
    log("dedupe_unavailable", { alias });
    return json(503, { error: "support_dedupe_unavailable", accepted: false });
  }
  if (!Array.isArray(claim) || !claim.length) {
    log("duplicate", { alias });
    return json(200, { accepted: true, duplicate: true, forwarded: false, alias });
  }
  const markFailed = async () => { try { await sql.query("update zevanory_support_inbound set status = 'failed' where email_id = $1 and status = 'claimed'", [String(data.email_id)]); } catch {} };

  try {
    // Conteúdo completo: webhook traz só metadados; a chave de envio não lê recebidos (precisa de chave full access).
    const rKey = await receivingKey(env);
    let detail = null;
    if (rKey) {
      const got = await resendCall(fetchImpl, `/emails/receiving/${encodeURIComponent(String(data.email_id))}`, { key: rKey }).catch(() => ({ ok: false }));
      if (got.ok && got.data && typeof got.data === "object") detail = got.data;
    }
    if (!detail) {
      await markFailed();
      log("content_unavailable", { alias, receiving_key: Boolean(rKey) });
      return json(503, { error: "support_content_unavailable", accepted: false });
    }
    let attachments = [];
    let attachmentNote = "";
    const meta = Array.isArray(data.attachments) ? data.attachments : Array.isArray(detail.attachments) ? detail.attachments : [];
    if (meta.length) {
      const listed = await resendCall(fetchImpl, `/emails/receiving/${encodeURIComponent(String(data.email_id))}/attachments`, { key: rKey }).catch(() => ({ ok: false }));
      const rows = listed.ok && Array.isArray(listed.data?.data) ? listed.data.data : [];
      attachments = rows.filter((a) => /^https:\/\//.test(String(a?.download_url || "")) && a?.filename).slice(0, 10)
        .map((a) => ({ path: String(a.download_url), filename: String(a.filename).replace(/[\r\n"\\/]+/g, "_").slice(0, 120) }));
      if (attachments.length < meta.length) attachmentNote = `Atenção: ${meta.length - attachments.length} anexo(s) não puderam ser copiados; veja no painel Resend > Receiving.`;
    }
    const { text, html } = forwardBody(alias, sender, data, detail, attachmentNote);
    const subject = `${FORWARD_SUBJECT_PREFIX} ${cleanSubject(detail.subject ?? data.subject)}`;
    const body = { from: FROM, to: [forwardTo], subject, text, ...(html ? { html } : {}), ...(sender ? { reply_to: [sender] } : {}), ...(attachments.length ? { attachments } : {}) };
    const sent = await resendCall(fetchImpl, "/emails", { key: sendKey, method: "POST", body, idempotencyKey: `support-fwd/${data.email_id}` }).catch(() => ({ ok: false }));
    const forwardId = String(sent?.data?.id || "");
    if (!sent.ok || !forwardId) {
      await markFailed();
      log("forward_failed", { alias, status: Number(sent?.status) || 0 });
      return json(503, { error: "support_forward_failed", accepted: false });
    }
    await sql.query("update zevanory_support_inbound set status = 'forwarded', forwarded_at = now(), forward_id = $2 where email_id = $1", [String(data.email_id), forwardId.slice(0, 128)]);
    const automated = isAutomated({ from: data.from, subject: detail.subject ?? data.subject, headers: detail.headers, forwardTo });
    let ack = "not_attempted";
    try { ack = await maybeAck({ env, sql, fetchImpl, data, sender, senderHash, automated, sendKey }); } catch { ack = "error"; }
    log("forwarded", { alias, attachments: attachments.length, ack });
    return json(200, { accepted: true, forwarded: true, duplicate: false, alias, ack });
  } catch {
    await markFailed();
    log("forward_failed", { alias, status: 0 });
    return json(503, { error: "support_forward_failed", accepted: false });
  }
}
