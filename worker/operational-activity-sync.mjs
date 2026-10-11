// P1-4: full panel visibility. Read-only projection of operational facts into the
// shared activity outbox (Comercial -> Atividade), in the isolated 5,35 cron.
// Never writes orders, payments, refunds, the sales switch or secrets; refs are
// hashed by emitActivity and no PII, email, token or order id is stored.
import { emitActivity } from "./activity-ledger.mjs";
import { readFinancialProofSnapshot, LAUNCH_EPOCH_KV_KEY } from "./commercial-metrics-projection.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const LIMIT = 5;
const status = v => String(v || "recorded").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64) || "recorded";

export async function syncOperationalActivity(env, { sqlFactory, now = Date.now(), salesSwitch = null } = {}) {
  const kv = env?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get || !kv?.put) return { ok: false, reason: "kv_unavailable" };
  const out = { ok: true, emitted: 0, sections: {} };
  const emit = async (section, event) => {
    const r = await emitActivity(env, event, { now }).catch(() => ({ emitted: false }));
    if (r?.emitted) { out.emitted++; out.sections[section] = (out.sections[section] || 0) + 1; }
  };
  // Deploy: one event per release SHA (emitActivity deduplicates by ref).
  const sha = String(env.ZEVANORY_RELEASE_SHA || "");
  if (SHA.test(sha)) await emit("deploy", { type: "deploy", channel: "system", status: "live", ref: "deploy:" + sha });
  // Sales switch: one event per owner switch revision (open/closed), read-only.
  if (salesSwitch && typeof salesSwitch === "object" && String(salesSwitch.revision || "")) {
    await emit("sales_switch", { type: "sales_switch", channel: "system", status: salesSwitch.enabled === true ? "open" : (salesSwitch.requested ? "blocked" : "closed"), ref: "sales-switch:" + String(salesSwitch.revision) + ":" + (salesSwitch.enabled === true) });
  }
  // Refund requests (KV records written by the refund flow). Status only.
  if (kv.list) {
    try {
      const page = await kv.list({ prefix: "refund:req:", limit: 20 });
      for (const key of page?.keys || []) {
        const oid = String(key?.name || "").slice("refund:req:".length);
        if (!UUID.test(oid)) continue;
        let rec = null; try { rec = JSON.parse(String(await kv.get(key.name) || "null")); } catch {}
        if (!rec) continue;
        await emit("refund_requested", { type: "refund_requested", channel: "finance", status: status(rec.status), ref: "refund-req:" + oid });
      }
    } catch { out.sections.refund_requested_error = 1; }
  }
  if (!env?.DATABASE_URL || !sqlFactory) return out;
  // WhatsApp: one aggregated event per completed hour (replies, and replies that
  // carried a purchase link), from the Neon observation store. Per-message KV
  // writes are forbidden by the WhatsApp KV write budget (dedup put only).
  try {
    const rows = await sqlFactory(env.DATABASE_URL).query(
      "select date_trunc('hour', updated_at) as hour, " +
      "count(*) filter (where store_value like '%\"text_sent\":true%') as replies, " +
      "count(*) filter (where store_value like '%\"text_sent\":true%' and store_value like '%vendas.zevanory.api.br/comprar/ZEV-%') as links " +
      "from whatsapp_observations where updated_at >= $1 and updated_at < date_trunc('hour', $2::timestamptz) " +
      "group by 1 order by 1 desc limit 3", [new Date(now - 3 * 3600000).toISOString(), new Date(now).toISOString()]);
    for (const row of Array.isArray(rows) ? rows : []) {
      const hour = new Date(row?.hour), replies = Number(row?.replies), links = Number(row?.links);
      if (!Number.isFinite(hour.getTime()) || !Number.isSafeInteger(replies) || replies <= 0) continue;
      const h = hour.toISOString().slice(0, 13);
      await emit("whatsapp_replied", { type: "whatsapp_replied", channel: "whatsapp", status: "replied-" + Math.min(replies, 9999), ref: "wa-hour:" + h });
      if (Number.isSafeInteger(links) && links > 0) await emit("link_sent", { type: "link_sent", channel: "whatsapp", status: "sent-" + Math.min(links, 9999), ref: "wa-link-hour:" + h, link: "https://vendas.zevanory.api.br/solucoes" });
    }
  } catch { out.sections.whatsapp_error = 1; }
  // Database-backed commercial facts require the launch epoch (production orders only).
  let epoch; try { epoch = JSON.parse(String(await kv.get(LAUNCH_EPOCH_KV_KEY) || "null"))?.at; } catch {}
  const startedAt = Date.parse(String(epoch || ""));
  if (!Number.isFinite(startedAt) || startedAt > now) return { ...out, idle: "no_launch_epoch" };
  const since = new Date(startedAt).toISOString();
  const sql = sqlFactory(env.DATABASE_URL);
  // Delivery link issued and download completed (artifact_download_tokens).
  try {
    const rows = await sql.query(
      "select t.token_id::text as ref, (t.used_at is not null) as used from artifact_download_tokens t " +
      "join orders o on o.order_id=t.order_id where o.certification_pilot is false and o.created_at >= $1 " +
      "order by t.expires_at desc limit " + LIMIT, [since]);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!UUID.test(String(row?.ref || ""))) continue;
      await emit("delivery_sent", { type: "delivery_sent", channel: "delivery", status: "link-issued", ref: "delivery:" + row.ref });
      if (row.used === true) await emit("download_done", { type: "download_done", channel: "download", status: "done", ref: "download:" + row.ref });
    }
  } catch { out.sections.delivery_error = 1; }
  // Refund confirmed by the provider: financial, only with a current GET-proven
  // snapshot (same rule as payment_confirmed).
  try {
    const snapshot = await readFinancialProofSnapshot(env, { now });
    const measured = Date.parse(String(snapshot?.measured_at || ""));
    if (snapshot?.verified && Number.isFinite(measured)) {
      const rows = await sql.query(
        "select f.order_id::text as ref, max(f.received_at) as at from financial_events f join orders o on o.order_id=f.order_id " +
        "where f.provider='mercadopago' and f.normalized_event='refund_confirmed' and o.certification_pilot is false and o.created_at >= $1 " +
        "group by f.order_id order by max(f.received_at) desc limit " + LIMIT, [since]);
      for (const row of Array.isArray(rows) ? rows : []) {
        const at = Date.parse(String(row?.at || ""));
        if (!UUID.test(String(row?.ref || "")) || !Number.isFinite(at) || at > measured) continue;
        await emit("refund_approved", { type: "refund_approved", channel: "finance", status: "approved", ref: "refund:" + row.ref, financialProof: "provider-get-verified" });
      }
    }
  } catch { out.sections.refund_error = 1; }
  return out;
}
