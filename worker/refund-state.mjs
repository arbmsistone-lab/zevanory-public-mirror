// Authoritative state of refund requests created by the automatic (ON) flow.
// PostgreSQL is the source of truth: every transition is one atomic statement with a version
// compare-and-swap and an append-only event row (unique per order/version and per transition key).
// Cloudflare KV only keeps a cache copy for the legacy readers; losing, delaying or failing a KV
// write never changes a business decision, because every decision reads and writes here.
// Records of the legacy (OFF) flow keep their pre-PR storage in KV. With the flag OFF these tables are
// never written nor created, and are only read once ON-created state is known to exist (KV marker).
const DDL = [
  "create table if not exists refund_requests (order_id uuid primary key, version integer not null check (version > 0), status text not null, record jsonb not null, updated_at timestamptz not null default now())",
  "create table if not exists refund_request_events (id bigserial primary key, order_id uuid not null, version integer not null, from_status text, to_status text not null, manual_reason text, actor text not null, justification text, evidence jsonb, transition_key text unique, at timestamptz not null default now(), unique (order_id, version))",
];
export const TERMINAL = ["approved", "refunded"];
const isTerminal = (status) => TERMINAL.includes(status);

// Concurrent first use: two "create table if not exists" may race on the catalog (duplicate key
// on pg_type, 23505/42P07). The loser checks that the table now exists instead of failing (L-4).
export async function idempotentDdl(sql, ddl, table) {
  try { await sql.query(ddl); }
  catch (error) {
    let exists = false;
    try { exists = Boolean((await sql.query("select to_regclass($1) as t", [table]))[0]?.t); } catch {}
    if (!exists) throw error;
  }
}
const ensured = new WeakSet(); // per SQL client: skip repeated DDL once the tables are known to exist
export async function ensureRefundState(sql) {
  if (sql && typeof sql === "object" && ensured.has(sql)) return;
  await idempotentDdl(sql, DDL[0], "refund_requests");
  await idempotentDdl(sql, DDL[1], "refund_request_events");
  if (sql && typeof sql === "object") ensured.add(sql);
}

const fromRow = (row) => row ? { ...(typeof row.record === "string" ? JSON.parse(row.record) : row.record),
  status: row.status, version: Number(row.version) } : null;

export async function getRefundState(sql, oid, { ensure = true } = {}) {
  if (ensure) await ensureRefundState(sql);
  return fromRow((await sql.query("select version,status,record from refund_requests where order_id=$1::uuid", [oid]))[0]);
}

export async function listRefundStates(sql, { ensure = true } = {}) {
  if (ensure) await ensureRefundState(sql);
  return (await sql.query("select version,status,record from refund_requests order by updated_at desc", [])).map(fromRow);
}

export async function listRefundEvents(sql, oid) {
  await ensureRefundState(sql);
  return sql.query("select version,from_status,to_status,manual_reason,actor,justification,evidence,transition_key,at from refund_request_events where order_id=$1::uuid order by version asc", [oid]);
}

// One atomic statement: the row moves from expectedVersion to expectedVersion+1 (or is created at 1)
// and the event is recorded in the same statement. A pending copy can never replace a terminal row.
// Returns the new version, or 0 when another writer won (the caller re-reads and decides).
export async function casRefundState(sql, record, expectedVersion, { actor = "system", justification = null, evidence = null, transitionKey = null } = {}) {
  await ensureRefundState(sql);
  const next = Number(expectedVersion || 0) + 1;
  const body = JSON.stringify({ ...record, version: next });
  const meta = [record.manual_reason ?? null, String(actor), justification, evidence == null ? null : JSON.stringify(evidence), transitionKey];
  if (!expectedVersion) {
    const rows = await sql.query(
      "with ins as (insert into refund_requests (order_id,version,status,record) values ($1::uuid,1,$2,$3::jsonb) on conflict (order_id) do nothing returning order_id,version,status), " +
      "ev as (insert into refund_request_events (order_id,version,from_status,to_status,manual_reason,actor,justification,evidence,transition_key) " +
      "select order_id,version,null,status,$4,$5,$6,$7::jsonb,$8 from ins) select version from ins",
      [record.order_id, record.status, body, ...meta]);
    return rows.length ? 1 : 0;
  }
  const rows = await sql.query(
    "with prev as (select version,status from refund_requests where order_id=$1::uuid), " +
    "upd as (update refund_requests r set version=r.version+1,status=$3,record=$4::jsonb,updated_at=now() from prev " +
    "where r.order_id=$1::uuid and r.version=$2 and not (prev.status in ('approved','refunded') and $3 not in ('approved','refunded')) " +
    "returning r.order_id,r.version,r.status,prev.status as from_status), " +
    "ev as (insert into refund_request_events (order_id,version,from_status,to_status,manual_reason,actor,justification,evidence,transition_key) " +
    "select order_id,version,from_status,status,$5,$6,$7,$8::jsonb,$9 from upd) select version from upd",
    [record.order_id, Number(expectedVersion), record.status, body, ...meta]);
  return rows.length ? next : 0;
}

// Compare-and-swap with the merge rules for concurrent writers. A provider-confirmed terminal
// state always wins over a newer non-terminal copy (keeping that writer's delivered markers);
// a non-terminal copy never replaces a terminal row; two non-terminal writers: the stale one loses.
const DELIVERED = ["customer_email_pending", "approved_email_pending", "download_revocation_pending", "decision_email_pending"];
export async function writeRefundState(sql, record, meta = {}) {
  let expected = Number(record.version || 0);
  for (let attempt = 0; attempt < 5; attempt++) {
    const version = await casRefundState(sql, record, expected, meta);
    if (version) { record.version = version; return true; }
    const stored = await getRefundState(sql, record.order_id);
    if (!stored) { if (expected === 0) return false; expected = 0; continue; }
    if (isTerminal(stored.status) && !isTerminal(record.status)) return false;
    if (!isTerminal(record.status)) return false;
    for (const k of DELIVERED) if (stored[k] === false && record[k] === true) record[k] = false;
    if (Array.isArray(stored.identity_hashes)) record.identity_hashes = stored.identity_hashes;
    if (Array.isArray(stored.history)) record.history = stored.history;
    expected = stored.version;
  }
  return false;
}
