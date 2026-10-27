// In-memory stand-in for the PostgreSQL refund state (worker/refund-state.mjs) used by unit tests.
// It reproduces the semantics of each statement: version compare-and-swap, "pending never
// replaces terminal", one event per transition, unique (order_id, version) and transition_key.
// Real PostgreSQL concurrency is covered by tests/integration/refund-auto-dispatch-postgres.test.mjs.
const TERMINAL = ["approved", "refunded"];

export function createRefundStateFake() {
  const rows = new Map();
  const events = [];
  const fake = { rows, events, down: false, failNextWrite: false, created: false };
  const event = (oid, version, from, to, a) => {
    const [manual_reason, actor, justification, evidence, transition_key] = a;
    if (transition_key && events.some((e) => e.transition_key === transition_key)) throw Error("duplicate transition_key");
    if (events.some((e) => e.order_id === oid && e.version === version)) throw Error("duplicate event version");
    events.push({ order_id: oid, version, from_status: from, to_status: to, manual_reason, actor, justification,
      evidence: evidence == null ? null : JSON.parse(evidence), transition_key, at: new Date().toISOString() });
  };
  fake.handle = (statement, args = []) => {
    const s = String(statement);
    if (s.startsWith("select to_regclass($1)") && /^refund_request/.test(String(args[0]))) {
      if (fake.down) throw Error("refund state store unavailable");
      return [{ t: fake.created ? args[0] : null }]; // catalog lookup: tables exist once created
    }
    if (!/refund_requests|refund_request_events/.test(s)) return undefined;
    if (fake.down) throw Error("refund state store unavailable");
    if (s.startsWith("create table if not exists refund_request")) { fake.created = true; return []; }
    if (s.startsWith("select version,status,record from refund_requests where order_id")) {
      const r = rows.get(args[0]);
      return r ? [{ version: r.version, status: r.status, record: structuredClone(r.record) }] : [];
    }
    if (s.startsWith("select version,status,record from refund_requests order by")) {
      return [...rows.values()].map((r) => ({ version: r.version, status: r.status, record: structuredClone(r.record) }));
    }
    if (s.startsWith("select version,from_status")) return events.filter((e) => e.order_id === args[0]).map((e) => ({ ...e }));
    if (fake.failNextWrite) { fake.failNextWrite = false; throw Error("injected refund state write failure"); }
    if (s.startsWith("with ins as (insert into refund_requests")) {
      const [oid, status, body, ...meta] = args;
      if (rows.has(oid)) return [];
      event(oid, 1, null, status, meta);
      rows.set(oid, { version: 1, status, record: JSON.parse(body) });
      return [{ version: 1 }];
    }
    if (s.startsWith("with prev as (select version,status from refund_requests")) {
      const [oid, expected, status, body, ...meta] = args;
      const r = rows.get(oid);
      if (!r || r.version !== Number(expected) || (TERMINAL.includes(r.status) && !TERMINAL.includes(status))) return [];
      event(oid, r.version + 1, r.status, status, meta);
      rows.set(oid, { version: r.version + 1, status, record: JSON.parse(body) });
      return [{ version: r.version + 1 }];
    }
    throw Error("refund state fake: unexpected statement " + s.slice(0, 80));
  };
  fake.get = (oid) => { const r = rows.get(oid); return r ? { ...r.record, status: r.status, version: r.version } : null; };
  // Overwrite the authoritative row directly (test setup only).
  fake.set = (oid, record) => { const r = rows.get(oid); rows.set(oid, { version: Number(record.version || r?.version || 1), status: record.status, record: { ...record } }); };
  return fake;
}
