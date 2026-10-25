import { readFinancialProofSnapshot } from "./commercial-metrics-projection.mjs";
import { brandedEmailHtml } from "./brand-email.mjs";
import { CONTACT_HTML, CONTACT_TEXT_OR, LEGAL_IDENTITY } from "./politica-unica.mjs";
import { FISCAL_PROCESS, fiscalProcessDefined } from "./fiscal-process.mjs";
// Sales switch + customer self-service delivery recovery.
// Deploy note (2026-10-07): first production rollout was rolled back by the CSP smoke (inline footer style on the sales site, fixed in #460).
//
// Sales switch: the owner opens/closes sales from the control panel, which writes the KV key
// `sales:open:v1` (same namespace bound here as ZEVANORY_PRIVATE_ARTIFACTS). The deploy config
// keeps SALE_GLOBALLY_ENABLED=false / MERCADOPAGO_ENV=sandbox as the fail-closed default, so a
// deploy can never open sales by itself and never closes sales the owner opened.
//
// Delivery recovery: a paying customer who lost the email or let the link expire can request a
// fresh single-use link, sent only to the email used in the purchase.

const SALES_KEY = "sales:open:v1";
const PREFLIGHT_KEY = "zpc-sales-preflight:v1";
// Emergency close must take effect in < 60 s: 10 s isolate cache + KV edge cache capped at 30 s.
const CACHE_MS = 10_000;
const KV_EDGE_TTL_S = 30;
let cached = { at: 0, value: null };

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GENERIC_OK = "Se os dados conferirem com uma compra paga, enviamos agora um novo link para o e-mail usado na compra. Confira também a caixa de spam.";
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const html = (status, body) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });

