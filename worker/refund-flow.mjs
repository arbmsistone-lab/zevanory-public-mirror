import { isAmbiguousRefund, hasRefundClaim, getRefundClaim, acquireRefundClaim, revokeRefundDownloads, saveRefund, markRefundApproved, reconcileRefund } from "./refund-provider-claims.mjs";
export { reconcileRefund } from "./refund-provider-claims.mjs";
// T5 — Refund flow (CDC art. 49: up to 7 days after payment).
// Customer requests -> owner approves in /admin/refunds (admin basic auth) -> Mercado Pago refund API
// -> provider webhook/reconciliation marks the order refunded. Download tokens are revoked on approval.
// No customer PII is stored: the email is only compared against the payer email at Mercado Pago.

const MP = "https://api.mercadopago.com";
const ORIGIN = "https://zevanory.api.br";
const WINDOW_MS = 7 * 24 * 3600 * 1000;
const KEY = (oid) => `refund:req:${oid}`;


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const html = (status, body, extra = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", ...extra } });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GENERIC_NOT_FOUND = "Não encontramos um pedido elegível com esses dados. Confira o código do pedido (está no e-mail de entrega) e o e-mail usado no pagamento, ou escreva para suporte@zevanory.api.br.";

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function tokenFor(env, test) {
  return String((test ? env.MERCADOPAGO_TEST_ACCESS_TOKEN : env.MERCADOPAGO_ACCESS_TOKEN) || "").trim();
}

async function loadOrder(sql, oid) {
  const rows = await sql.query(
    `select o.order_id, o.status, o.amount, o.offer_id, o.certification_pilot,
            fe.provider_payment_id as payment_id, fe.received_at as paid_at
       from orders o
       left join lateral (select provider_payment_id, received_at from financial_events f
                           where f.order_id=o.order_id and f.normalized_event='payment_confirmed'
                           order by received_at asc limit 1) fe on true
      where o.order_id=$1 limit 1`, [oid]);
  return rows[0] || null;
}

async function mpPayment(env, paymentId, test) {
  const token = tokenFor(env, test);
  if (!token) throw new Error("mercadopago_token_missing");
  const r = await fetch(`${MP}/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(test ? { "x-test-token": "true" } : {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`mercadopago_lookup_${r.status}`);
  return r.json();
}

async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !to) return { sent: false };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "ZEVANORY <suporte@zevanory.api.br>", to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return { sent: Boolean(r?.ok) };
}

function maskEmail(email) {
  const [u, d] = String(email).split("@");
  return (u || "").slice(0, 2) + "***@" + (d || "");
}

async function rateLimited(kv, request) {
  // Best-effort: a storage hiccup (e.g. KV quota) must never block a legal refund request.
  try {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const hour = new Date().toISOString().slice(0, 13);
    const key = `refund:rate:${hour}:${ip}`;
    const n = Number(await kv.get(key) || 0);
    if (n >= 6) return true;
    await kv.put(key, String(n + 1), { expirationTtl: 3600 });
  } catch {}
  return false;
}



// Customer request. Returns the same generic message for every non-eligible combination.
async function createRequest(env, sql, kv, { oid, email }) {
  oid = String(oid || "").trim().toLowerCase();
  email = String(email || "").trim().toLowerCase();
  if (!UUID.test(oid) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) return { status: 400, body: { error: "dados_invalidos", message: GENERIC_NOT_FOUND } };
  const existing = JSON.parse(await kv.get(KEY(oid)) || "null");
  if (existing && (existing.status !== "rejected" || isAmbiguousRefund(existing))) return { status: 200, body: { received: true, status: existing.status, message: "Seu pedido de reembolso já está registrado e será processado em breve." } };
  if (existing?.status === "rejected" && await hasRefundClaim(sql, oid)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  const order = await loadOrder(sql, oid);
  if (!order || order.status !== "paid" || !order.payment_id || !order.paid_at) return { status: 404, body: { error: "nao_elegivel", message: GENERIC_NOT_FOUND, reason: !order ? "order_not_found" : order.status !== "paid" ? "order_status_" + order.status : "payment_missing" } };
  const test = order.certification_pilot === true || Boolean(await kv.get(`sandbox-proof-v2:order:${oid}`));
  if (Date.now() - new Date(order.paid_at).getTime() > WINDOW_MS) {
    return { status: 409, body: { error: "fora_do_prazo", message: "O prazo de 7 dias para arrependimento deste pedido terminou. Se houver algum problema com o material, escreva para suporte@zevanory.api.br." } };
  }
  // The customer identifies with the email where the product was delivered (= Mercado Pago payer in production).
  const candidates = [];
  try {
    const f = (await sql.query("select evidence_ref from service_fulfillment where order_id=$1 limit 1", [oid]))[0];
    const ev = f?.evidence_ref && String(f.evidence_ref).trim().startsWith("{") ? JSON.parse(f.evidence_ref) : {};
    if (ev.email_recipient) candidates.push(String(ev.email_recipient).trim().toLowerCase());
  } catch {}
  try {
    const payment = await mpPayment(env, order.payment_id, test);
    if (payment?.payer?.email) candidates.push(String(payment.payer.email).trim().toLowerCase());
  } catch {}
  if (!candidates.some((c) => c && timingSafeEqual(c, email))) return { status: 404, body: { error: "nao_elegivel", message: GENERIC_NOT_FOUND, reason: candidates.length ? "email_mismatch" : "email_unverifiable" } };
  const record = {
    status: "pending",
    order_id: oid,
    payment_id: String(order.payment_id),
    amount: Number(order.amount),
    offer_id: String(order.offer_id || ""),
    test,
    email_masked: maskEmail(email),
    paid_at: new Date(order.paid_at).toISOString(),
    requested_at: new Date().toISOString(),
  };
  await kv.put(KEY(oid), JSON.stringify(record), { expirationTtl: 90 * 24 * 3600 });
  if (!test) {
    const alert = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"), "ZEVANORY — novo pedido de reembolso para aprovar", `Pedido ${oid} (${record.offer_id}, R$ ${record.amount}) solicitou reembolso dentro do prazo de 7 dias.\n\nAprovar: ${ORIGIN}/admin/refunds`);
    if (!alert.sent) {
      // Keep a retry marker; the hourly refund watchdog re-alerts the owner.
      try { await kv.put(`refund:alert-pending:${oid}`, new Date().toISOString(), { expirationTtl: 14 * 24 * 3600 }); } catch {}
    }
  }
  if (!test) await sendEmail(env, email, "ZEVANORY — recebemos seu pedido de reembolso", `Recebemos o pedido de reembolso do pedido ${oid}. O valor volta pelo mesmo meio de pagamento assim que o processamento for concluído. Você receberá a confirmação por e-mail.\n\nEquipe ZEVANORY · suporte@zevanory.api.br`);
  return { status: 200, body: { received: true, status: "pending", message: "Pedido de reembolso registrado. Você receberá a confirmação por e-mail." } };
}

async function executeRefund(env, sql, kv, oid, { actor }) {
  const record = JSON.parse(await kv.get(KEY(oid)) || "null");
  if (!record) return { status: 404, body: { error: "refund_request_not_found" } };
  if (record.status === "refunded" || record.status === "approved") {
    if (record.download_revocation_pending === true) {
      try {
        await revokeRefundDownloads(sql, record);
        record.download_revocation_pending = false;
        await saveRefund(kv, record);
      } catch { return { status: 503, body: { error: "refund_download_revocation_pending" } }; }
    }
    return { status: 200, body: { ok: true, status: record.status, refund_id: record.refund_id, duplicate: true } };
  }
  if (record.status !== "pending") return { status: 409, body: { error: "refund_request_not_pending" } };
  if (isAmbiguousRefund(record)) {
    try {
      const claim = await getRefundClaim(sql, oid);
      if (claim?.stage !== "reconciled_not_refunded" || claim.reconciled_status !== "not_refunded") {
        return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
      }
    } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  }
  const token = tokenFor(env, record.test);
  if (!token) return { status: 503, body: { error: "mercadopago_token_missing" } };
  // Every financial POST is preceded by a single durable claim or one CAS-controlled retry.
  try {
    if (!await acquireRefundClaim(sql, record)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  let r;
  try {
    r = await fetch(MP + "/v1/payments/" + encodeURIComponent(record.payment_id) + "/refunds", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json",
        "x-idempotency-key": "zevanory-refund-" + oid, ...(record.test ? { "x-test-token": "true" } : {}) },
      body: "{}", signal: AbortSignal.timeout(20000) });
  } catch {
    record.provider_outcome_unknown = true;
    record.last_error = "mercadopago_refund_outcome_unknown";
    try { await saveRefund(kv, record); } catch {}
    return { status: 502, body: { error: record.last_error } };
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body?.id || body.status !== "approved" ||
      (body.amount != null && (!Number.isFinite(Number(body.amount)) || Math.abs(Number(body.amount) - Number(record.amount)) > 0.005))) {
    record.provider_outcome_unknown = true;
    record.last_error = "mercadopago_refund_" + r.status + "_" +
      String(body?.message || body?.error || body?.status || "unconfirmed").slice(0, 120);
    try { await saveRefund(kv, record); } catch {}
    return { status: 502, body: { error: record.last_error } };
  }
  const outcome = await markRefundApproved(sql, kv, record, body.id, actor).catch(() =>
    ({ status: 503, body: { error: "refund_persistence_unavailable_reconciliation_required" } }));
  if (outcome.status === 200) {
    try {
      const payment = await mpPayment(env, record.payment_id, record.test);
      const to = String(payment?.payer?.email || "").trim().toLowerCase();
      if (to && !record.test) await sendEmail(env, to, "ZEVANORY — reembolso aprovado",
        "O reembolso do pedido " + oid + " foi aprovado e enviado ao Mercado Pago.");
    } catch {}
  }
  return outcome;
}

async function rejectRequest(kv, sql, oid, actor) {
  const record = JSON.parse(await kv.get(KEY(oid)) || "null");
  if (!record || record.status !== "pending") return { status: 409, body: { error: "refund_request_not_pending" } };
  if (isAmbiguousRefund(record)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  try {
    if (await hasRefundClaim(sql, oid)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  Object.assign(record, { status: "rejected", rejected_at: new Date().toISOString(), rejected_by: actor });
  await saveRefund(kv, record);
  return { status: 200, body: { ok: true, status: "rejected" } };
}

async function listRequests(kv, sql) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "refund:req:", cursor });
    for (const k of page.keys || []) {
      const v = JSON.parse(await kv.get(k.name) || "null");
      if (v && !v.test) {
        try { const claim = await getRefundClaim(sql, v.order_id); v.claim_present = Boolean(claim); v.retry_permitted = claim?.stage === "reconciled_not_refunded" && claim?.reconciled_status === "not_refunded"; }
        catch { v.claim_present = true; v.retry_permitted = false; }
        out.push(v);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
}

const FORM_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solicitar reembolso · ZEVANORY</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#050a1e;color:#e7ecf7}main{max-width:520px;margin:0 auto;padding:40px 20px}h1{font-size:26px}p{color:#b9c4dc;line-height:1.5}label{display:block;margin:18px 0 6px;font-weight:600}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #33416a;background:#0b1535;color:#fff;font-size:16px}button{margin-top:22px;width:100%;padding:14px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-weight:700;font-size:16px}#msg{margin-top:18px;padding:12px;border-radius:10px;background:#0b1535;display:none}</style></head>
<body><main><h1>Solicitar reembolso</h1><p>Você tem até 7 dias após o pagamento para desistir da compra e receber o valor integral de volta pelo mesmo meio de pagamento (art. 49 do CDC).</p>
<form id="f"><label for="o">Código do pedido</label><input id="o" name="order_id" required placeholder="está no e-mail de entrega" autocomplete="off">
<label for="e">E-mail usado no pagamento</label><input id="e" name="email" type="email" required autocomplete="email"><button type="submit">Enviar pedido de reembolso</button></form><div id="msg" role="status"></div>
<p style="margin-top:28px;font-size:14px">Dúvidas: suporte@zevanory.api.br</p></main>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const m=document.getElementById('msg');m.style.display='block';m.textContent='Enviando…';try{const r=await fetch('/api/support/refund-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_id:document.getElementById('o').value,email:document.getElementById('e').value})});const j=await r.json();m.textContent=j.message||'Não foi possível registrar agora. Tente novamente.';}catch{m.textContent='Não foi possível registrar agora. Tente novamente.';}});</script></body></html>`;

function adminPage(items) {
  const rows = items.map((r) => `<tr><td>${esc(r.requested_at.slice(0, 16).replace("T", " "))}</td><td><code>${esc(r.order_id)}</code><br><small>${esc(r.offer_id)} · ${esc(r.email_masked)}</small></td><td>R$ ${esc(r.amount)}</td><td>${esc(r.status)}${r.last_error ? `<br><small>${esc(r.last_error)}</small>` : ""}</td><td>${r.status === "pending" && r.retry_permitted ? `<form method="post" action="/admin/refunds/action"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Repetir após conciliação (uma vez)</button></form>` : r.status === "pending" && !r.claim_present && !isAmbiguousRefund(r) ? `<form method="post" action="/admin/refunds/action" style="display:inline"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Aprovar reembolso</button> <button name="action" value="reject" class="no">Recusar</button></form>` : (isAmbiguousRefund(r) || r.claim_present) ? "Verificar conciliação no Mercado Pago antes de nova tentativa" : r.download_revocation_pending === true ? "Revogação de downloads pendente; verificar recuperação" : esc(r.refund_id || "")}</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reembolsos · ZEVANORY</title><style>body{font-family:system-ui,sans-serif;background:#050a1e;color:#e7ecf7;margin:0;padding:24px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #22305a;text-align:left;vertical-align:top}button{padding:10px 14px;border:0;border-radius:8px;background:#22c55e;color:#04210f;font-weight:700}button.no{background:#334155;color:#fff}code{font-size:12px}</style></head><body><h1>Pedidos de reembolso</h1><p>Aprovar envia o reembolso integral ao Mercado Pago e bloqueia novos downloads do pedido.</p><table><tr><th>Quando</th><th>Pedido</th><th>Valor</th><th>Status</th><th>Ação</th></tr>${rows || '<tr><td colspan="5">Nenhum pedido.</td></tr>'}</table></body></html>`;
}

export async function handleRefundFlow(request, env, { sqlFactory, isAdminAuthorized, worker, ctx } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isOurs = path === "/reembolso/solicitar" || path === "/pedir-reembolso" || path === "/api/support/refund-request" || path === "/admin/refunds" || path === "/admin/refunds/action" || path === "/api/internal/certification/e2e/refund-approve" || path === "/api/internal/certification/e2e/refund-reconcile";
  if (!isOurs) return null;
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv) return json(503, { error: "refund_state_unavailable" });
  const sql = () => sqlFactory(env.DATABASE_URL);

  if (path === "/reembolso/solicitar" || path === "/pedir-reembolso") return request.method === "GET" || request.method === "HEAD" ? html(200, FORM_PAGE) : json(405, { error: "method_not_allowed" });

  if (path === "/api/support/refund-request") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (await rateLimited(kv, request)) return json(429, { error: "muitas_tentativas", message: "Muitas tentativas. Tente novamente em 1 hora ou escreva para suporte@zevanory.api.br." });
    let input = {};
    try { input = await request.json(); } catch {}
    try {
      const out = await createRequest(env, sql(), kv, { oid: input.order_id, email: input.email });
      const cert = String(env.CERTIFICATION_E2E_TOKEN || "");
      const diagnostic = cert.length >= 32 && timingSafeEqual(cert, request.headers.get("x-certification-e2e-token") || "");
      if (!diagnostic && out.body?.reason) delete out.body.reason;
      return json(out.status, out.body);
    } catch {
      return json(503, { error: "indisponivel", message: "Não foi possível registrar agora. Tente novamente em instantes ou escreva para suporte@zevanory.api.br." });
    }
  }

  if (path === "/api/internal/certification/e2e/refund-approve" || path === "/api/internal/certification/e2e/refund-reconcile") {
    const expected = String(env.CERTIFICATION_E2E_TOKEN || "");
    if (request.method !== "POST" || expected.length < 32 || !timingSafeEqual(expected, request.headers.get("x-certification-e2e-token") || "")) return json(401, { error: "certification_e2e_auth_required" });
    const oid = String(url.searchParams.get("order_id") || "").toLowerCase();
    const record = JSON.parse(await kv.get(KEY(oid)) || "null");
    if (!record?.test) return json(403, { error: "certification_refund_only_for_test_orders" });
    const out = path.endsWith("/refund-reconcile") ? await reconcileRefund(env, sql(), kv, oid) : await executeRefund(env, sql(), kv, oid, { actor: "certification-e2e" });
    if (out.status === 200 && out.body?.status === "approved" && record.test === true && worker?.fetch) {
      // Ingest the provider refund state through the signed test webhook (same path as sandbox reconciliation).
      const secret = String(env.MERCADOPAGO_TEST_WEBHOOK_SECRET || "");
      if (secret.length >= 16) {
        for (let i = 0; i < 4; i++) {
          const requestId = crypto.randomUUID();
          const ts = String(Math.floor(Date.now() / 1000));
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`id:${record.payment_id};request-id:${requestId};ts:${ts};`)));
          const sig = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
          const r = await worker.fetch(new Request(new URL("/api/webhooks?provider=mercadopago_test", request.url), { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId, "x-signature": `ts=${ts},v1=${sig}` }, body: JSON.stringify({ type: "payment", data: { id: record.payment_id } }) }), env, ctx);
          const res = await r.json().catch(() => ({}));
          if (res?.event === "refund_confirmed") { out.body.order_status = String(res.order_status || ""); break; }
          await new Promise((done) => setTimeout(done, 3000));
        }
      }
    }
    return json(out.status, out.body);
  }

  // Owner surfaces: admin basic auth.
  if (!isAdminAuthorized?.(request, env)) return new Response("Autenticação necessária", { status: 401, headers: { "www-authenticate": 'Basic realm="ZEVANORY Reembolsos", charset="UTF-8"', "cache-control": "no-store" } });
  if (path === "/admin/refunds") return html(200, adminPage(await listRequests(kv, sql())));
  if (path === "/admin/refunds/action") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const origin = request.headers.get("origin") || "";
    if (origin && origin !== ORIGIN) return json(403, { error: "origin_rejected" });
    const form = await request.formData().catch(() => null);
    const oid = String(form?.get("order_id") || "").toLowerCase();
    const action = String(form?.get("action") || "");
    if (!UUID.test(oid)) return json(400, { error: "order_id_invalid" });
    const out = action === "approve" ? await executeRefund(env, sql(), kv, oid, { actor: "owner" }) : action === "reject" ? await rejectRequest(kv, sql(), oid, "owner") : { status: 400, body: { error: "action_invalid" } };
    if (out.status >= 400) return html(out.status, `<p style="font-family:system-ui">Não foi possível: ${esc(out.body.error)}</p><p><a href="/admin/refunds">Voltar</a></p>`);
    return Response.redirect(`${ORIGIN}/admin/refunds`, 303);
  }
  return null;
}

