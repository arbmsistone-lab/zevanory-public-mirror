// T3 (plan 3.1): runs the REAL SQL of worker/lead-magnet.mjs against a real PostgreSQL.
// Optional: skipped unless LEAD_PG_HOST is set (e.g. a throwaway local cluster), so CI without a
// database is unaffected. Uses psql; parameters are inlined as quoted literals for the test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { handleLeadMagnet, runLeadNurture, runLeadRetention, leadOptOutLink, subjectRef } from "../../worker/lead-magnet.mjs";

const HOST = process.env.LEAD_PG_HOST;
const PORT = process.env.LEAD_PG_PORT || "5432";
const DB = process.env.LEAD_PG_DB || "postgres";

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return "'{" + v.map((x) => (x === null ? "NULL" : '"' + String(x).replace(/["\\]/g, "\\$&") + '"')).join(",") + "}'";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function psql(sqlText) {
  const out = execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "--csv", "-c", sqlText], { encoding: "utf8" });
  const lines = out.trim().split("\n").filter(Boolean);
  if (!lines.length || /^(INSERT|UPDATE|DELETE|CREATE|ALTER) /.test(lines[0])) return [];
  const parse = (line) => { const cells = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ",") { cells.push(cur); cur = ""; } else cur += c; } cells.push(cur); return cells; };
  const [head, ...rows] = lines;
  const cols = parse(head);
  return rows.filter((r) => !/^(INSERT|UPDATE|DELETE) /.test(r)).map((r) => Object.fromEntries(parse(r).map((v, i) => [cols[i], v === "" ? null : v])));
}
const sqlFactory = () => ({ query: async (text, params = []) => psql(text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]))) });
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };

test("real PostgreSQL: existing production table (pre-T3 schema) is migrated in place, rows kept", { skip: !HOST && "LEAD_PG_HOST not set" }, async () => {
  psql("drop table if exists zevanory_leads; drop table if exists zevanory_lead_events;");
  // Exact pre-T3 DDL (gh-pages 82166477) with one legacy confirmed lead.
  psql(`create table zevanory_leads (email text primary key, email_hash text not null, name text, source text not null default 'material-gratuito',
    consent_version text not null, consent_at timestamptz not null, status text not null default 'pending', token_hash text, token_expires_at timestamptz,
    created_at timestamptz not null default now(), confirmed_at timestamptz, unsubscribed_at timestamptz, nurture_step integer not null default 0, nurture_at timestamptz);
    insert into zevanory_leads (email, email_hash, consent_version, consent_at, status, confirmed_at, nurture_step, nurture_at)
    values ('legado@x.com', 'h', 'lead-magnet-v1-2026-10-07', now() - interval '5 days', 'confirmed', now() - interval '5 days', 2, now() - interval '3 days');`);
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const env = { DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", ZEVANORY_PRIVATE_ARTIFACTS: kv() };
  const out = await runLeadNurture(env, { sqlFactory, salesOpen: false });
  assert.equal(out.ok, true);
  assert.equal(out.held, 1, "legacy lead within consent (step 2 = the offer) is held while sales are closed, not erased");
  assert.deepEqual(psql("select email, subject_ref from zevanory_leads"), [{ email: "legado@x.com", subject_ref: null }]);
  assert.ok(psql("select 1 from information_schema.tables where table_name='zevanory_lead_events'").length === 1);
});

test("real PostgreSQL: subscribe -> confirm -> cap -> revoke -> retention", { skip: !HOST && "LEAD_PG_HOST not set" }, async () => {
  // Same process: the module already created/migrated the schema in the previous test.
  psql("truncate zevanory_leads; truncate zevanory_lead_events;");
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  const store = kv();
  const env = { DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", ZEVANORY_PRIVATE_ARTIFACTS: store };
  const sub = (email) => handleLeadMagnet(new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify({ email, consent: true, page: "/calculadora-cmv" }) }), env, { sqlFactory });

  assert.equal((await sub("ana@exemplo.com")).status, 200);
  const token = sent[0].text.match(/confirmar\?t=([0-9a-f]{64})/)[1];
  assert.equal((await handleLeadMagnet(new Request(`https://zevanory.api.br/material-gratuito/confirmar?t=${token}`, { method: "POST" }), env, { sqlFactory })).status, 200);
  const ref = await subjectRef(env, "ana@exemplo.com");
  assert.deepEqual(psql("select status, subject_ref from zevanory_leads")[0], { status: "confirmed", subject_ref: ref });

  // Consent cap in SQL: a v1 lead at step 3 is closed by the bulk update.
  psql("update zevanory_leads set nurture_step=3, nurture_at=now() - interval '20 days'");
  const out = await runLeadNurture(env, { sqlFactory, salesOpen: true });
  assert.equal(out.sent, 0);
  assert.equal(psql("select nurture_step from zevanory_leads")[0].nurture_step, "5");
  assert.equal(out.retention.ok, true);

  // Revocation erases the row in SQL.
  const link = await leadOptOutLink(env, "ana@exemplo.com");
  assert.equal((await handleLeadMagnet(new Request(link, { method: "POST" }), env, { sqlFactory })).status, 200);
  assert.equal(psql("select count(*)::int n from zevanory_leads")[0].n, "0");

  // Retention in SQL: expired pending, legacy unsubscribed, inactive > 2 years; active kept.
  psql(`insert into zevanory_leads (email, email_hash, consent_version, consent_at, status, token_expires_at, nurture_at) values
    ('p@x.com','h1','lead-magnet-v1-2026-10-07', now(), 'pending', now() - interval '8 days', null),
    ('u@x.com','h2','lead-magnet-v1-2026-10-07', now(), 'unsubscribed', null, null),
    ('i@x.com','h3','lead-magnet-v1-2026-10-07', now() - interval '800 days', 'confirmed', null, now() - interval '731 days'),
    ('a@x.com','h4','lead-magnet-v1-2026-10-07', now(), 'confirmed', null, now() - interval '30 days')`);
  const r = await runLeadRetention(env, sqlFactory(), { force: true });
  assert.deepEqual([r.erased, r.erased_unconfirmed, r.erased_revoked, r.erased_inactive], [3, 1, 1, 1]);
  assert.deepEqual(psql("select email from zevanory_leads").map((x) => x.email), ["a@x.com"]);
  const events = psql("select subject_ref, event, consent_version from zevanory_lead_events order by id");
  assert.deepEqual(events.map((e) => e.event), ["consent_given", "confirmed", "revoked_and_erased", "erased_unconfirmed", "erased_revoked", "erased_inactive"]);
  assert.doesNotMatch(JSON.stringify(events), /@/, "no e-mail in the audit trail");
  const cols = psql("select column_name from information_schema.columns where table_name='zevanory_lead_events'").map((c) => c.column_name).sort();
  assert.deepEqual(cols, ["at", "consent_version", "event", "id", "subject_ref"], "no e-mail, name or IP column");
  psql("update zevanory_lead_events set at = now() - interval '731 days' where event='consent_given'");
  await runLeadRetention(env, sqlFactory(), { force: true });
  assert.equal(psql("select count(*)::int n from zevanory_lead_events where event='consent_given'")[0].n, "0", "event log pruned after 2 years");
});