// Owner authorization record (D): the switch only opens with a complete, explicit record.
// {enabled:true, authorization:"LIBERAR VENDAS", by:<owner label>, at:<ISO>, ref:<audit reference>}
// Anything missing, malformed or dated in the future keeps sales closed.
export const OWNER_SALES_AUTHORIZATION = "LIBERAR VENDAS";
export function validOwnerAuthorization(record, now = Date.now()) {
  if (!record || record.enabled !== true) return false;
  if (record.authorization !== OWNER_SALES_AUTHORIZATION) return false;
  const by = String(record.by || "");
  const ref = String(record.ref || "");
  if (!/^[A-Za-z0-9 ._@:-]{3,64}$/.test(by) || !/^[A-Za-z0-9._:/#-]{6,200}$/.test(ref)) return false;
  const at = Date.parse(String(record.at || ""));
  return Number.isFinite(at) && at <= now + 60_000 && /^\d{4}-\d{2}-\d{2}T/.test(String(record.at));
}

export async function readSalesSwitch(env, now = Date.now()) {
  // B04: relógio que volta no tempo (now < cached.at) não pode prender um valor antigo no cache.
  if (now >= cached.at && now - cached.at < CACHE_MS && cached.value) return cached.value;
  let value = { enabled: false, requested: false, revision: "" };
  try {
    const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
    const raw = await kv?.get?.(SALES_KEY, { cacheTtl: KV_EDGE_TTL_S });
    const parsed = raw ? JSON.parse(raw) : null;
    // Revision = write timestamp of the switch record; lets operators measure propagation of a
    // close without ever opening sales. It carries no secret and no customer data.
    const revision = String(parsed?.at || "").slice(0, 40);
    value = { enabled: false, requested: false, revision };
    if (parsed && parsed.enabled === true && !validOwnerAuthorization(parsed, now)) {
      value = { enabled: false, requested: true, blocked: "owner_authorization_incomplete", revision };
    } else if (parsed && parsed.enabled === true) {
      // Fail-closed: the switch only opens sales while the production preflight is green and fresh.
      const pre = JSON.parse(String(await kv.get(PREFLIGHT_KEY) || "null"));
      // B04: preflight datado no futuro (relógio adiantado ou registro corrompido) nunca é fresco;
      // mesma regra do portão de checkout (at <= now && now - at < 3h), usando o `now` injetado.
      const preAt = Date.parse(String(pre?.at || ""));
      const fresh = pre && Number.isFinite(preAt) && preAt <= now && now - preAt < 3 * 3600 * 1000;
      value = pre?.ok === true && fresh
        ? { enabled: true, requested: true, at: String(parsed.at || ""), by: String(parsed.by || ""), authorized: true, revision }
        : { enabled: false, requested: true, blocked: "preflight_not_green", revision };
    }
  } catch {}
  cached = { at: now, value };
  return value;
}

export function resetSalesSwitchCache() { cached = { at: 0, value: null }; }

// The bundle reads process.env (hydrated per request); the switch is applied there via this flag.
export function applySalesSwitch(sw) {
  globalThis.__ZEVANORY_SALES_SWITCH__ = sw?.enabled === true;
  return sw?.enabled === true;
}

const limiter = new Map();
function limited(key, max, windowMs, now = Date.now()) {
  const entry = limiter.get(key);
  if (!entry || now - entry.start > windowMs) { limiter.set(key, { start: now, n: 1 }); return false; }
  entry.n += 1;
  return entry.n > max;
}

const RESEND_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Reenviar link de download · ZEVANORY</title><link rel="icon" href="/brand/export/avatar-400.png">
<style>.zv-brand{display:block;margin:0 0 22px}.zv-brand img{display:block;height:44px;width:auto}.zv-legal{margin-top:24px;padding-top:14px;border-top:1px solid #1c2a44;font-size:12px;color:#7f8ca3;line-height:1.6}.zv-legal a,.zv-help a{color:#7fd3ff}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#05070b;color:#e6edf6;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}main{width:100%;max-width:460px;background:#0b1220;border:1px solid #1c2a44;border-radius:12px;padding:28px}h1{font-size:20px;margin:0 0 12px}p,label{color:#a9b6c9;line-height:1.5}input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2a3a58;background:#0b1220;color:#e6edf6;margin:6px 0 14px;font-size:15px}button{background:#00b8ff;color:#04121f;border:0;border-radius:8px;padding:14px 20px;font-weight:700;font-size:16px;cursor:pointer;width:100%}#out{margin-top:14px}</style></head>
<body><main><a class="zv-brand" href="https://vendas.zevanory.api.br/"><img src="/brand/zevanory-logo-dark.svg" alt="ZEVANORY" width="224" height="51"></a><h1>Receber um novo link de download</h1><p>Informe o código do pedido (está no e-mail de compra) e o e-mail usado no pagamento.</p>
<form id="f"><label>Código do pedido<input name="order_id" required autocomplete="off" placeholder="ex.: 3f2a…"></label><label>E-mail da compra<input name="email" type="email" required autocomplete="email"></label><button type="submit">Enviar novo link</button></form>
<p id="out" role="status"></p><p class="zv-help">Sem o código? Escreva para ${CONTACT_HTML.replace(" · "," ou ")}.</p><p class="zv-legal">${LEGAL_IDENTITY} · <a href="https://vendas.zevanory.api.br/termos">Termos</a> · <a href="https://vendas.zevanory.api.br/privacidade">Privacidade</a> · <a href="https://vendas.zevanory.api.br/reembolso">Reembolso</a></p></main>
<script>document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();var d=new FormData(e.target);var o=document.getElementById('out');o.textContent='Enviando…';try{var r=await fetch('/api/support/resend-delivery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_id:String(d.get('order_id')||'').trim(),email:String(d.get('email')||'').trim()})});var j=await r.json();o.textContent=j.message||'Tente novamente em instantes.';}catch(_){o.textContent='Não foi possível agora. Tente novamente em instantes.';}});</script></body></html>`;

async function resendDelivery(env, { sql, worker, ctx }, { orderId, email }) {
  const rows = await sql.query(
    `select o.order_id, o.offer_id, o.status, sf.status as fulfillment_status, sf.evidence_ref
       from orders o join service_fulfillment sf on sf.order_id = o.order_id
      where o.order_id = $1 limit 1`, [orderId]);
  const order = rows[0];
  if (!order || order.status !== "paid" || order.fulfillment_status !== "delivered") return { sent: false, reason: "not_eligible" };
  let evidence = {};
  try { evidence = JSON.parse(String(order.evidence_ref || "{}")); } catch {}
  const recipient = String(evidence.email_recipient || "").trim().toLowerCase();
  if (!recipient || recipient !== email || evidence.email_destination_kind !== "payer") return { sent: false, reason: "email_mismatch" };
  // At most one fresh link every 10 minutes per order (72h links: issued within the last 10 min).
  const recent = await sql.query(
    `select 1 from artifact_download_tokens where order_id = $1 and issued_by = 'fulfillment-operator'
        and expires_at > now() + interval '4310 minutes' limit 1`, [orderId]);
  if (recent.length) return { sent: false, reason: "recently_sent" };
  const operator = String(env.FULFILLMENT_OPERATOR_TOKEN || "");
  if (!operator || !worker?.fetch) return { sent: false, reason: "issuer_unavailable" };
  const issued = await worker.fetch(new Request("https://zevanory.api.br/private/artifacts/issue", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${operator}` },
    body: JSON.stringify({ order_id: orderId, ttl_minutes: 4320 }),
  }), env, ctx);
  const body = await issued.json().catch(() => ({}));
  if (issued.status !== 201 || !String(body.download_url || "").startsWith("https://")) return { sent: false, reason: "issue_failed" };
  if (!env.RESEND_API_KEY) return { sent: false, reason: "mailer_unavailable" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: String(env.RESEND_FROM_ADDRESS || "ZEVANORY <contato@zevanory.api.br>"),
      to: [recipient],
      reply_to: "suporte@zevanory.api.br",
      subject: "Seu novo link de download ZEVANORY",
      text: `Aqui está seu novo link de download (válido por 72 horas, um download): ${body.download_url}\n\nCódigo do pedido: ${orderId}\nDúvidas: ${CONTACT_TEXT_OR}\nA. RENAN ALVES MOREIRA BITU LTDA - CNPJ 69.077.233/0001-99`,
      html: brandedEmailHtml(`Aqui está seu novo link de download (válido por 72 horas, um download): ${body.download_url}\n\nCódigo do pedido: ${orderId}\nDúvidas: ${CONTACT_TEXT_OR}`),
    }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return { sent: Boolean(r?.ok), reason: r?.ok ? "sent" : "email_failed" };
}

export async function handleSalesControl(request, env, { sqlFactory, worker, ctx, fiscal = FISCAL_PROCESS } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/sales/status") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const sw = await readSalesSwitch(env);
    // Public open means EFFECTIVE commercial release, not merely the owner's
    // KV request. The runtime /api/status remains fail-closed without exact
    // financial proof and the production release gates. This public readback
    // must agree without changing the owner switch or any checkout rule.
    const proof = await readFinancialProofSnapshot(env);
    const released = sw.enabled === true && sw.authorized === true &&
      proof?.verified === true &&
      String(env.ABSOLUTE_RELEASE_APPROVED || "").toLowerCase() === "true" &&
      String(env.PRE_SALE_GATES_APPROVED || "").toLowerCase() === "true" &&
      String(env.MERCADOPAGO_ENV || "").toLowerCase() === "production";
    // P23 (F3): sem processo fiscal definido pelo proprietário com o contador, vendas não abrem (mesma regra do checkout).
    const open = released && fiscalProcessDefined(fiscal);
    return json(200, { open, requested: sw.requested === true,
      blocked: open ? null : (sw.blocked || (sw.enabled ? (released ? "fiscal_process_undefined" : "release_or_financial_proof_pending") : null)),
      revision: sw.revision || null });
  }
  if (path === "/entrega/reenviar") {
    return request.method === "GET" || request.method === "HEAD" ? html(200, RESEND_PAGE) : json(405, { error: "method_not_allowed" });
  }
  if (path !== "/api/support/resend-delivery") return null;
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (limited("resend:" + ip, 5, 3600_000)) return json(429, { message: "Muitas tentativas. Tente novamente em 1 hora ou escreva para suporte@zevanory.api.br." });
  let input = {};
  try { input = await request.json(); } catch {}
  const orderId = String(input.order_id || "").trim().toLowerCase();
  const email = String(input.email || "").trim().toLowerCase();
  if (!UUID.test(orderId) || !EMAIL_RE.test(email) || email.length > 254) return json(400, { message: "Confira o código do pedido e o e-mail." });
  if (!sqlFactory || !env.DATABASE_URL) return json(503, { message: "Indisponível agora. Escreva para suporte@zevanory.api.br." });
  try {
    const out = await resendDelivery(env, { sql: sqlFactory(env.DATABASE_URL), worker, ctx }, { orderId, email });
    if (!out.sent && out.reason !== "not_eligible" && out.reason !== "email_mismatch" && out.reason !== "recently_sent") {
      console.error("resend_delivery_failed", out.reason);
      return json(503, { message: "Não conseguimos enviar agora. Escreva para suporte@zevanory.api.br que enviamos manualmente." });
    }
    return json(200, { message: GENERIC_OK });
  } catch (error) {
    console.error("resend_delivery_error", error instanceof Error ? error.message : String(error));
    return json(503, { message: "Não conseguimos enviar agora. Escreva para suporte@zevanory.api.br que enviamos manualmente." });
  }
}
