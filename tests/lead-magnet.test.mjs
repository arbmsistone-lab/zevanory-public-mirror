import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLeadMagnet, runLeadNurture, leadOptOutLink, nurtureEmail } from "../worker/lead-magnet.mjs";

// Minimal in-memory model of the zevanory_leads table driven by the module's SQL statements.
function fakeDb() {
  const rows = new Map();
  const query = async (text, params = []) => {
    if (/create table/i.test(text)) return [];
    if (/^select status, confirmed_at/i.test(text.trim())) { const r = rows.get(params[0]); return r ? [r] : []; }
    if (/^insert into zevanory_leads/i.test(text.trim())) {
      const [email, email_hash, name, consent_version, token_hash] = params;
      const prev = rows.get(email);
      rows.set(email, { ...(prev || { nurture_step: 0 }), email, email_hash, name, consent_version, token_hash, token_expires_at: Date.now() + 48 * 3600e3, status: prev?.status === "confirmed" ? "confirmed" : "pending" });
      return [];
    }
    if (/^update zevanory_leads set status='confirmed'/i.test(text.trim())) {
      for (const r of rows.values()) if (r.token_hash === params[0] && r.status === "pending" && r.token_expires_at > Date.now()) { Object.assign(r, { status: "confirmed", token_hash: null, nurture_step: 1, nurture_at: new Date().toISOString() }); return [{ email: r.email, name: r.name }]; }
      return [];
    }
    if (/^select email, name, nurture_step/i.test(text.trim())) return [...rows.values()].filter((r) => r.status === "confirmed" && r.nurture_step < 3 && Date.parse(r.nurture_at) < Date.now() - 2 * 86400e3);
    if (/set nurture_step=\$2/.test(text)) { rows.get(params[0]).nurture_step = params[1]; rows.get(params[0]).nurture_at = new Date().toISOString(); return []; }
    if (/set status='unsubscribed'/.test(text)) { for (const r of rows.values()) if (r.email_hash === params[0]) r.status = "unsubscribed"; return []; }
    if (/set nurture_step=3/.test(text)) { rows.get(params[0]).nurture_step = 3; return []; }
    throw new Error("unexpected sql: " + text.slice(0, 60));
  };
  return { rows, factory: () => ({ query }) };
}
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }; };
function mailbox() { const sent = []; globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }; return sent; }
const env = (store) => ({ DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", ZEVANORY_PRIVATE_ARTIFACTS: store });
const subscribeReq = (body) => new Request("https://leads.internal/subscribe", { method: "POST", body: JSON.stringify(body) });

test("public hosts cannot subscribe; consent and e-mail are mandatory", async () => {
  const db = fakeDb(); mailbox();
  assert.equal(await handleLeadMagnet(new Request("https://zevanory.api.br/subscribe", { method: "POST" }), env(kv()), { sqlFactory: db.factory }), null);
  assert.equal((await handleLeadMagnet(subscribeReq({ email: "a@b.com", consent: false }), env(kv()), { sqlFactory: db.factory })).status, 400);
  assert.equal((await handleLeadMagnet(subscribeReq({ email: "not-an-email", consent: true }), env(kv()), { sqlFactory: db.factory })).status, 400);
  assert.equal(db.rows.size, 0);
});

test("double opt-in: only the confirmation link (POST) starts the sequence", async () => {
  const db = fakeDb(); const sent = mailbox(); const store = kv();
  const res = await handleLeadMagnet(subscribeReq({ email: "Cliente@Empresa.com.br", name: "Ana", consent: true }), env(store), { sqlFactory: db.factory });
  assert.equal(res.status, 200);
  assert.equal(db.rows.get("cliente@empresa.com.br").status, "pending");
  assert.equal(sent.length, 1);
  const link = sent[0].text.match(/https:\/\/zevanory\.api\.br\/material-gratuito\/confirmar\?t=([0-9a-f]{64})/);
  assert.ok(link, "confirmation link present");
  const get = await handleLeadMagnet(new Request(link[0]), env(store), { sqlFactory: db.factory });
  assert.equal(get.status, 200);
  assert.equal(db.rows.get("cliente@empresa.com.br").status, "pending", "GET (mail scanners) never confirms");
  const post = await handleLeadMagnet(new Request(link[0], { method: "POST" }), env(store), { sqlFactory: db.factory });
  assert.equal(post.status, 200);
  assert.equal(db.rows.get("cliente@empresa.com.br").status, "confirmed");
  assert.match(sent[1].text, /checklist-15-minutos/);
  assert.match(sent[1].headers["List-Unsubscribe"], /material-gratuito\/sair/);
  const bridged = [...store.m.keys()].filter((k) => k.startsWith("zpc-activity:v1:lead:"));
  assert.equal(bridged.length, 1);
  assert.doesNotMatch(store.m.get(bridged[0]), /cliente@empresa/, "panel only sees masked e-mail");
  const reuse = await handleLeadMagnet(new Request(link[0], { method: "POST" }), env(store), { sqlFactory: db.factory });
  assert.equal(reuse.status, 400, "token is single-use");
});

test("nurture holds the catalog e-mail while sales are closed; opt-out stops everything", async () => {
  const db = fakeDb(); const sent = mailbox(); const store = kv();
  db.rows.set("x@y.com", { email: "x@y.com", email_hash: "", name: null, status: "confirmed", nurture_step: 2, nurture_at: new Date(Date.now() - 4 * 86400e3).toISOString() });
  const held = await runLeadNurture(env(store), { sqlFactory: db.factory, salesOpen: false });
  assert.equal(held.held, 1); assert.equal(sent.length, 0);
  const open = await runLeadNurture(env(store), { sqlFactory: db.factory, salesOpen: true });
  assert.equal(open.sent, 1); assert.match(sent[0].text, /R\$ 397/);
  const e = env(store);
  const link = new URL(await leadOptOutLink(e, "x@y.com"));
  db.rows.get("x@y.com").email_hash = link.searchParams.get("i");
  const out = await handleLeadMagnet(new Request(link.toString(), { method: "POST" }), e, { sqlFactory: db.factory });
  assert.equal(out.status, 200);
  assert.equal(db.rows.get("x@y.com").status, "unsubscribed");
});

test("nurture copy only uses catalog prices and the 7-day guarantee", () => {
  const text = nurtureEmail(2, { name: "", optOutUrl: "u" }).text;
  for (const m of text.matchAll(/R\$ (\d+)/g)) assert.ok([197, 247, 297, 397].includes(Number(m[1])));
  assert.match(text, /7 dias/);
});
