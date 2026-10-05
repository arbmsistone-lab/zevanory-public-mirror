// Sandbox proof contract v2 (Mercado Pago test users only).
// Fail-closed: every route requires CERTIFICATION_PILOT_ENV=sandbox,
// MERCADOPAGO_ENV=sandbox and SALE_GLOBALLY_ENABLED!=true. Orders created here
// are certification_pilot=true, excluded from revenue and never delivered to a
// real customer: the delivery mail goes only to the isolated inbox subdomain.

export const SANDBOX_INBOX_DOMAIN = "zevanory.api.br";
// Apex MX is Resend Receiving (inbound-smtp.sa-east-1.amazonaws.com); any address
// on the domain is received. Only this exact address is readable by the proof.
export const SANDBOX_INBOX_ADDRESS = "prova-sandbox@zevanory.api.br";
const RESEND = "https://api.resend.com";
export const SANDBOX_OFFER_ID = "ZEV-CMB-011";
export const SANDBOX_AMOUNT_BRL = 297;
export const FROZEN_ORDER = "a28c53ab-9ce7-429d-9d6b-1311a3fad406";
// sha256 of the high-entropy read-only inbox token kept in the GitHub
// environment "sandbox-financial-approved". Publishing the digest is safe.
export const SANDBOX_INBOX_TOKEN_SHA256 = "18fd2cf5a941661ef9e507e6e020a8e06c3566aff5543468a0977aea0b47fdd0";
const CERT = "/api/internal/certification/e2e/";
const INBOX = "/api/internal/certification/inbox/";
const ORDER_KEY = (oid) => `sandbox-proof-v2:order:${oid}`;
const MAIL_PREFIX = (oid) => `sandbox-inbox:${oid}:`;
const DAILY_KEY = (day) => `sandbox-proof-v2:daily:${day}`;
const MAX_ORDERS_PER_DAY = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
});

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualText(a, b) {
  const x = String(a), y = String(b);
  if (!x || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function sandboxFailClosed(env) {
  return String(env.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox" &&
    String(env.MERCADOPAGO_ENV || "").toLowerCase() === "sandbox" &&
    String(env.SALE_GLOBALLY_ENABLED || "").toLowerCase() !== "true";
}

function isolation(record) {
  return {
    sale_globally_enabled: false,
    sales_mode: "globally-blocked",
    sandbox: true,
    excluded_from_revenue: true,
    real_customer_delivery: false,
    commercial_unlock: false,
    buyer_id: record.buyer_id,
    buyer_email: record.buyer_email,
    email_recipient: record.email_recipient,
    order_id: record.order_id
  };
}

export function validCheckoutInput(body) {
  if (!body || typeof body !== "object") return null;
  const requestId = String(body.request_id || "").toLowerCase();
  const buyerId = String(body.buyer_id || "");
  const buyerEmail = String(body.buyer_email || "").toLowerCase();
  const recipient = String(body.email_recipient || "").toLowerCase();
  if (!UUID.test(requestId)) return null;
  if (body.offer_id !== SANDBOX_OFFER_ID || body.sandbox !== true) return null;
  if (!/^[0-9]{1,20}$/.test(buyerId)) return null;
  if (!/^[^@\s]+@testuser\.com$/.test(buyerEmail) || buyerEmail === "test@testuser.com") return null;
  if (recipient !== SANDBOX_INBOX_ADDRESS) return null;
  return { requestId, buyerId, buyerEmail, recipient };
}

async function readJson(request, max = 4096) {
  const text = await request.text();
  if (text.length > max) return null;
  try { return JSON.parse(text || "{}"); } catch { return null; }
}

async function workerStatus(worker, request, env, ctx, oid) {
  const url = new URL(`${CERT}status`, request.url);
  url.searchParams.set("order_id", oid);
  const response = await worker.fetch(new Request(url, {
    method: "GET",
    headers: { "x-certification-e2e-token": String(request.headers.get("x-certification-e2e-token") || "") }
  }), env, ctx);
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

export function projectStatus(record, base) {
  const provenance = Array.isArray(base?.provenance) ? base.provenance : [];
  // The receiver records provider_webhook provenance only after
  // verifyMercadoPagoSignature() accepted the x-signature of the sandbox secret.
  const receiverVerified = provenance.some((p) => p?.source_class === "provider_webhook" &&
    p?.source === "mercadopago-test" && p?.dimension === "payment");
  const events = (Array.isArray(base?.financial_events) ? base.financial_events : []).map((e) => ({
    normalized_event: e.normalized_event,
    provider_payment_id: String(e.provider_payment_id || ""),
    order_id: record.order_id,
    source_class: String(e.provider_event_id || "").startsWith("mp-test:") ? "provider_webhook" : "unknown",
    signature_verified: receiverVerified && String(e.provider_event_id || "").startsWith("mp-test:"),
    signature_secret_class: "sandbox",
    signature_verified_by: "receiver"
  }));
  const d = base?.delivery_evidence || {};
  return {
    ...isolation(record),
    order: { status: String(base?.order?.status || "") },
    fulfillment: { status: String(base?.fulfillment?.status || "") },
    financial_events: events,
    delivery_evidence: {
      email_status: d.email_status || null,
      email_recipient: d.email_recipient || null,
      verification_url: d.certification_verification_url || null,
      expires_at: d.expires_at || null,
      artifact_sha256: String(d.artifact_sha256 || "").toLowerCase() || null
    }
  };
}

function decodeQuotedPrintable(text) {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeBase64(text) {
  try {
    const bin = atob(text.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ""; }
}

function splitHeaders(block) {
  const headers = {};
  block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return headers;
}

export function mimeText(raw) {
  const sep = raw.search(/\r?\n\r?\n/);
  if (sep < 0) return { headers: splitHeaders(raw), text: "" };
  const headers = splitHeaders(raw.slice(0, sep));
  const body = raw.slice(sep).replace(/^\r?\n\r?\n/, "");
  const type = headers["content-type"] || "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    const parts = body.split("--" + boundary).slice(1).filter((p) => !p.startsWith("--"));
    return { headers, text: parts.map((p) => mimeText(p.replace(/^\r?\n/, "")).text).join("\n") };
  }
  const cte = String(headers["content-transfer-encoding"] || "").toLowerCase();
  const text = cte === "quoted-printable" ? decodeQuotedPrintable(body) : cte === "base64" ? decodeBase64(body) : body;
  return { headers, text };
}

async function resendGet(env, path) {
  // Dedicated full-access key used only for GET /emails/receiving; the
  // production sending key (RESEND_API_KEY) cannot read received mail.
  const key = String(env.RESEND_RECEIVING_API_KEY || "");
  if (!key) return { status: 503, body: null };
  const r = await fetch(RESEND + path, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

function htmlText(html) {
  return String(html || "").replace(/<a\s[^>]*href="([^"]+)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
}

export function receivedMatches(detail, oid) {
  const headers = Object.fromEntries(Object.entries(detail?.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const to = (Array.isArray(detail?.to) ? detail.to : [detail?.to]).map((x) => String(x || "").toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1"));
  if (!to.includes(SANDBOX_INBOX_ADDRESS)) return null;
  if (String(headers["x-zevanory-order-id"] || "").toLowerCase() !== oid) return null;
  return {
    id: String(detail.id || "").replace(/[^a-zA-Z0-9_-]/g, ""),
    to: [SANDBOX_INBOX_ADDRESS],
    received_at_ms: Date.parse(detail.created_at || "") || 0,
    x_zevanory_order_id: oid,
    delivered_via: "resend-inbound",
    text: String(detail.text || "") + "\n" + htmlText(detail.html)
  };
}

export async function handleSandboxInboundEmail(message, env) {
  const to = String(message?.to || "").toLowerCase();
  if (to !== SANDBOX_INBOX_ADDRESS) return false;
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv || to !== SANDBOX_INBOX_ADDRESS || Number(message.rawSize || 0) > 1024 * 1024) {
    message.setReject?.("sandbox_inbox_rejected");
    return true;
  }
  const raw = await new Response(message.raw).text();
  const { headers, text } = mimeText(raw);
  const oid = String(headers["x-zevanory-order-id"] || "").toLowerCase();
  if (!UUID.test(oid) || oid === FROZEN_ORDER) {
    message.setReject?.("sandbox_inbox_order_required");
    return true;
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  await kv.put(MAIL_PREFIX(oid) + id, JSON.stringify({
    id,
    to: [to],
    received_at_ms: Date.now(),
    x_zevanory_order_id: oid,
    delivered_via: "cloudflare-email-routing",
    from: String(message.from || "").toLowerCase(),
    text: text.slice(0, 20000)
  }), { expirationTtl: 2 * 24 * 3600 });
  return true;
}

export async function handleSandboxProofV2(request, env, ctx, worker, sqlFactory) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(CERT) && !path.startsWith(INBOX)) return null;
  const isInbox = path.startsWith(INBOX);
  const v2Paths = new Set([`${CERT}checkout`, `${CERT}download`, `${CERT}status`, `${INBOX}profile`, `${INBOX}messages`]);
  if (!v2Paths.has(path)) return null;
  if (!sandboxFailClosed(env)) return json(409, { error: "certification_e2e_not_fail_closed" });
  if (isInbox) {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const provided = String(request.headers.get("x-sandbox-inbox-token") || "");
    if (provided.length < 32 || !timingSafeEqualText(await sha256Hex(provided), SANDBOX_INBOX_TOKEN_SHA256)) return json(401, { error: "sandbox_inbox_auth_required" });
    if (path === `${INBOX}profile`) {
      const probe = await resendGet(env, "/emails/receiving?limit=1");
      return json(200, { email_address: SANDBOX_INBOX_ADDRESS, read_only: true, provider: "resend-inbound", receiving_api_status: probe.status });
    }
    const oid = String(url.searchParams.get("order_id") || "").toLowerCase();
    if (!UUID.test(oid) || oid === FROZEN_ORDER) return json(400, { error: "order_id_invalid" });
    const listed = await resendGet(env, "/emails/receiving?limit=50");
    if (listed.status !== 200) return json(503, { error: "sandbox_inbox_unavailable", receiving_api_status: listed.status });
    const rows = (Array.isArray(listed.body?.data) ? listed.body.data : []).filter((m) =>
      (Array.isArray(m?.to) ? m.to : [m?.to]).some((x) => String(x || "").toLowerCase().includes(SANDBOX_INBOX_ADDRESS)) &&
      Date.now() - (Date.parse(m?.created_at || "") || 0) < 24 * 3600 * 1000).slice(0, 10);
    const messages = [];
    for (const row of rows) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(row.id || ""))) continue;
      const detail = await resendGet(env, `/emails/receiving/${row.id}`);
      const match = detail.status === 200 ? receivedMatches(detail.body, oid) : null;
      if (match) messages.push(match);
    }
    return json(200, { messages });
  }
  const expected = String(env.CERTIFICATION_E2E_TOKEN || "");
  const provided = String(request.headers.get("x-certification-e2e-token") || "");
  if (expected.length < 32 || !timingSafeEqualText(expected, provided)) return json(401, { error: "certification_e2e_auth_required" });
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv) return json(503, { error: "sandbox_state_unavailable" });

  if (path === `${CERT}status`) {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const oid = String(url.searchParams.get("order_id") || "").toLowerCase();
    if (!url.searchParams.has("order_id")) {
      return json(200, {
        sale_globally_enabled: false,
        sales_mode: "globally-blocked",
        sandbox_proof_contract: "v2",
        sandbox_checkout_isolated: true,
        receiver_test_signature_evidence: true,
        certification_download_isolated: true,
        inbox_domain: SANDBOX_INBOX_DOMAIN
      });
    }
    if (!UUID.test(oid) || oid === FROZEN_ORDER) return json(400, { error: "order_id_invalid" });
    const record = JSON.parse(await kv.get(ORDER_KEY(oid)) || "null");
    if (!record) return null; // legacy (v1) orders keep the original handler
    const base = await workerStatus(worker, request, env, ctx, oid);
    if (!base) return json(503, { error: "certification_e2e_status_unavailable" });
    return json(200, projectStatus(record, base));
  }

  if (path === `${CERT}download`) {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const token = String(url.searchParams.get("token") || "");
    if (token.length < 32 || token.length > 128) return json(404, { error: "download_unavailable" });
    const target = new URL("/private/artifacts/download", request.url);
    target.searchParams.set("token", token);
    return worker.fetch(new Request(target, { method: "GET" }), env, ctx);
  }

  // POST checkout
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const input = validCheckoutInput(await readJson(request));
  if (!input) return json(400, { error: "invalid_sandbox_checkout_request" });
  if (!env.DATABASE_URL) return json(503, { error: "canonical_database_unavailable" });
  const day = new Date().toISOString().slice(0, 10);
  const used = Number(await kv.get(DAILY_KEY(day)) || 0);
  if (used >= MAX_ORDERS_PER_DAY) return json(429, { error: "sandbox_daily_limit" });
  const oid = crypto.randomUUID();
  const sql = sqlFactory(env.DATABASE_URL);
  let inserted;
  try {
    inserted = await sql.query(`INSERT INTO orders
      (order_id,request_id,session_id,experiment_id,offer_id,amount,currency,provider,external_reference,status,certification_pilot)
      VALUES ($1,$2,$3,'EXP-0001',$4,$5,'BRL','mercadopago',$1,'checkout_ready',true)
      ON CONFLICT (request_id) DO NOTHING RETURNING order_id`,
      [oid, input.requestId, `sandbox-proof-v2:${input.requestId}`, SANDBOX_OFFER_ID, SANDBOX_AMOUNT_BRL]);
  } catch {
    return json(503, { error: "sandbox_order_persist_failed" });
  }
  if (!Array.isArray(inserted) || inserted.length !== 1) return json(409, { error: "request_id_already_used", created_new: false, accepted: false });
  const record = { order_id: oid, buyer_id: input.buyerId, buyer_email: input.buyerEmail, email_recipient: input.recipient, created_at: new Date().toISOString() };
  await kv.put(ORDER_KEY(oid), JSON.stringify(record), { expirationTtl: 30 * 24 * 3600 });
  await kv.put(DAILY_KEY(day), String(used + 1), { expirationTtl: 2 * 24 * 3600 });
  return json(201, { ...isolation(record), accepted: true, created_new: true, amount_brl: SANDBOX_AMOUNT_BRL, external_reference: oid });
}