// Hourly watchdog does GET-only reconciliation; never makes refund POST requests.
export async function runRefundWatchdog(env, now = Date.now(), { sqlFactory } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.list) return { ok: false, reason: "kv_unavailable" };
  const pending = [];
  const revocationPending = [];
  let reconciled = 0;
  let cursor;
  do {
    const listed = await kv.list({ prefix: "refund:req:", limit: 200, cursor });
    for (const key of listed.keys || []) {
      let rec = null;
      try { rec = JSON.parse(await kv.get(key.name) || "null"); } catch {}
      if (!rec) continue;
      if (rec.status === "approved" && rec.download_revocation_pending === true) {
        try {
          if (!sqlFactory) throw Error("sql_factory_unavailable");
          await revokeRefundDownloads(sqlFactory(env.DATABASE_URL), rec);
          rec.download_revocation_pending = false;
          await saveRefund(kv, rec);
        } catch { revocationPending.push({ order_id: rec.order_id, test: rec.test }); }
        continue;
      }
      if (rec.status === "pending") {
        try {
          if (!sqlFactory) throw Error("sql_factory_unavailable");
          const sql = sqlFactory(env.DATABASE_URL);
          const persisted = await getRefundClaim(sql, rec.order_id);
          if (persisted || isAmbiguousRefund(rec) || rec.reconciliation_missing?.length) {
            const status = await reconcileRefund(env, sql, kv, rec.order_id);
            if (status.status === 200) reconciled++;
            if (status.body?.error === "refund_download_revocation_pending") revocationPending.push({ order_id: rec.order_id, test: rec.test });
          }
        } catch {}
      }
      if (rec.status !== "pending" || rec.test) continue;
      const ageH = (now - Date.parse(rec.requested_at || 0)) / 3600e3;
      if (ageH >= 12 || await kv.get("refund:alert-pending:" + rec.order_id)) pending.push({ ...rec, ageH });
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  let revocationAlerted = false;
  if (revocationPending.some((r) => !r.test)) {
    try {
      if (!await kv.get("refund:watchdog:revocation:last")) {
        await kv.put("refund:watchdog:revocation:last", new Date(now).toISOString(), { expirationTtl: 12 * 3600 });
        const mail = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"),
          "ZEVANORY — revogação de download pendente",
          "Uma revogação de download pós-reembolso precisa de verificação no painel de reembolsos.");
        revocationAlerted = mail.sent;
      }
    } catch {}
  }
  if (!pending.length) return { ok: revocationPending.length === 0, pending: 0,
    revocation_pending: revocationPending.length, reconciled, revocation_alerted: revocationAlerted };
  if (await kv.get("refund:watchdog:last")) return { ok: true, pending: pending.length, throttled: true, reconciled };
  const lines = pending.map((r) => "- Pedido " + r.order_id + " (" + r.offer_id + ", R$ " + r.amount + ") pedido há " + Math.round(r.ageH) + "h").join("\n");
  const sent = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"),
    "ZEVANORY — " + pending.length + " reembolso(s) aguardando aprovação",
    "Há reembolsos pendentes dentro do prazo legal de 7 dias:\n\n" + lines + "\n\nAprovar: " + ORIGIN + "/admin/refunds");
  if (sent.sent) {
    await kv.put("refund:watchdog:last", new Date(now).toISOString(), { expirationTtl: 12 * 3600 });
    for (const r of pending) { try { await kv.delete("refund:alert-pending:" + r.order_id); } catch {} }
  }
  return { ok: true, pending: pending.length, alerted: sent.sent, reconciled, revocation_pending: revocationPending.length };
}
