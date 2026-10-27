// Modelo em memória das consultas da lista de espera (worker/waitlist.mjs) e do provedor de e-mail (Resend:
// Idempotency-Key retida 24 h, 409 para a mesma chave com outro payload, modo "entrega e responde 500").
// Usado por tests/waitlist-m5.test.mjs e tests/waitlist-canonical-sales.test.mjs. A prova com PostgreSQL REAL está em
// tests/integration/waitlist-postgres.test.mjs.
export const H = 3600e3;
// Modelo em memória das tabelas da lista de espera, com o relógio do banco controlável (now).
export function db() {
  const st = { now: Date.parse("2026-11-02T12:00:00Z"), rows: [], notices: [], events: [], state: new Map(), failDelete: false, crashInAttempt: false, trace: [] };
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const query = async (raw, p = []) => {
    const s = norm(raw);
    if (/^create table/.test(s)) return [];
    if (s.startsWith("insert into zevanory_waitlist_state")) { if (!st.state.has("sales_open_since")) st.state.set("sales_open_since", st.now); return []; }
    if (s.startsWith("delete from zevanory_waitlist_state")) { st.state.delete("sales_open_since"); return []; }
    if (s.startsWith("select to_char(v at time zone 'UTC'")) { const v = st.state.get("sales_open_since"); return v == null ? [] : [{ stamp: new Date(v).toISOString().replace(/\D/g, "").slice(0, 14) }]; }
    if (s.startsWith("update zevanory_waitlist set status='confirmed', notify_claimed_at=null where status='notifying' and notify_claimed_at <")) {
      for (const r of st.rows) if (r.status === "notifying" && r.notify_claimed_at < st.now - H) Object.assign(r, { status: "confirmed", notify_claimed_at: null });
      return [];
    }
    if (s.startsWith("select email from zevanory_waitlist where status='confirmed' group by email")) {
      const by = new Map(); for (const r of st.rows) if (r.status === "confirmed") by.set(r.email, Math.min(by.get(r.email) ?? Infinity, r.confirmed_at));
      return [...by].sort((a, b) => a[1] - b[1]).slice(0, p[0]).map(([email]) => ({ email }));
    }
    if (s.startsWith("update zevanory_waitlist set status='notifying', notify_claimed_at=now() where email=$1 and status='confirmed' returning")) {
      return st.rows.filter((r) => r.email === p[0] && r.status === "confirmed").map((r) => (Object.assign(r, { status: "notifying", notify_claimed_at: st.now }), { product: r.product, subject_ref: r.subject_ref, consent_version: r.consent_version }));
    }
    if (s.startsWith("update zevanory_waitlist set status='confirmed', notify_claimed_at=null where email=$1 and status='notifying'")) {
      for (const r of st.rows) if (r.email === p[0] && r.status === "notifying") Object.assign(r, { status: "confirmed", notify_claimed_at: null });
      return [];
    }
    if (s.startsWith("delete from zevanory_waitlist where email=$1 and status='notifying' returning")) {
      if (st.failDelete) throw new Error("db_down");
      const gone = st.rows.filter((r) => r.email === p[0] && r.status === "notifying"); st.rows = st.rows.filter((r) => !gone.includes(r));
      return gone.map((r) => ({ product: r.product, consent_version: r.consent_version }));
    }
    const W = "where subject_ref=$1 and opening=$2 and notice_key=$3";
    const pick = (q) => st.notices.filter((n) => n.subject_ref === q[0] && n.opening === q[1] && n.notice_key === q[2]);
    const view = (n, h, m) => ({ ...n, stale: n.created_at < st.now - h * H, attempt_recent: n.attempt_at != null && n.attempt_at > st.now - m * 60e3 });
    if (s.startsWith("select notice_key, opening, products, subject, body, state, erasure,")) {
      if (s.includes("and opening=$5 and notice_key=$2")) return st.notices.filter((n) => n.subject_ref === p[0] && n.opening === p[4] && n.notice_key === p[1]).map((n) => view(n, p[2], p[3]));
      return st.notices.filter((n) => n.subject_ref === p[0] && (n.opening === p[1] || ["attempting", "unconfirmed"].includes(n.state))).sort((x, y) => x.created_at - y.created_at).map((n) => view(n, p[2], p[3]));
    }
    if (s.startsWith("insert into zevanory_waitlist_notices")) {
      if (!pick(p).length) st.notices.push({ subject_ref: p[0], opening: p[1], notice_key: p[2], products: p[3], subject: p[4], body: p[5], state: "unconfirmed", erasure: null, attempts: 0, attempt_at: null, created_at: st.now });
      return [];
    }
    if (s.startsWith("update zevanory_waitlist_notices set state='attempting'")) { for (const n of pick(p)) if (["attempting", "unconfirmed"].includes(n.state)) Object.assign(n, { state: "attempting", attempt_at: st.now, attempts: n.attempts + 1 }); st.trace.push("attempting"); if (st.crashInAttempt) throw new Error("crash_mid_attempt"); return []; }
    if (s.startsWith("update zevanory_waitlist_notices set state='unconfirmed'")) { for (const n of pick(p)) if (n.state === "attempting") n.state = "unconfirmed"; return []; }
    if (s.startsWith("update zevanory_waitlist_notices set state='confirmed'")) { for (const n of pick(p)) n.state = "confirmed"; return []; }
    if (s.startsWith("update zevanory_waitlist_notices set state='expired'")) { for (const n of pick(p)) if (["attempting", "unconfirmed"].includes(n.state)) n.state = "expired"; return []; }
    if (s.startsWith("update zevanory_waitlist_notices set erasure=$4")) { for (const n of pick(p)) n.erasure = p[3]; return []; }
    if (s.startsWith("update zevanory_waitlist_notices set erasure='confirmed' where subject_ref=$1")) { for (const n of st.notices) if (n.subject_ref === p[0]) n.erasure = "confirmed"; return []; }
    if (s.startsWith("update zevanory_waitlist set status='confirmed', notify_claimed_at=null where status='notifying' and email=$1")) { for (const r of st.rows) if (r.email === p[0] && r.status === "notifying") Object.assign(r, { status: "confirmed", notify_claimed_at: null }); return []; }
    void W;
    if (s.startsWith("insert into zevanory_waitlist_events")) { st.events.push({ subject_ref: p[0], product: p[1], event: p[2] }); return []; }
    if (["delete from zevanory_waitlist w where", "delete from zevanory_waitlist_events", "delete from zevanory_waitlist_notices"].some((x) => s.startsWith(x))) return []; // retenção (fora do escopo)
    throw new Error("consulta fora do modelo: " + s.slice(0, 120));
  };
  st.sqlFactory = () => ({ query });
  st.add = (email, product) => st.rows.push({ email, product, subject_ref: "ref-" + email, status: "confirmed", consent_version: "v", confirmed_at: st.now, notify_claimed_at: null });
  return st;
}
export function provider() {
  const pv = { clock: 0, keys: new Map(), inbox: [], calls: [], deliverThenFail: false };
  pv.fetchImpl = async (url, init) => {
    const key = init.headers["idempotency-key"]; const b = JSON.parse(init.body); const sig = b.subject + "|" + b.text;
    pv.calls.push({ key, to: b.to[0], sig });
    const prev = pv.keys.get(key);
    if (prev && pv.clock - prev.at < 24 * H) return prev.sig === sig ? new Response("{}", { status: 200 }) : new Response('{"name":"invalid_idempotent_request"}', { status: 409 });
    pv.keys.set(key, { sig, at: pv.clock }); pv.inbox.push({ to: b.to[0], text: b.text });
    return new Response("{}", { status: pv.deliverThenFail ? 500 : 200 });
  };
  return pv;
}
export const waitlistEnv = () => {
  const m = new Map();
  return { DATABASE_URL: "postgres://modelo", RESEND_API_KEY: "re_x", LEAD_PRIVACY_SECRET: "m".repeat(40), WAITLIST_ENABLED: "true",
    ZEVANORY_PRIVATE_ARTIFACTS: { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } } };
};
