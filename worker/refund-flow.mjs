import { CONTACT_HTML, CUSTOMER_RULE_7D, LEGAL_IDENTITY, REFUND_CHANNELS, REFUND_TEXT, SLA_TEXT, refundWindow } from "./politica-unica.mjs";
import { drainAtendimentoOutbox, handleAtendimento } from "./atendimento.mjs";
import { isAmbiguousRefund, hasRefundClaim, getRefundClaim, acquireRefundClaim, revokeRefundDownloads, saveRefund, loadRefund, refundStateTablesExist, markRefundApproved, reconcileRefund } from "./refund-provider-claims.mjs";
import { listRefundStates, listRefundEvents } from "./refund-state.mjs";
import { verifyOperatorToken } from "./operator-credential.mjs";
import { evaluateAutomaticRefund, refundAutoDispatchEnabled, refundIdempotencyKey, validateMercadoPagoCredential } from "./refund-auto-dispatch.mjs";
export { reconcileRefund } from "./refund-provider-claims.mjs";
// T5 — Refund flow (CDC art. 49). P13c (FINANCEIRO): o prazo segue a regra publicada
// (data/politica-unica.json, refund_window via refundWindow): 7 dias corridos a partir da data mais
// recente entre a confirmação do pagamento e o primeiro recebimento (entrega por e-mail ou primeiro
// download); sem recebimento o prazo não começou. Fora do prazo: não registra, encaminha ao suporte.
// Customer requests -> owner approves in /admin/refunds (admin basic auth) -> Mercado Pago refund API
// -> provider webhook/reconciliation marks the order refunded. Download tokens are revoked on approval.
// No customer PII is stored: the email is only compared against the payer email at Mercado Pago.

