// Durable Mercado Pago refund claims and GET-only recovery.
// No automatic financial POST is permitted from this module.
const MP = "https://api.mercadopago.com";
const KEY = (id) => "refund:req:" + id;
const TTL = 90 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DDL = "create table if not exists refund_provider_claims (order_id uuid primary key, payment_id text not null, test boolean not null, stage text not null, claimed_at timestamptz not null default now(), reconciled_at timestamptz, reconciled_status text)";
const moneyMatches = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.005;
export const isAmbiguousRefund = (r) => r?.provider_outcome_unknown === true ||
  /^mercadopago_refund_(?:[45][0-9]{2}|500|502|503|504|408)_/.test(String(r?.last_error || "")) ||
  r?.last_error === "mercadopago_refund_outcome_unknown";
export async function ensureRefundClaims(sql) { await sql.query(DDL); }
export async function getRefundClaim(sql, oid) {
  await ensureRefundClaims(sql);
  return (await sql.query("select order_id,payment_id,test,stage,claimed_at,reconciled_at,reconciled_status from refund_provider_claims where order_id=$1::uuid", [oid]))[0] || null;
}
export async function hasRefundClaim(sql, oid) { return Boolean(await getRefundClaim(sql, oid)); }
export async function acquireRefundClaim(sql, record) {
  await ensureRefundClaims(sql);
  const args = [record.order_id, String(record.payment_id), record.test === true];
  const retry = await sql.query("update refund_provider_claims set stage='retry_call_may_have_been_sent',reconciled_status='retry_sent' where order_id=$1::uuid and payment_id=$2 and test=$3 and stage='reconciled_not_refunded' and reconciled_status='not_refunded' returning order_id", args);
  if (retry.length) return true;
  const inserted = await sql.query("insert into refund_provider_claims (order_id,payment_id,test,stage) values ($1::uuid,$2,$3,'provider_call_may_have_been_sent') on conflict (order_id) do nothing returning order_id", args);
  return inserted.length === 1;
}
export async function revokeRefundDownloads(sql, record) {
  await sql.query("update artifact_download_tokens set used_at=coalesce(used_at, now()) where order_id=$1", [record.order_id]);
}
export async function saveRefund(kv, record) {
  await kv.put(KEY(record.order_id), JSON.stringify(record), { expirationTtl: TTL });
}
export async function markRefundApproved(sql, kv, record, refundId, actor) {
  // Once the provider confirms, never retry POST even on DB/KV failure.
  try {
    await sql.query("update refund_provider_claims set stage='reconciled_refunded',reconciled_at=now(),reconciled_status='approved' where order_id=$1::uuid and payment_id=$2 and test=$3", [record.order_id, String(record.payment_id), record.test === true]);
  } catch {}
  Object.assign(record, { status: "approved", refund_id: String(refundId), refund_status: "approved",
    approved_at: new Date().toISOString(), approved_by: actor,
    provider_outcome_unknown: false, download_revocation_pending: true, reconciliation_missing: null });
  await saveRefund(kv, record);
  try {
    await revokeRefundDownloads(sql, record);
    record.download_revocation_pending = false;
    record.last_error = null;
    await saveRefund(kv, record);
    return { status: 200, body: { ok: true, status: "approved", refund_id: record.refund_id } };
  } catch {
    record.last_error = "refund_download_revocation_pending";
    try { await saveRefund(kv, record); } catch {}
    return { status: 503, body: { error: "refund_download_revocation_pending" } };
  }
}
export async function reconcileRefund(env, sql, kv, oid) {
  if (!UUID.test(String(oid || ""))) return { status: 400, body: { error: "order_id_invalid" } };
  const rec = JSON.parse(await kv.get(KEY(oid)) || "null");
  if (!rec) return { status: 404, body: { error: "refund_request_not_found" } };
  let claim;
  try {
    claim = await getRefundClaim(sql, oid);
    // Legacy HTTP 500 records had no persistent claim. Never bypass them.
    if (!claim && isAmbiguousRefund(rec)) {
      await sql.query("insert into refund_provider_claims (order_id,payment_id,test,stage) values ($1::uuid,$2,$3,'legacy_unknown') on conflict (order_id) do nothing returning order_id", [oid, String(rec.payment_id), rec.test === true]);
      claim = await getRefundClaim(sql, oid);
    }
    if (!claim) return { status: 409, body: { error: "refund_claim_missing" } };
    if (String(claim.payment_id) !== String(rec.payment_id) || claim.test !== (rec.test === true))
      return { status: 409, body: { error: "refund_claim_identity_mismatch" } };
    if (rec.status === "approved" && rec.download_revocation_pending === true) {
      try {
        await revokeRefundDownloads(sql, rec);
        rec.download_revocation_pending = false;
        await saveRefund(kv, rec);
        return { status: 200, body: { ok: true, status: "approved", recovered: true, refund_id: rec.refund_id } };
      } catch { return { status: 503, body: { error: "refund_download_revocation_pending" } }; }
    }
  } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  const token = String((rec.test ? env.MERCADOPAGO_TEST_ACCESS_TOKEN : env.MERCADOPAGO_ACCESS_TOKEN) || "").trim();
  if (!token) return { status: 503, body: { error: "mercadopago_token_missing" } };
  let payment;
  try {
    const r = await fetch(MP + "/v1/payments/" + encodeURIComponent(rec.payment_id),
      { headers: { accept: "application/json", authorization: "Bearer " + token, ...(rec.test ? { "x-test-token": "true" } : {}) },
        signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw Error("payment_get_" + r.status);
    payment = await r.json();
  } catch {
    rec.reconciliation_missing = ["payment_get"];
    rec.provider_outcome_unknown = true;
    try { await saveRefund(kv, rec); } catch {}
    return { status: 503, body: { error: "refund_payment_lookup_unavailable", missing: ["payment_get"] } };
  }
  const missing = [];
  const refunds = Array.isArray(payment?.refunds) ? payment.refunds : null;
  const total = payment?.transaction_amount_refunded == null ? NaN : Number(payment.transaction_amount_refunded);
  if (!(Number(rec.amount) > 0) || !moneyMatches(payment?.transaction_amount, rec.amount)) missing.push("transaction_amount");
  if (!Number.isFinite(total) || total < 0) missing.push("transaction_amount_refunded");
  if (!refunds) missing.push("refunds");
  if (payment?.status == null) missing.push("status");
  if (payment?.status_detail == null) missing.push("status_detail");
  const approvedFull = !missing.length && refunds.length === 1 && refunds[0]?.status === "approved" &&
    refunds[0]?.id != null && moneyMatches(refunds[0]?.amount, rec.amount) && moneyMatches(total, rec.amount);
  if (approvedFull) {
    try { return await markRefundApproved(sql, kv, rec, refunds[0].id, "provider-get-reconciliation"); }
    catch { return { status: 503, body: { error: "refund_persistence_unavailable" } }; }
  }
  const age = Date.now() - Date.parse(claim.claimed_at);
  const absent = !missing.length && refunds.length === 0 && total === 0 && payment.status === "approved" && age >= 30 * 60 * 1000;
  if (absent && claim.stage === "reconciled_not_refunded" && claim.reconciled_status === "not_refunded") {
    Object.assign(rec, { provider_outcome_unknown: false, reconciliation_missing: null, last_error: null });
    await saveRefund(kv, rec);
    return { status: 200, body: { ok: true, status: "not_refunded", retry_permitted: true } };
  }
  if (absent && ["provider_call_may_have_been_sent","legacy_unknown"].includes(claim.stage) && claim.reconciled_status == null) {
    try {
      const updated = await sql.query("update refund_provider_claims set stage='reconciled_not_refunded',reconciled_at=now(),reconciled_status='not_refunded' where order_id=$1::uuid and payment_id=$2 and test=$3 and stage in ('provider_call_may_have_been_sent','legacy_unknown') and reconciled_status is null and claimed_at <= now() - interval '30 minutes' returning order_id", [oid, String(rec.payment_id), rec.test === true]);
      if (updated.length === 1) {
        Object.assign(rec, { provider_outcome_unknown: false, reconciliation_missing: null, last_error: null });
        await saveRefund(kv, rec);
        return { status: 200, body: { ok: true, status: "not_refunded", retry_permitted: true } };
      }
    } catch { return { status: 503, body: { error: "refund_claim_store_unavailable" } }; }
  }
  if (!missing.length) {
    if (refunds.some((r) => ["in_process","pending"].includes(r?.status))) missing.push("refund_not_terminal");
    else if (total > 0 && !moneyMatches(total, rec.amount)) missing.push("partial_refund");
    else if (payment.status !== "approved" && total === 0) missing.push("payment_status_" + payment.status);
    else if (claim.reconciled_status === "retry_sent") missing.push("one_retry_already_consumed");
    else if (!(age >= 30 * 60 * 1000)) missing.push("claim_younger_than_30_minutes");
    else missing.push("provider_outcome_unconfirmed");
  }
  rec.provider_outcome_unknown = true;
  rec.reconciliation_missing = missing;
  try { await saveRefund(kv, rec); } catch {}
  return { status: 409, body: { error: "refund_provider_reconciliation_required", missing } };
}