const MP = "https://api.mercadopago.com";
const ORIGIN = "https://zevanory.api.br";
const KEY = (oid) => `refund:req:${oid}`;


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const html = (status, body, extra = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", ...extra } });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const GENERIC_NOT_FOUND = "Não encontramos um pedido elegível com esses dados. Confira o código do pedido (está no e-mail de entrega) e o e-mail usado no pagamento, ou escreva para suporte@zevanory.api.br.";
const RECEIPT_MESSAGE = "Se os dados conferirem, você receberá a confirmação no e-mail usado na compra";
const RECEIPT = (oid) => ({ status: 200, body: { received: true, protocol: oid, message: RECEIPT_MESSAGE } });

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

async function notifyCredentialMismatch(env, kv, oid, reason, test = false) {
  if (test) return false;
  const key = `refund:credential-alert:${oid}:${reason}`;
  try { if (await kv.get(key)) return false; } catch {} // KV only deduplicates: on error, alert anyway
  const subject = "ZEVANORY — reembolso bloqueado por credencial incompatível";
  const text = `Pedido ${oid}: despacho automático recusado em modo fail-closed (${reason}). Nenhuma chamada financeira foi feita.`;
  const sent = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"), subject, text);
  if (sent.sent) { try { await kv.put(key, new Date().toISOString(), { expirationTtl: 24 * 3600 }); } catch {} }
  return sent.sent;
}

async function loadOrder(sql, oid) {
  // AVAL Sol (2ff8678): o prazo começa no PRIMEIRO recebimento => min(delivered_at), determinístico mesmo
  // com mais de uma linha de entrega (antes: LIMIT 1 sem ORDER BY pegava uma linha arbitrária).
  const rows = await sql.query(
    `select o.order_id, o.status, o.amount, o.offer_id, o.certification_pilot,
            fe.provider_payment_id as payment_id, fe.received_at as paid_at,
            (select min(sf.delivered_at) from service_fulfillment sf where sf.order_id=o.order_id and sf.status='delivered') as delivered_at,
            (select min(t.used_at) from artifact_download_tokens t where t.order_id=o.order_id) as first_download_at
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

async function sendEmail(env, to, subject, text, { idempotencyKey } = {}) {
  if (!env.RESEND_API_KEY || !to) return { sent: false };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
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
  const window = refundWindow({ paidAt: order.paid_at, deliveredAt: order.delivered_at, firstDownloadAt: order.first_download_at, now: Date.now() });
  if (!window.eligible) {
    // Never auto-refunded and never registered as a refund: routed to support (defect/delivery issues are still handled there).
    return { status: 409, body: { error: "fora_do_prazo", route: "suporte", window_ends_at: window.ends_at, message: `O prazo de arrependimento (${CUSTOMER_RULE_7D}) deste pedido terminou. Se houver defeito, arquivo corrompido ou falha de entrega, fale com o suporte: ${REFUND_CHANNELS}.` } };
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
    received_at: window.received_at || null,
    window: window.reason,
    requested_at: new Date().toISOString(),
  };
  await kv.put(KEY(oid), JSON.stringify(record), { expirationTtl: 90 * 24 * 3600 });
  if (!test) {
    const alert = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"), "ZEVANORY — novo pedido de reembolso para aprovar", `Pedido ${oid} (${record.offer_id}, R$ ${record.amount}) solicitou reembolso dentro do prazo de arrependimento (${window.reason === "recebimento_pendente" ? "recebimento ainda não registrado" : "até " + window.ends_at}).\n\nAprovar: ${ORIGIN}/admin/refunds`);
    if (!alert.sent) {
      // Keep a retry marker; the hourly refund watchdog re-alerts the owner.
      try { await kv.put(`refund:alert-pending:${oid}`, new Date().toISOString(), { expirationTtl: 14 * 24 * 3600 }); } catch {}
    }
  }
  if (!test) await sendEmail(env, email, "ZEVANORY — recebemos seu pedido de reembolso", `Recebemos o pedido de reembolso do pedido ${oid}. O valor volta pelo mesmo meio de pagamento assim que o processamento for concluído. Você receberá a confirmação por e-mail.\n\nEquipe ZEVANORY · suporte@zevanory.api.br`);
  return { status: 200, body: { received: true, status: "pending", message: "Pedido de reembolso registrado. Você receberá a confirmação por e-mail." } };
}

// Only the ON flow uses this path; the OFF function above intentionally preserves the
// complete pre-PR behavior, including the exact notification bytes and their order.
const OWNER = (env) => String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com");
const UNVERIFIED_CAP = 10; // distinct unconfirmed addresses kept per order (audit only)
const IDENTITY_HASH_CAP = 5; // distinct identity proofs kept on one manual-review request
const REEVALUATION_DAYS = 7; // automatic (watchdog) re-evaluation window; afterwards only the owner decides
const CONFIRMATION_ALERT_H = 24; // owner alert when a consumer notification keeps failing
// Transient holds: re-evaluated by the watchdog (GET only), by a re-request and by the owner.
const WATCHDOG_REEVALUABLE = new Set(["payment_event_missing", "provider_lookup_failed", "credential_environment_mismatch",
  "identity_unverifiable", "identity_conflict", "test_flag_unverifiable"]);
// Definitive provider answers are re-evaluated only on demand (owner "Reavaliar" or a re-request).
const REEVALUABLE = new Set([...WATCHDOG_REEVALUABLE, "provider_payment_not_found", "provider_lookup_rejected"]);
const REQUEST_REEVALUABLE = new Set([...REEVALUABLE, "eligible_after_reevaluation"]);
// The owner cannot approve these until evidence exists; Reject and "Reavaliar" stay available.
const heldForEvidence = (r) => r?.auto_dispatch === true && (!r.payment_id ||
  ["payment_event_missing", "order_not_paid", "identity_unverifiable", "provider_payment_not_found", "test_flag_unverifiable"].includes(r.manual_reason) ||
  (r.identity_verified !== true && r.manual_reason !== "identity_conflict"));
const JUSTIFICATION_MIN = 10;
const REQUEST_CAS_ATTEMPTS = 5;
// Provider could not prove the payment: owner approval needs an explicit override with evidence.
const PAYMENT_UNPROVEN = new Set(["provider_lookup_failed", "provider_lookup_rejected"]);
const clip = (v, n = 500) => String(v ?? "").trim().slice(0, n);

// Pseudonymous identity proof (salted by order): lets the watchdog/owner re-check a manual
// request against the registered recipients without storing the typed address.
async function identityHash(oid, email) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `zevanory-refund-identity:v1:${oid}:${String(email || "").trim().toLowerCase()}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function registeredEmail(sql, oid) {
  try {
    const f = (await sql.query("select evidence_ref from service_fulfillment where order_id=$1 limit 1", [oid]))[0];
    const ev = f?.evidence_ref && String(f.evidence_ref).trim().startsWith("{") ? JSON.parse(f.evidence_ref) : {};
    return String(ev.email_recipient || "").trim().toLowerCase();
  } catch { return ""; }
}

// Transient (timeout, network, 408/429/5xx) versus definitive (400/401/403, 404) provider answers.
function classifyLookupError(error) {
  const status = Number(/mercadopago_lookup_(\d+)/.exec(String(error?.message || ""))?.[1] || 0);
  return status === 404 ? "not_found" : [400, 401, 403].includes(status) ? "definitive" : "transient";
}

// Shared ON assessment. identity: "matched" (every registered source equals the requester),
// "conflict" (the requester equals one registered source but the sources differ),
// "unverifiable" (the payer could not be consulted and no registered source matched) or
// "mismatch" (registered sources known and none matches: audit only).
async function assessOrder(env, sql, kv, oid, matches, { order, now = Date.now() } = {}) {
  order = order || await loadOrder(sql, oid);
  if (!order) return null;
  // The sandbox-proof marker lives in KV. If KV cannot answer, the request is still registered in
  // PostgreSQL but fails closed: test_flag_unverifiable (manual, re-evaluated when KV recovers).
  let testFlagUnknown = false, sandboxProof = false;
  try { sandboxProof = Boolean(await kv.get(`sandbox-proof-v2:order:${oid}`)); } catch { testFlagUnknown = order.certification_pilot !== true; }
  const test = order.certification_pilot === true || sandboxProof;
  const credential = await validateMercadoPagoCredential(env, test);
  let payment = null, paymentLookupError = null;
  if (credential.ok && order.payment_id) {
    try { payment = await mpPayment(env, order.payment_id, test); } catch (e) { paymentLookupError = classifyLookupError(e); }
  }
  const delivery = await registeredEmail(sql, oid);
  const payer = String(payment?.payer?.email || "").trim().toLowerCase();
  const deliveryMatch = Boolean(delivery) && await matches(delivery);
  const payerMatch = Boolean(payer) && await matches(payer);
  const identity = (delivery || payer) && (!delivery || deliveryMatch) && (!payer || payerMatch) ? "matched" :
    deliveryMatch || payerMatch ? "conflict" : !payer ? "unverifiable" : "mismatch";
  const identityMatched = identity === "matched";
  const window = refundWindow({ paidAt: order.paid_at, deliveredAt: order.delivered_at,
    firstDownloadAt: order.first_download_at, now });
  let decision = evaluateAutomaticRefund({ order, payment, window, identityMatched, test, credential, paymentLookupError });
  if (!order.payment_id || !order.paid_at) decision = { eligible: false, reason: "payment_event_missing" };
  if (testFlagUnknown) decision = { eligible: false, reason: "test_flag_unverifiable" };
  if (identity === "conflict") decision = { eligible: false, reason: "identity_conflict" };
  if (identity === "unverifiable") decision = { eligible: false, reason: "identity_unverifiable" };
  return { order, test, testFlagUnknown, credential, payment, paymentLookupError, delivery, payer, deliveryMatch, payerMatch, identity, window, decision };
}

// System evidence recorded with every transition (no address, no provider secret).
const systemEvidence = (a, extra = {}) => ({ identity: a?.identity ?? null, decision: a?.decision?.reason ?? (a?.decision?.eligible ? "eligible" : null),
  payment_id: a?.order?.payment_id ? String(a.order.payment_id) : null, payment_status: a?.payment?.status ?? null,
  payment_status_detail: a?.payment?.status_detail ?? null, provider_lookup: a?.paymentLookupError ?? (a?.payment ? "ok" : "skipped"),
  credential_ok: a?.credential?.ok ?? null, window: a?.window?.reason ?? null, ...extra });

// Consumer notifications go only to a registered address that the requester proved. Each one
// is retried by the watchdog with a stable idempotency key until delivered.
async function resendCustomerConfirmation(env, sql, kv, record, { payment } = {}) {
  const conflict = record.identity_verified !== true && record.manual_reason === "identity_conflict";
  if (record.test || (!record.identity_verified && !conflict)) return;
  // Never trust the submitted address or a KV copy of it as a delivery target.
  const delivery = await registeredEmail(sql, record.order_id);
  let payer = String(payment?.payer?.email || "").trim().toLowerCase();
  if (!payer && record.payment_id && record.credential_verified === true && !(conflict && record.notify_source !== "payer")) {
    try { payer = String((await mpPayment(env, record.payment_id, record.test))?.payer?.email || "").trim().toLowerCase(); } catch {}
  }
  let to;
  if (conflict) {
    // Only the registered address the requester proved (identity hash), never the other party or the typed text.
    const source = record.notify_source === "payer" ? payer : delivery;
    to = source && (record.identity_hashes || []).includes(await identityHash(record.order_id, source)) ? source : "";
  } else to = delivery && payer && delivery !== payer ? "" : (delivery || payer);
  if (!to) return;
  const save = () => saveRefund(kv, record, { sql, actor: "consumer-notification" });
  if (record.customer_email_pending === true) {
    const sent = await sendEmail(env, to, "ZEVANORY — recebemos seu pedido de reembolso",
      `Protocolo: ${record.order_id}\nIdentificador da manifestação: ${record.request_nonce}\n\nRecebemos seu pedido de reembolso. O pedido foi registrado em ${record.requested_at}. ${conflict ? "Ele está em análise manual e você" : "Você"} receberá a confirmação do resultado por e-mail.\n\nEquipe ZEVANORY · suporte@zevanory.api.br`,
      { idempotencyKey: `zevanory-refund-received-${record.order_id}-${record.request_nonce}` });
    if (sent.sent) {
      record.customer_email_pending = false;
      await save();
    }
  }
  if (record.approved_email_pending === true) {
    const sent = await sendEmail(env, to, "ZEVANORY — reembolso aprovado",
      `O reembolso do pedido ${record.order_id} foi aprovado e enviado ao Mercado Pago.`,
      { idempotencyKey: `zevanory-refund-approved-${record.order_id}` });
    if (sent.sent) {
      record.approved_email_pending = false;
      await save();
    }
  }
  if (record.decision_email_pending === true && record.status === "rejected") {
    const sent = await sendEmail(env, to, "ZEVANORY — decisão sobre seu pedido de reembolso",
      `Protocolo: ${record.order_id}\n\nSeu pedido de reembolso foi analisado e não foi aprovado. Se quiser contestar ou enviar informações, responda este e-mail ou escreva para suporte@zevanory.api.br.\n\nEquipe ZEVANORY`,
      { idempotencyKey: `zevanory-refund-decision-${record.order_id}-${record.request_nonce}` });
    if (sent.sent) {
      record.decision_email_pending = false;
      await save();
    }
  }
}

async function recordUnverifiedAttempt(kv, order, oid, emailMasked, hash) {
  // Separate audit-only list, one key per distinct address and at most UNVERIFIED_CAP per order.
  // Never creates a refund request or offers an approval action.
  try {
    const key = `refund:unverified:${oid}:${String(hash).slice(0, 16)}`;
    const prior = JSON.parse(await kv.get(key) || "null");
    if (!prior) {
      const listed = await kv.list({ prefix: `refund:unverified:${oid}:`, limit: UNVERIFIED_CAP });
      if ((listed.keys || []).length >= UNVERIFIED_CAP) {
        // Cap reached: the attempt is still counted (time + count), never silently dropped.
        const okey = `refund:unverified-overflow:${oid}`;
        const o = JSON.parse(await kv.get(okey) || "null");
        await kv.put(okey, JSON.stringify({ order_id: oid, status: "unverified_overflow", attempts: Number(o?.attempts || 0) + 1,
          first_at: o?.first_at || new Date().toISOString(), last_attempt_at: new Date().toISOString() }), { expirationTtl: 7 * 24 * 3600 });
        return;
      }
    }
    const at = new Date().toISOString();
    await kv.put(key, JSON.stringify({ order_id: oid, status: "unverified", email_masked: emailMasked,
      offer_id: String(order?.offer_id || prior?.offer_id || ""), requested_at: prior?.requested_at || at,
      last_attempt_at: at, attempts: Number(prior?.attempts || 0) + 1 }), { expirationTtl: 7 * 24 * 3600 });
  } catch {} // Logging must not change the public response or block a valid later request.
}

// Every manifestation on an unconfirmed review is persisted (M-1): an audited transition whose
// event carries the pseudonymous identity proof, protocol and time. IDENTITY_HASH_CAP only bounds
// the proof slots kept inside the record; re-evaluation reads every recorded proof from the
// event log. On the first overflow the owner is alerted. Returns false only when a concurrent
// writer won the CAS (the caller re-reads and re-decides).
async function rememberIdentity(env, kv, sql, record, hash, { addProof = true } = {}) {
  const hashes = record.identity_hashes || [];
  const slot = addProof && !hashes.includes(hash) && hashes.length < IDENTITY_HASH_CAP;
  const overflow = addProof && !hashes.includes(hash) && !slot;
  const firstOverflow = overflow && record.identity_proof_overflow !== true;
  if (slot) record.identity_hashes = [...hashes, hash];
  record.manifestations = Number(record.manifestations || 1) + 1;
  record.last_manifestation_at = new Date().toISOString();
  if (overflow) record.identity_proof_overflow = true;
  const saved = await saveRefund(kv, record, { sql, actor: "consumer-request",
    evidence: { manifestation: true, identity_hash: hash, protocol: record.order_id, proof_slot: slot, proof_overflow: overflow },
    transitionKey: `manifestation:${record.order_id}:${record.version}` });
  if (saved && firstOverflow && !record.test)
    await sendEmail(env, OWNER(env), "ZEVANORY — muitas manifestações não confirmadas num pedido",
      `Pedido ${record.order_id}: mais de ${IDENTITY_HASH_CAP} endereços diferentes manifestaram arrependimento sem identidade confirmada. Todas as manifestações estão registradas e serão conferidas na reavaliação. Verifique o pedido.\n\nFila: ${ORIGIN}/admin/refunds`);
  return saved;
}

// Every identity proof recorded for this order: the record slots plus every manifestation event.
async function recordedIdentityHashes(sql, record) {
  const all = new Set(record.identity_hashes || []);
  try {
    for (const e of await listRefundEvents(sql, record.order_id)) {
      const ev = typeof e.evidence === "string" ? JSON.parse(e.evidence) : e.evidence;
      if (ev?.identity_hash) all.add(String(ev.identity_hash));
    }
  } catch (error) { if (!all.size) throw error; } // never conclude "mismatch" from a partial view
  return [...all];
}

const manualAlertText = (record) => `Pedido ${record.order_id} (${record.offer_id}, R$ ${record.amount}) em análise manual: ${record.manual_reason}.` +
  (record.identity_verified !== true ? "\nIdentidade não confirmada automaticamente: verifique o comprador antes de decidir; a confirmação só vai a endereço registrado." : "") +
  (record.confirmation_channel === "none" ? "\nSem canal seguro de confirmação: o consumidor ainda não foi notificado (pendência rastreada)." : "") +
  `\n\nFila: ${ORIGIN}/admin/refunds`;

async function createAutomaticRequest(env, sql, kv, { oid, email }, ctx) {
  oid = String(oid || "").trim().toLowerCase();
  email = String(email || "").trim().toLowerCase();
  if (!UUID.test(oid) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254)
    return { status: 400, body: { error: "dados_invalidos", message: GENERIC_NOT_FOUND } };
  const receipt = RECEIPT(oid);
  const order = await loadOrder(sql, oid);
  if (!order) return receipt; // Residual timing difference documented (requires the order UUID).
  const typedHash = await identityHash(oid, email);
  const a = await assessOrder(env, sql, kv, oid, async (c) => timingSafeEqual(c, email), { order });
  if (a.identity === "mismatch") {
    await recordUnverifiedAttempt(kv, order, oid, maskEmail(email), typedHash);
    return receipt;
  }
  const { test, credential, payment } = a;
  // Bounded re-read/re-decide loop: losing the compare-and-swap to a concurrent writer never
  // drops the manifestation (L-1); after the last attempt the consumer is told to retry.
  for (let attempt = 0; attempt < REQUEST_CAS_ATTEMPTS; attempt++) {
    // Authoritative read (PostgreSQL). A stale or missing KV copy cannot change this decision.
    const existing = await loadRefund(kv, sql, oid, { on: true });
    const pendingExisting = existing?.status === "pending" && !isAmbiguousRefund(existing);
    // Unconfirmed identity never blocks the real buyer: a matched request supersedes it (H1).
    // Only an explicit identity_verified=false marks an unconfirmed record (OFF/legacy records were verified).
    const supersede = pendingExisting && existing.identity_verified === false && a.identity === "matched";
    const reeval = pendingExisting && existing.identity_verified === true && a.identity === "matched" &&
      REQUEST_REEVALUABLE.has(existing.manual_reason);
    // A decided-eligible request whose dispatch did not reach the reservation is retried (the
    // SQL reservation still guarantees a single POST).
    const redispatch = pendingExisting && existing.auto_dispatch === true && existing.identity_verified === true &&
      existing.auto_eligible === true && !existing.manual_reason && a.identity === "matched";
    if (pendingExisting && existing.identity_verified === false && a.identity !== "matched") {
      if (!await rememberIdentity(env, kv, sql, existing, typedHash)) continue; // lost the CAS: re-read (L-1)
      return receipt;
    }
    // An owner rejection of a conflict review stays final for the same requester while the
    // registered data still conflict; new evidence (sources now agree) reopens it for the owner (L-6).
    const conflictRejected = existing?.status === "rejected" && existing.manual_reason === "identity_conflict" &&
      (existing.identity_hashes || []).includes(typedHash);
    if (conflictRejected && a.identity !== "matched") {
      if (!await rememberIdentity(env, kv, sql, existing, typedHash, { addProof: false })) continue; // persisted, still final
      if (existing.decision_email_pending === true) await resendCustomerConfirmation(env, sql, kv, existing, { payment });
      return receipt;
    }
    if (redispatch) {
      if (await hasRefundClaim(sql, oid)) return receipt;
      const retry = async () => {
        if (existing.customer_email_pending === true) await resendCustomerConfirmation(env, sql, kv, existing, { payment });
        const outcome = await executeRefund(env, sql, kv, oid, { actor: "automatic-withdrawal" });
        if (!test && outcome.body?.error !== "refund_provider_reconciliation_required") await sendEmail(env, OWNER(env),
          "ZEVANORY — despacho automático de reembolso",
          `Pedido ${oid}: resultado ${outcome.body?.status || outcome.body?.error || outcome.status}. Esta é uma notificação; não foi solicitada aprovação manual.`);
      };
      if (ctx?.waitUntil) ctx.waitUntil(retry().catch(() => {}));
      else await retry().catch(() => {});
      return receipt;
    }
    if (existing && existing.status !== "unverified_closed" && !supersede && !reeval &&
        (existing.status !== "rejected" || isAmbiguousRefund(existing))) {
      // A manifestation by another proven identity on an existing ON request is recorded too (M-1).
      if (existing.auto_dispatch === true && !(existing.identity_hashes || []).includes(typedHash) &&
          !await rememberIdentity(env, kv, sql, existing, typedHash, { addProof: existing.identity_verified === false })) continue;
      if (existing.identity_verified && existing.customer_email_pending === true)
        await resendCustomerConfirmation(env, sql, kv, existing, { payment });
      return receipt;
    }
    // The SQL claim is authoritative. Never recreate a pending request over an already
    // reserved, possibly completed financial POST.
    if (await hasRefundClaim(sql, oid)) return receipt;
    // The withdrawal is measured at the consumer's original manifestation when the same
    // identity re-requests (late webhook, recovered provider/credential).
    const keepOriginal = reeval || (supersede && (existing.identity_hashes || []).includes(typedHash));
    let { window, decision } = a;
    if (keepOriginal) {
      window = refundWindow({ paidAt: order.paid_at, deliveredAt: order.delivered_at,
        firstDownloadAt: order.first_download_at, now: Date.parse(existing.requested_at) || Date.now() });
      if (a.identity === "matched" && order.payment_id && order.paid_at && !a.testFlagUnknown)
        decision = evaluateAutomaticRefund({ order, payment, window, identityMatched: true, test, credential,
          paymentLookupError: a.paymentLookupError });
    }
    // An owner rejection of a verified request stays sticky; rejecting an unconfirmed attempt never blocks the buyer.
    const priorRejection = (existing?.status === "rejected" && existing.identity_verified !== false) || conflictRejected ||
      (existing?.history || []).some((h) => h.status === "rejected" && (h.identity_verified !== false ||
        (h.manual_reason === "identity_conflict" && (h.identity_hashes || []).includes(typedHash))));
    if (priorRejection) decision = { eligible: false, reason: "previously_rejected" };
    if (reeval && !decision.eligible && decision.reason === existing.manual_reason) {
      if (existing.customer_email_pending === true) await resendCustomerConfirmation(env, sql, kv, existing, { payment });
      return receipt;
    }
    const verified = a.identity === "matched";
    const closedHistory = ["rejected", "unverified_closed"].includes(existing?.status) ? [...(existing.history || []),
      { status: existing.status, at: existing.rejected_at || existing.closed_at || null, by: existing.rejected_by || existing.closed_by || null,
        identity_verified: existing.status === "rejected" ? existing.identity_verified !== false : false,
        manual_reason: existing.manual_reason ?? null, identity_hashes: existing.identity_hashes || [] }] : (existing?.history || []);
    const record = {
      status: "pending", order_id: oid, payment_id: String(order.payment_id || ""),
      amount: Number(order.amount), offer_id: String(order.offer_id || ""), test,
      email_masked: maskEmail(verified ? (a.delivery || a.payer) : email), identity_verified: verified,
      identity_hashes: [typedHash], notify_source: a.identity === "conflict" ? (a.deliveryMatch ? "delivery" : "payer") : null,
      confirmation_channel: verified || a.identity === "conflict" ? "registered_address" : "none",
      credential_verified: credential.ok, paid_at: order.paid_at ? new Date(order.paid_at).toISOString() : null,
      received_at: window.received_at || null, window: window.reason,
      requested_at: keepOriginal ? existing.requested_at : new Date().toISOString(),
      request_nonce: keepOriginal && existing.request_nonce ? existing.request_nonce : crypto.randomUUID(),
      version: Number(existing?.auto_dispatch === true ? existing.version || 0 : 0),
      auto_dispatch: true, auto_eligible: decision.eligible,
      manual_reason: decision.eligible ? null : decision.reason,
      customer_email_pending: keepOriginal && existing.manual_reason !== "identity_unverifiable" ? existing.customer_email_pending === true :
        !test && (verified || a.identity === "conflict"),
      history: closedHistory,
      ...(reeval || supersede ? { reevaluated_at: new Date().toISOString() } : {}),
    };
    if (!await saveRefund(kv, record, { sql, actor: "consumer-request",
      evidence: systemEvidence({ ...a, window, decision }, { reevaluation: Boolean(reeval || supersede), identity_hash: typedHash, protocol: oid }),
      transitionKey: `request:${oid}:${record.request_nonce}:${record.version}` })) continue; // lost the CAS: re-read and re-decide (L-1)
    // Notifications and dispatch run after the uniform response when the runtime allows it,
    // so the response time does not reveal whether the identity matched (L-1).
    const followUp = async () => {
      if (!test) {
        await resendCustomerConfirmation(env, sql, kv, record, { payment });
        if (!decision.eligible) {
          const alert = await sendEmail(env, OWNER(env), "ZEVANORY — reembolso em análise manual", manualAlertText(record));
          if (!alert.sent) { try { await kv.put(`refund:alert-pending:${oid}`, new Date().toISOString(), { expirationTtl: 14 * 24 * 3600 }); } catch {} }
        }
      }
      if (!credential.ok) await notifyCredentialMismatch(env, kv, oid, credential.reason, test);
      if (decision.eligible) {
        let outcome;
        try { outcome = await executeRefund(env, sql, kv, oid, { actor: "automatic-withdrawal" }); }
        catch { outcome = { status: 503, body: { error: "automatic_dispatch_failed_owner_action_required" } }; }
        if (!test) await sendEmail(env, OWNER(env),
          "ZEVANORY — despacho automático de reembolso",
          `Pedido ${oid}: resultado ${outcome.body?.status || outcome.body?.error || outcome.status}. Esta é uma notificação; não foi solicitada aprovação manual.`);
      }
    };
    if (ctx?.waitUntil) ctx.waitUntil(followUp().catch(() => {}));
    else await followUp();
    return receipt;
  }
  await sendEmail(env, OWNER(env), "ZEVANORY — pedido de reembolso não registrado (concorrência)",
    `Pedido ${oid}: a manifestação não pôde ser gravada após ${REQUEST_CAS_ATTEMPTS} tentativas concorrentes. O consumidor recebeu a mensagem para tentar novamente.\n\nFila: ${ORIGIN}/admin/refunds`);
  return { status: 503, body: { error: "indisponivel", message: "Não foi possível registrar agora. Tente novamente em instantes ou escreva para suporte@zevanory.api.br." } };
}

// GET-only re-evaluation of a held manual request (late webhook, recovered provider or
// credential, identity now verifiable). Never POSTs. The withdrawal window is measured at
// the original manifestation; the identity is re-checked with the stored identity hashes.
async function reevaluateRequest(env, sql, kv, oid, { actor = "reevaluation" } = {}) {
  const rec = await loadRefund(kv, sql, oid, { on: true });
  if (!rec || rec.auto_dispatch !== true || rec.status !== "pending" || isAmbiguousRefund(rec))
    return { status: 409, body: { error: "refund_request_not_reevaluable" } };
  if (!REEVALUABLE.has(rec.manual_reason))
    return { status: 200, body: { ok: true, status: rec.status, manual_reason: rec.manual_reason, unchanged: true } };
  try {
    if (await hasRefundClaim(sql, oid)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  // Match against EVERY recorded manifestation (M-1), not only the proof slots in the record.
  let hashes;
  try { hashes = rec.identity_verified === true ? (rec.identity_hashes || []) : await recordedIdentityHashes(sql, rec); }
  catch { return { status: 503, body: { error: "refund_state_unavailable" } }; }
  const legacyVerified = rec.identity_verified === true && !hashes.length;
  const matchedHashes = [];
  const a = await assessOrder(env, sql, kv, oid, async (c) => {
    if (legacyVerified) return true;
    const h = await identityHash(oid, c);
    if (hashes.includes(h)) { matchedHashes.push(h); return true; }
    return false;
  }, { now: Date.parse(rec.requested_at) || Date.now() });
  if (!a) return { status: 409, body: { error: "refund_order_not_found" } };
  if (a.identity === "mismatch") {
    if (rec.identity_verified === true)
      return { status: 200, body: { ok: true, status: rec.status, manual_reason: rec.manual_reason, unchanged: true } };
    // Registered sources are now known and none matches: it was an unconfirmed attempt. The
    // request is closed (kept and audited, never deleted) and never blocks the real buyer.
    Object.assign(rec, { status: "unverified_closed", closed_at: new Date().toISOString(), closed_by: actor,
      auto_eligible: false, customer_email_pending: false });
    if (!await saveRefund(kv, rec, { sql, actor, evidence: systemEvidence(a), transitionKey: `close:${oid}:${rec.version}` }))
      return { status: 409, body: { error: "refund_request_changed_concurrently" } };
    await recordUnverifiedAttempt(kv, a.order, oid, rec.email_masked, hashes[0] || crypto.randomUUID());
    return { status: 200, body: { ok: true, status: "unverified_closed" } };
  }
  const verified = a.identity === "matched";
  const reason = a.decision.eligible ? "eligible_after_reevaluation" : a.decision.reason;
  const changed = reason !== rec.manual_reason || String(a.order.payment_id || "") !== String(rec.payment_id || "") ||
    verified !== (rec.identity_verified === true);
  if (!changed) {
    if (!a.credential.ok) await notifyCredentialMismatch(env, kv, oid, a.credential.reason, a.test);
    return { status: 200, body: { ok: true, status: rec.status, manual_reason: rec.manual_reason, unchanged: true } };
  }
  const neverAcknowledged = rec.manual_reason === "identity_unverifiable" && a.identity !== "unverifiable";
  Object.assign(rec, {
    payment_id: String(a.order.payment_id || ""), amount: Number(a.order.amount), offer_id: String(a.order.offer_id || ""),
    paid_at: a.order.paid_at ? new Date(a.order.paid_at).toISOString() : null,
    received_at: a.window.received_at || null, window: a.window.reason,
    identity_verified: verified, credential_verified: a.credential.ok,
    notify_source: a.identity === "conflict" ? (a.deliveryMatch ? "delivery" : "payer") : null,
    confirmation_channel: verified || a.identity === "conflict" ? "registered_address" : "none",
    auto_eligible: a.decision.eligible, manual_reason: reason, reevaluated_at: new Date().toISOString(),
    identity_hashes: [...new Set([...(rec.identity_hashes || []), ...matchedHashes])],
    ...(verified ? { email_masked: maskEmail(a.delivery || a.payer) } : {}),
    ...(neverAcknowledged ? { customer_email_pending: !a.test } : {}),
  });
  if (!await saveRefund(kv, rec, { sql, actor, evidence: systemEvidence(a), transitionKey: `reevaluate:${oid}:${rec.version}` }))
    return { status: 409, body: { error: "refund_request_changed_concurrently" } };
  if (!a.test) {
    await resendCustomerConfirmation(env, sql, kv, rec, { payment: a.payment });
    await sendEmail(env, OWNER(env), "ZEVANORY — reembolso reavaliado",
      `Pedido ${oid} reavaliado: ${reason}${a.decision.eligible ? " (pronto para aprovação no painel)" : ""}.\n\nFila: ${ORIGIN}/admin/refunds`);
  }
  if (!a.credential.ok) await notifyCredentialMismatch(env, kv, oid, a.credential.reason, a.test);
  return { status: 200, body: { ok: true, status: rec.status, manual_reason: reason, auto_eligible: a.decision.eligible } };
}

async function executeRefund(env, sql, kv, oid, { actor, decision = null }) {
  let record;
  try { record = await loadRefund(kv, sql, oid, { on: refundAutoDispatchEnabled(env) }); }
  catch { return { status: 503, body: { error: "refund_state_unavailable" } }; }
  if (!record) return { status: 404, body: { error: "refund_request_not_found" } };
  if (record.status === "refunded" || record.status === "approved") {
    if (record.download_revocation_pending === true) {
      try {
        await revokeRefundDownloads(sql, record);
        record.download_revocation_pending = false;
        await saveRefund(kv, record, { sql, actor });
      } catch { return { status: 503, body: { error: "refund_download_revocation_pending" } }; }
    }
    return { status: 200, body: { ok: true, status: record.status, refund_id: record.refund_id, duplicate: true } };
  }
  if (record.status !== "pending") return { status: 409, body: { error: "refund_request_not_pending" } };
  if ((heldForEvidence(record) || PAYMENT_UNPROVEN.has(record.manual_reason)) && actor === "owner") {
    // The owner's approval first re-evaluates (GET only) so a late webhook or a recovered
    // provider is picked up instead of a dead end.
    await reevaluateRequest(env, sql, kv, oid, { actor: "owner-reevaluation" });
    try { record = await loadRefund(kv, sql, oid, { on: true }); }
    catch { return { status: 503, body: { error: "refund_state_unavailable" } }; }
    if (!record) return { status: 404, body: { error: "refund_request_not_found" } };
    if (record.status !== "pending") return { status: 409, body: { error: "refund_request_not_pending" } };
  }
  if (heldForEvidence(record)) return { status: 409, body: { error: "refund_manual_evidence_required" } };
  if (isAmbiguousRefund(record)) {
    try {
      const claim = await getRefundClaim(sql, oid);
      if (claim?.stage !== "reconciled_not_refunded" || claim.reconciled_status !== "not_refunded") {
        return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
      }
    } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  }
  const checked = record.auto_dispatch ? await validateMercadoPagoCredential(env, record.test) : { ok: true, token: tokenFor(env, record.test) };
  const token = checked.token;
  if (!checked.ok || !token) {
    if (record.auto_dispatch) await notifyCredentialMismatch(env, kv, oid, checked.reason, record.test);
    return { status: 503, body: { error: checked.reason || "mercadopago_token_missing" } };
  }
  if (record.auto_dispatch === true && actor === "owner") {
    // A human decision over a manual-review request needs a recorded justification; it is
    // persisted (with evidence) before the reservation, so a crash after it is recoverable.
    const justification = clip(decision?.justification);
    if (record.manual_reason && justification.length < JUSTIFICATION_MIN)
      return { status: 400, body: { error: "refund_justification_required" } };
    // L-7: the payment could not be proven at the provider (lookup failed or rejected, still after
    // the re-evaluation above). Approving is an explicit, recorded exception: override + evidence.
    const override = PAYMENT_UNPROVEN.has(record.manual_reason);
    if (override && (decision?.override !== true || clip(decision?.evidence).length < JUSTIFICATION_MIN))
      return { status: 400, body: { error: "refund_payment_override_required" } };
    record.owner_decision = { action: "approve", at: new Date().toISOString(), by: actor, justification: justification || null,
      ...(override ? { payment_override: true } : {}) };
    if (!await saveRefund(kv, record, { sql, actor, justification: justification || null,
      evidence: { owner: clip(decision?.evidence) || null, manual_reason: record.manual_reason ?? null, payment_id: record.payment_id,
        identity_verified: record.identity_verified === true, reevaluated_at: record.reevaluated_at ?? null,
        ...(override ? { payment_override: true } : {}) },
      transitionKey: `owner:approve:${oid}:${record.version}` }))
      return { status: 409, body: { error: "refund_request_changed_concurrently" } };
  }
  // Every financial POST is preceded by a single durable claim or one CAS-controlled retry.
  try {
    if (!await acquireRefundClaim(sql, record)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  let r;
  try {
    r = await fetch(MP + "/v1/payments/" + encodeURIComponent(record.payment_id) + "/refunds", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json",
        "x-idempotency-key": refundIdempotencyKey(oid), ...(record.test ? { "x-test-token": "true" } : {}) },
      body: "{}", signal: AbortSignal.timeout(20000) });
  } catch {
    record.provider_outcome_unknown = true;
    record.last_error = "mercadopago_refund_outcome_unknown";
    try { await saveRefund(kv, record, { sql, actor }); } catch {}
    return { status: 502, body: { error: record.last_error } };
  }
  const body = await r.json().catch(() => ({}));
  const amountInvalid = record.auto_dispatch === true ?
    (body.amount == null || !Number.isFinite(Number(body.amount)) ||
     Math.abs(Number(body.amount) - Number(record.amount)) > 0.005) :
    (body.amount != null && (!Number.isFinite(Number(body.amount)) ||
     Math.abs(Number(body.amount) - Number(record.amount)) > 0.005));
  if (!r.ok || !body?.id || body.status !== "approved" || amountInvalid) {
    record.provider_outcome_unknown = true;
    record.last_error = "mercadopago_refund_" + r.status + "_" +
      String(body?.message || body?.error || body?.status || "unconfirmed").slice(0, 120);
    try { await saveRefund(kv, record, { sql, actor }); } catch {}
    return { status: 502, body: { error: record.last_error } };
  }
  const outcome = await markRefundApproved(sql, kv, record, body.id, actor).catch(() =>
    ({ status: 503, body: { error: "refund_persistence_unavailable_reconciliation_required" } }));
  if (outcome.status === 200) {
    if (record.auto_dispatch) {
      try { await resendCustomerConfirmation(env, sql, kv, record); } catch {}
    } else {
      try {
        const payment = await mpPayment(env, record.payment_id, record.test);
        const to = String(payment?.payer?.email || "").trim().toLowerCase();
        if (to && !record.test) await sendEmail(env, to, "ZEVANORY — reembolso aprovado",
          "O reembolso do pedido " + oid + " foi aprovado e enviado ao Mercado Pago.");
      } catch {}
    }
  }
  return outcome;
}

async function rejectRequest(env, kv, sql, oid, actor, decision = null) {
  let record;
  try { record = await loadRefund(kv, sql, oid, { on: refundAutoDispatchEnabled(env) }); }
  catch { return { status: 503, body: { error: "refund_state_unavailable" } }; }
  if (!record || record.status !== "pending") return { status: 409, body: { error: "refund_request_not_pending" } };
  if (isAmbiguousRefund(record)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  try {
    if (await hasRefundClaim(sql, oid)) return { status: 409, body: { error: "refund_provider_reconciliation_required" } };
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  if (record.auto_dispatch !== true) {
    // Legacy (OFF) record: unchanged pre-PR behavior.
    Object.assign(record, { status: "rejected", rejected_at: new Date().toISOString(), rejected_by: actor });
    await saveRefund(kv, record);
    return { status: 200, body: { ok: true, status: "rejected" } };
  }
  const justification = clip(decision?.justification);
  if (justification.length < JUSTIFICATION_MIN) return { status: 400, body: { error: "refund_justification_required" } };
  const channel = !record.test && (record.identity_verified === true || record.manual_reason === "identity_conflict");
  Object.assign(record, { status: "rejected", rejected_at: new Date().toISOString(), rejected_by: actor,
    owner_decision: { action: "reject", at: new Date().toISOString(), by: actor, justification },
    decision_email_pending: channel, ...(channel ? {} : { confirmation_channel: "none" }) });
  if (!await saveRefund(kv, record, { sql, actor, justification,
    evidence: { owner: clip(decision?.evidence) || null, manual_reason: record.manual_reason ?? null, payment_id: record.payment_id || null,
      identity_verified: record.identity_verified === true },
    transitionKey: `owner:reject:${oid}:${record.version}` }))
    return { status: 409, body: { error: "refund_request_changed_concurrently" } };
  // The decision is communicated only through the registered address (watchdog retries).
  try { await resendCustomerConfirmation(env, sql, kv, record); } catch {}
  return { status: 200, body: { ok: true, status: "rejected" } };
}

async function listRequests(kv, sql, { on = false } = {}) {
  const out = [];
  const claimInfo = async (v) => {
    try { const claim = await getRefundClaim(sql, v.order_id); v.claim_present = Boolean(claim); v.retry_permitted = claim?.stage === "reconciled_not_refunded" && claim?.reconciled_status === "not_refunded"; }
    catch { v.claim_present = true; v.retry_permitted = false; }
  };
  // ON records: PostgreSQL is authoritative (KV copies of them are ignored below). With the
  // flag OFF the new tables are read only if they exist (catalog lookup, no DDL; M-2/L-5).
  let sawOnCopy = false;
  const legacy = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "refund:req:", cursor });
    for (const k of page.keys || []) {
      const v = JSON.parse(await kv.get(k.name) || "null");
      if (v?.auto_dispatch === true) sawOnCopy = true;
      if (v && !v.test && v.auto_dispatch !== true) legacy.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (on || sawOnCopy || await refundStateTablesExist(sql)) {
    let states = [];
    try { states = await listRefundStates(sql, { ensure: on }); }
    catch { if (on) out.push({ status: "state_unavailable", order_id: "", requested_at: new Date().toISOString() }); }
    for (const v of states) if (v && !v.test) { await claimInfo(v); out.push(v); }
  }
  for (const v of legacy) { await claimInfo(v); out.push(v); }
  cursor = undefined;
  do {
    const page = await kv.list({ prefix: "refund:unverified:", cursor });
    for (const k of page.keys || []) {
      const v = JSON.parse(await kv.get(k.name) || "null");
      if (v?.status === "unverified") out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  cursor = undefined;
  do {
    const page = await kv.list({ prefix: "refund:unverified-overflow:", cursor });
    for (const k of page.keys || []) {
      const v = JSON.parse(await kv.get(k.name) || "null");
      if (v?.status === "unverified_overflow") out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
}

const FORM_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Solicitar reembolso · ZEVANORY</title>
<meta name="robots" content="noindex"><link rel="icon" href="/brand/export/avatar-400.png"><style>body{margin:0;font-family:system-ui,sans-serif;background:#05070b;color:#e7ecf7}main{max-width:520px;margin:0 auto;padding:32px 20px}.zv-brand{display:block;margin:0 0 22px}.zv-brand img{display:block;height:44px;width:auto}.zv-legal{margin-top:24px;padding-top:14px;border-top:1px solid #1c2a44;font-size:12px;color:#7f8ca3;line-height:1.6}.zv-legal a,.zv-help a{color:#7fd3ff}h1{font-size:26px}p{color:#b9c4dc;line-height:1.5}label{display:block;margin:18px 0 6px;font-weight:600}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #24324f;background:#0b1220;color:#fff;font-size:16px}button{margin-top:22px;width:100%;padding:14px;border:0;border-radius:10px;background:#00b8ff;color:#04121f;font-weight:700;font-size:16px;cursor:pointer}#msg{margin-top:18px;padding:12px;border-radius:10px;background:#0b1220;display:none}</style></head>
<body><main><a class="zv-brand" href="https://vendas.zevanory.api.br/"><img src="/brand/zevanory-logo-dark.svg" alt="ZEVANORY" width="224" height="51"></a><h1>Solicitar reembolso</h1><p>${REFUND_TEXT} ${SLA_TEXT}</p>
<form id="f"><label for="o">Código do pedido</label><input id="o" name="order_id" required placeholder="está no e-mail de entrega" autocomplete="off">
<label for="e">E-mail usado no pagamento</label><input id="e" name="email" type="email" required autocomplete="email"><button type="submit">Enviar pedido de reembolso</button></form><div id="msg" role="status"></div>
<p class="zv-help" style="margin-top:28px;font-size:14px">Dúvidas, reclamação ou cancelamento: ${CONTACT_HTML}</p><p class="zv-legal">${LEGAL_IDENTITY} · <a href="https://vendas.zevanory.api.br/termos">Termos</a> · <a href="https://vendas.zevanory.api.br/privacidade">Privacidade</a> · <a href="https://vendas.zevanory.api.br/reembolso">Reembolso</a></p></main>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const m=document.getElementById('msg');m.style.display='block';m.textContent='Enviando…';try{const r=await fetch('/api/support/refund-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_id:document.getElementById('o').value,email:document.getElementById('e').value})});const j=await r.json();m.textContent=j.message||'Não foi possível registrar agora. Tente novamente.';}catch{m.textContent='Não foi possível registrar agora. Tente novamente.';}});</script></body></html>`;

function legacyAdminPage(items) {
  // Byte-identical to the pre-PR page (base a098d880); used while OFF with no ON-created state.
  const rows = items.map((r) => `<tr><td>${esc(r.requested_at.slice(0, 16).replace("T", " "))}</td><td><code>${esc(r.order_id)}</code><br><small>${esc(r.offer_id)} · ${esc(r.email_masked)}</small></td><td>R$ ${esc(r.amount)}</td><td>${esc(r.status)}${r.last_error ? `<br><small>${esc(r.last_error)}</small>` : ""}</td><td>${r.status === "pending" && r.retry_permitted ? `<form method="post" action="/admin/refunds/action"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Repetir após conciliação (uma vez)</button></form>` : r.status === "pending" && !r.claim_present && !isAmbiguousRefund(r) ? `<form method="post" action="/admin/refunds/action" style="display:inline"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Aprovar reembolso</button> <button name="action" value="reject" class="no">Recusar</button></form>` : (isAmbiguousRefund(r) || r.claim_present) ? "Verificar conciliação no Mercado Pago antes de nova tentativa" : r.download_revocation_pending === true ? "Revogação de downloads pendente; verificar recuperação" : esc(r.refund_id || "")}</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reembolsos · ZEVANORY</title><style>body{font-family:system-ui,sans-serif;background:#050a1e;color:#e7ecf7;margin:0;padding:24px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #22305a;text-align:left;vertical-align:top}button{padding:10px 14px;border:0;border-radius:8px;background:#22c55e;color:#04210f;font-weight:700}button.no{background:#334155;color:#fff}code{font-size:12px}</style></head><body><h1>Pedidos de reembolso</h1><p>Aprovar envia o reembolso integral ao Mercado Pago e bloqueia novos downloads do pedido.</p><table><tr><th>Quando</th><th>Pedido</th><th>Valor</th><th>Status</th><th>Ação</th></tr>${rows || '<tr><td colspan="5">Nenhum pedido.</td></tr>'}</table></body></html>`;
}

function adminPage(items, env = {}) {
  // L-7: while OFF and without any state created by the ON flow, render the exact legacy page.
  if (!refundAutoDispatchEnabled(env) && !items.some((r) => r.auto_dispatch === true || ["unverified", "unverified_overflow", "state_unavailable"].includes(r.status))) return legacyAdminPage(items);
  const stateDown = items.some((r) => r.status === "state_unavailable");
  // ON records: every owner decision carries a justification (mandatory for manual review) and evidence.
  const decisionFields = (r) => r.auto_dispatch === true ? `<br><input name="justification" maxlength="500" placeholder="Justificativa${r.manual_reason ? " (obrigatória)" : ""}"> <input name="evidence" maxlength="500" placeholder="Evidência (ID no provedor, contato)">${PAYMENT_UNPROVEN.has(r.manual_reason) ? `<br><label><input type="checkbox" name="override" value="1"> Exceção: aprovar sem comprovação do pagamento no provedor (evidência obrigatória)</label>` : ""}` : "";
  const rows = items.filter(r => !["unverified", "unverified_overflow", "state_unavailable"].includes(r.status)).map((r) => { const ageH = Math.max(0, (Date.now() - Date.parse(r.requested_at || 0)) / 3600e3); const manualHold = heldForEvidence(r) && r.status === "pending"; return `<tr><td>${esc(r.requested_at.slice(0, 16).replace("T", " "))}<br><small>há ${esc(ageH < 1 ? Math.max(0, Math.floor(ageH * 60)) + " min" : Math.floor(ageH) + " h")}</small></td><td><code>${esc(r.order_id)}</code><br><small>${esc(r.offer_id)} · ${esc(r.email_masked)}</small></td><td>R$ ${esc(r.amount)}</td><td>${esc(r.status)}${r.manual_reason ? `<br><small>manual: ${esc(r.manual_reason)}</small>` : ""}${r.history?.length ? `<br><small>recusa anterior registrada (${esc(r.history.length)})</small>` : ""}${r.last_error ? `<br><small>${esc(r.last_error)}</small>` : ""}${r.confirmation_channel === "none" ? "<br><small>sem canal seguro de confirmação: consumidor não notificado (pendência rastreada)</small>" : ""}${r.owner_decision?.justification ? `<br><small>decisão: ${esc(r.owner_decision.action)} — ${esc(r.owner_decision.justification)}</small>` : ""}</td><td>${manualHold ? `<small>Aguardar comprovação do pagamento/identidade; aprovação só após reavaliação</small><form method="post" action="/admin/refunds/action" style="display:inline"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="reevaluate">Reavaliar agora</button> <button name="action" value="reject" class="no">Recusar</button>${decisionFields(r)}</form>` : r.status === "pending" && r.retry_permitted ? `<form method="post" action="/admin/refunds/action"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Repetir após conciliação (uma vez)</button>${decisionFields(r)}</form>` : r.status === "pending" && !r.claim_present && !isAmbiguousRefund(r) ? `<form method="post" action="/admin/refunds/action" style="display:inline"><input type="hidden" name="order_id" value="${esc(r.order_id)}"><button name="action" value="approve">Aprovar reembolso</button> <button name="action" value="reject" class="no">Recusar</button>${decisionFields(r)}</form>` : (isAmbiguousRefund(r) || r.claim_present) ? "Verificar conciliação no Mercado Pago antes de nova tentativa" : r.download_revocation_pending === true ? "Revogação de downloads pendente; verificar recuperação" : esc(r.refund_id || "")}</td></tr>`; }).join("");
  const unverified = items.filter(r => r.status === "unverified" || r.status === "unverified_overflow").map(r => r.status === "unverified_overflow" ? `<tr><td>${esc(r.last_attempt_at)}</td><td><code>${esc(r.order_id)}</code></td><td>excedente do limite: ${esc(r.attempts)} tentativas</td><td>Identidade não confirmada — somente auditoria</td></tr>` : `<tr><td>${esc(r.requested_at)}</td><td><code>${esc(r.order_id)}</code></td><td>${esc(r.email_masked)}${Number(r.attempts) > 1 ? ` (${esc(r.attempts)} tentativas)` : ""}</td><td>Identidade não confirmada — somente auditoria</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reembolsos · ZEVANORY</title><style>body{font-family:system-ui,sans-serif;background:#050a1e;color:#e7ecf7;margin:0;padding:24px}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #22305a;text-align:left;vertical-align:top}button{padding:10px 14px;border:0;border-radius:8px;background:#22c55e;color:#04210f;font-weight:700}button.no{background:#334155;color:#fff}code{font-size:12px}</style></head><body><h1>Pedidos de reembolso</h1><p>Aprovar envia o reembolso integral ao Mercado Pago e bloqueia novos downloads do pedido.</p>${stateDown ? "<p><strong>Estado autoritativo (PostgreSQL) indisponível: pedidos do modo automático não listados. Nenhuma decisão é possível até a recuperação.</strong></p>" : ""}<table><tr><th>Quando</th><th>Pedido</th><th>Valor</th><th>Status</th><th>Ação</th></tr>${rows || '<tr><td colspan="5">Nenhum pedido.</td></tr>'}</table><h2>Tentativas com identidade não confirmada (sem ação financeira)</h2><table><tr><th>Quando</th><th>Pedido</th><th>E-mail mascarado</th><th>Decisão</th></tr>${unverified || '<tr><td colspan="4">Nenhuma tentativa.</td></tr>'}</table></body></html>`;
}

export async function handleRefundFlow(request, env, { sqlFactory, isAdminAuthorized, worker, ctx } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  // Atendimento ao consumidor (suporte, reclamação, cancelamento, reembolso) com protocolo: mesmo ponto
  // de entrada do reembolso, sem nova rota no despachante central.
  const atendimento = await handleAtendimento(request, env, { sqlFactory });
  if (atendimento) return atendimento;
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
      const out = refundAutoDispatchEnabled(env) ?
        await createAutomaticRequest(env, sql(), kv, { oid: input.order_id, email: input.email }, ctx) :
        await createRequest(env, sql(), kv, { oid: input.order_id, email: input.email });
      const diagnostic = Boolean(verifyOperatorToken(env, request.headers.get("x-certification-e2e-token") || ""));
      if (!diagnostic && out.body?.reason) delete out.body.reason;
      return json(out.status, out.body);
    } catch {
      return json(503, { error: "indisponivel", message: "Não foi possível registrar agora. Tente novamente em instantes ou escreva para suporte@zevanory.api.br." });
    }
  }

  if (path === "/api/internal/certification/e2e/refund-approve" || path === "/api/internal/certification/e2e/refund-reconcile") {
    if (request.method !== "POST" || !verifyOperatorToken(env, request.headers.get("x-certification-e2e-token") || "")) return json(401, { error: "certification_e2e_auth_required" });
    const oid = String(url.searchParams.get("order_id") || "").toLowerCase();
    let record = null;
    try { record = await loadRefund(kv, sql(), oid, { on: refundAutoDispatchEnabled(env) }); } catch {}
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
  if (path === "/admin/refunds") return html(200, adminPage(await listRequests(kv, sql(), { on: refundAutoDispatchEnabled(env) }), env));
  if (path === "/admin/refunds/action") {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const origin = request.headers.get("origin") || "";
    if (origin && origin !== ORIGIN) return json(403, { error: "origin_rejected" });
    const form = await request.formData().catch(() => null);
    const oid = String(form?.get("order_id") || "").toLowerCase();
    const action = String(form?.get("action") || "");
    if (!UUID.test(oid)) return json(400, { error: "order_id_invalid" });
    const decision = { justification: clip(form?.get("justification")), evidence: clip(form?.get("evidence")),
      override: String(form?.get("override") || "") === "1" };
    // "reevaluate" exists only for ON-created records; anything else keeps the legacy 400.
    let reevaluable = false;
    if (action === "reevaluate") { try { reevaluable = (await loadRefund(kv, sql(), oid, { on: refundAutoDispatchEnabled(env) }))?.auto_dispatch === true; } catch {} }
    let out;
    try {
      out = action === "approve" ? await executeRefund(env, sql(), kv, oid, { actor: "owner", decision }) : action === "reject" ? await rejectRequest(env, kv, sql(), oid, "owner", decision) : reevaluable ? await reevaluateRequest(env, sql(), kv, oid, { actor: "owner-reevaluation" }) : { status: 400, body: { error: "action_invalid" } };
    } catch { out = { status: 503, body: { error: "refund_state_unavailable" } }; } // B-1: storage failure is a handled 503, the state is unchanged
    if (out.status >= 400) return html(out.status, `<p style="font-family:system-ui">Não foi possível: ${esc(out.body.error)}</p><p><a href="/admin/refunds">Voltar</a></p>`);
    return Response.redirect(`${ORIGIN}/admin/refunds`, 303);
  }
  return null;
}

// Hourly watchdog does GET-only reconciliation; never makes refund POST requests.
// Cron horário: reembolsos + outbox do atendimento (drainAtendimentoOutbox). Falha do atendimento deixa
// o resultado ok=false (cron vermelho), sem impedir a parte do reembolso.
export async function runRefundWatchdog(env, now = Date.now(), { sqlFactory } = {}) {
  const refund = await runRefundWatchdogCore(env, now, { sqlFactory });
  let atendimento;
  try { atendimento = await drainAtendimentoOutbox(env, { sqlFactory }); }
  catch { atendimento = { ok: false, reason: "atendimento_drain_failed" }; }
  return { ...refund, ok: refund.ok !== false && atendimento.ok !== false, atendimento };
}

async function runRefundWatchdogCore(env, now = Date.now(), { sqlFactory } = {}) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.list) return { ok: false, reason: "kv_unavailable" };
  const on = refundAutoDispatchEnabled(env);
  const pending = [];
  const revocationPending = [];
  let reconciled = 0, reevaluated = 0, stateUnavailable = false;
  // Legacy (OFF) records live in KV; ON records are read from PostgreSQL, never from their KV copy.
  const records = [];
  let cursor;
  do {
    const listed = await kv.list({ prefix: "refund:req:", limit: 200, cursor });
    for (const key of listed.keys || []) {
      let rec = null;
      try { rec = JSON.parse(await kv.get(key.name) || "null"); } catch {}
      if (rec && rec.auto_dispatch !== true) records.push(rec);
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  if (sqlFactory) {
    if (on || await refundStateTablesExist(sqlFactory(env.DATABASE_URL))) {
      try { records.push(...await listRefundStates(sqlFactory(env.DATABASE_URL), { ensure: on })); }
      catch { if (on) stateUnavailable = true; }
    }
  } else if (on) stateUnavailable = true;
  const sqlOf = () => { if (!sqlFactory) throw Error("sql_factory_unavailable"); return sqlFactory(env.DATABASE_URL); };
  for (let rec of records) {
    if (rec.auto_dispatch === true && rec.status === "pending" && !rec.test && WATCHDOG_REEVALUABLE.has(rec.manual_reason) &&
        !isAmbiguousRefund(rec)) {
      // M-B/M-A: controlled re-evaluation (GET only, never POST) of transient holds, within
      // REEVALUATION_DAYS of the manifestation; afterwards the owner is alerted once and decides.
      try {
        const sql = sqlOf();
        if ((now - Date.parse(rec.requested_at || 0)) / 864e5 <= REEVALUATION_DAYS) {
          const out = await reevaluateRequest(env, sql, kv, rec.order_id, { actor: "watchdog" });
          if (out.status === 200 && !out.body?.unchanged) reevaluated++;
          rec = await loadRefund(kv, sql, rec.order_id, { on: true });
        } else if (!rec.reevaluation_closed) {
          rec.reevaluation_closed = true;
          if (await saveRefund(kv, rec, { sql, actor: "watchdog", evidence: { reevaluation_window_days: REEVALUATION_DAYS, manual_reason: rec.manual_reason },
            transitionKey: `reevaluation-closed:${rec.order_id}:${rec.version}` }))
            await sendEmail(env, OWNER(env), "ZEVANORY — reavaliação automática encerrada",
              `Pedido ${rec.order_id}: ${rec.manual_reason} persistiu por ${REEVALUATION_DAYS} dias. Decida no painel (aprovar após reavaliação ou recusar, com justificativa).\n\nFila: ${ORIGIN}/admin/refunds`);
        }
      } catch {}
      if (!rec) continue;
    }
    if (rec.auto_dispatch === true && (rec.identity_verified === true || rec.manual_reason === "identity_conflict") && !rec.test &&
        (rec.customer_email_pending === true || rec.approved_email_pending === true || rec.decision_email_pending === true)) {
      try {
        const sql = sqlOf();
        await resendCustomerConfirmation(env, sql, kv, rec);
        const since = Date.parse(rec.rejected_at || rec.approved_at || rec.requested_at || 0);
        if ((rec.customer_email_pending === true || rec.approved_email_pending === true || rec.decision_email_pending === true) &&
            !rec.confirmation_failure_alerted && (now - since) / 3600e3 >= CONFIRMATION_ALERT_H) {
          // Persistent failure of the consumer notification: alert the owner once (tracked in the record).
          const mail = await sendEmail(env, OWNER(env), "ZEVANORY — confirmação ao consumidor não entregue",
            `Pedido ${rec.order_id}: a notificação ao consumidor (endereço registrado) falha há mais de ${CONFIRMATION_ALERT_H} h. O watchdog continua tentando.\n\nFila: ${ORIGIN}/admin/refunds`);
          if (mail.sent) { rec.confirmation_failure_alerted = true; await saveRefund(kv, rec, { sql, actor: "watchdog" }); }
        }
      } catch {} // Keep pending marker; the next hourly run will retry.
    }
    if (rec.status === "approved" && rec.download_revocation_pending === true) {
      try {
        const sql = sqlOf();
        await revokeRefundDownloads(sql, rec);
        rec.download_revocation_pending = false;
        await saveRefund(kv, rec, { sql, actor: "watchdog" });
      } catch { revocationPending.push({ order_id: rec.order_id, test: rec.test }); }
      continue;
    }
    if (rec.status === "pending") {
      try {
        const sql = sqlOf();
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
  if (stateUnavailable) {
    try {
      if (!await kv.get("refund:watchdog:state:last")) {
        await kv.put("refund:watchdog:state:last", new Date(now).toISOString(), { expirationTtl: 12 * 3600 });
        await sendEmail(env, OWNER(env), "ZEVANORY — estado de reembolso indisponível",
          "O estado autoritativo dos reembolsos (PostgreSQL) não pôde ser lido pelo watchdog. Nenhuma decisão automática é tomada até a recuperação.");
      }
    } catch {}
  }
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
  const stateFlag = stateUnavailable ? { state_unavailable: true } : {};
  if (!pending.length) return { ok: revocationPending.length === 0 && !stateUnavailable, ...stateFlag, pending: 0,
    revocation_pending: revocationPending.length, reconciled, ...(reevaluated ? { reevaluated } : {}), revocation_alerted: revocationAlerted };
  if (await kv.get("refund:watchdog:last")) return { ok: !stateUnavailable, ...stateFlag, pending: pending.length, throttled: true, reconciled, ...(reevaluated ? { reevaluated } : {}) };
  const lines = pending.map((r) => "- Pedido " + r.order_id + " (" + r.offer_id + ", R$ " + r.amount + ") pedido há " + Math.round(r.ageH) + "h" +
    (r.confirmation_channel === "none" ? " [sem canal seguro de confirmação]" : "")).join("\n");
  const sent = await sendEmail(env, String(env.OWNER_ALERT_EMAIL || "zevanory@gmail.com"),
    "ZEVANORY — " + pending.length + " reembolso(s) aguardando aprovação",
    "Há reembolsos pendentes pedidos dentro do prazo de arrependimento:\n\n" + lines + "\n\nAprovar: " + ORIGIN + "/admin/refunds");
  if (sent.sent) {
    await kv.put("refund:watchdog:last", new Date(now).toISOString(), { expirationTtl: 12 * 3600 });
    for (const r of pending) { try { await kv.delete("refund:alert-pending:" + r.order_id); } catch {} }
  }
  return { ok: !stateUnavailable, ...stateFlag, pending: pending.length, alerted: sent.sent, reconciled, ...(reevaluated ? { reevaluated } : {}), revocation_pending: revocationPending.length };
}
