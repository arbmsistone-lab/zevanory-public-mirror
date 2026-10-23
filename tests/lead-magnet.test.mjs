import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLeadMagnet, runLeadNurture, runLeadRetention, leadOptOutLink, nurtureEmail, subjectRef, CONSENT_FOLLOWUPS, RETENTION_MARKER } from "../worker/lead-magnet.mjs";
import { createHmac, createHash } from "node:crypto";
const V1 = "lead-magnet-v1-2026-10-07";
const sha256 = async (v) => createHash("sha256").update(v).digest("hex");

// Minimal in-memory model of the zevanory_leads / zevanory_lead_events tables driven by the module's SQL.
function fakeDb() {
  const rows = new Map();
  const events = [];
  const queries = [];
  const DAY = 86400e3;
  const query = async (text, params = []) => {
    const t = text.trim();
    queries.push(t);
    if (/^create table|^alter table/i.test(t)) return [];
    if (/^select status, confirmed_at/i.test(t)) { const r = rows.get(params[0]); return r ? [r] : []; }
    if (/^insert into zevanory_leads/i.test(t)) {
      const [email, email_hash, name, consent_version, token_hash, subject_ref] = params;
      const prev = rows.get(email);
      rows.set(email, { ...(prev || { nurture_step: 0 }), email, email_hash, name, consent_version, token_hash, subject_ref: prev?.subject_ref ?? subject_ref, consent_at: Date.now(), token_expires_at: Date.now() + 48 * 3600e3, status: prev?.status === "confirmed" ? "confirmed" : "pending" });
      return [];
    }
    if (/^insert into zevanory_lead_events \(subject_ref, event, consent_version\) values/i.test(t)) { events.push({ subject_ref: params[0], event: params[1], consent_version: params[2], at: Date.now() }); return []; }
    if (/^insert into zevanory_lead_events .* unnest/i.test(t)) { params[0].forEach((ref, i) => events.push({ subject_ref: ref, event: params[1][i], consent_version: params[2][i], at: Date.now() })); return []; }
    if (/^update zevanory_leads set status='confirmed'/i.test(t)) {
      for (const r of rows.values()) if (r.token_hash === params[0] && r.status === "pending" && r.token_expires_at > Date.now()) { Object.assign(r, { status: "confirmed", token_hash: null, nurture_step: 1, nurture_at: new Date().toISOString() }); return [{ email: r.email, name: r.name, subject_ref: r.subject_ref, consent_version: r.consent_version }]; }
      return [];
    }
    if (/^update zevanory_leads set nurture_step=\$1 where status='confirmed' and consent_version=\$2/i.test(t)) {
      for (const r of rows.values()) if (r.status === "confirmed" && r.consent_version === params[1] && r.nurture_step >= params[2] && r.nurture_step < params[0]) r.nurture_step = params[0];
      return [];
    }
    if (/^select email, name, nurture_step/i.test(t)) return [...rows.values()].filter((r) => r.status === "confirmed" && r.nurture_step < params[0] && Date.parse(r.nurture_at) < Date.now() - 2 * DAY);
    if (/^update zevanory_leads set nurture_step=\$2, nurture_at=now\(\) where email=\$1 and status='confirmed' and nurture_step=\$3 returning email/.test(t)) {
      hooks.beforeClaim?.(params[0]);
      const r = rows.get(params[0]);
      if (!r || r.status !== "confirmed" || r.nurture_step !== params[2]) return [];
      r.nurture_step = params[1]; r.nurture_at = new Date().toISOString(); return [{ email: r.email }];
    }
    if (/^update zevanory_leads set nurture_step=\$2 where email=\$1 and nurture_step=\$3/.test(t)) { const r = rows.get(params[0]); if (r && r.nurture_step === params[2]) r.nurture_step = params[1]; return []; }
    if (/^select distinct p.subject_ref from zevanory_lead_events p/.test(t)) {
      const out = new Set();
      for (const e of events) if (e.event === "erase_kv_pending" && e.subject_ref && !events.some((d) => d.subject_ref === e.subject_ref && d.event === "erase_kv_done" && d.at >= e.at)) out.add(e.subject_ref);
      return [...out].map((subject_ref) => ({ subject_ref }));
    }
    if (/set nurture_step=\$2 where email=\$1/.test(t)) { const r = rows.get(params[0]); if (r && r.nurture_step < params[1]) r.nurture_step = params[1]; return []; }
    if (/^delete from zevanory_leads where (subject_ref|email_hash)=\$1/i.test(t)) {
      const col = t.match(/where (subject_ref|email_hash)=/)[1];
      const out = [];
      for (const [k, r] of rows) if (r[col] === params[0]) { out.push({ email: r.email, subject_ref: r.subject_ref, consent_version: r.consent_version }); rows.delete(k); }
      return out;
    }
    if (/^delete from zevanory_leads where email in/i.test(t)) {
      const [grace, inactive, limit, done, endGrace] = params;
      const due = [...rows.values()].filter((r) => (r.status === "pending" && r.token_expires_at < Date.now() - grace * DAY) || r.status === "unsubscribed" ||
        (r.status === "confirmed" && r.nurture_step >= done && Date.parse(r.nurture_at) < Date.now() - endGrace * DAY) ||
        (r.status === "confirmed" && Date.parse(r.nurture_at || r.confirmed_at || r.consent_at) < Date.now() - inactive * DAY)).slice(0, limit);
      for (const r of due) rows.delete(r.email);
      return due.map((r) => ({ email: r.email, subject_ref: r.subject_ref, consent_version: r.consent_version, status: r.status, nurture_step: r.nurture_step }));
    }
    if (/^delete from zevanory_lead_events where at </i.test(t)) { for (let i = events.length - 1; i >= 0; i--) if (events[i].at < Date.now() - params[0] * DAY) events.splice(i, 1); return []; }
    throw new Error("unexpected sql: " + t.slice(0, 60));
  };
  const hooks = {};
  return { rows, events, queries, hooks, factory: () => ({ query }) };
}
const kv = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; };
function mailbox() { const sent = []; globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }; return sent; }
const KEY_A = "a".repeat(40), KEY_B = "b".repeat(40);
const env = (store, extra = {}) => ({ DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", LEAD_PRIVACY_SECRET: KEY_A, ZEVANORY_PRIVATE_ARTIFACTS: store, ...extra });
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

test("nurture holds the catalog e-mail while sales are closed; opt-out stops everything and erases the lead", async () => {
  const db = fakeDb(); const sent = mailbox(); const store = kv();
  const e = env(store);
  const ref = await subjectRef(e, "x@y.com");
  db.rows.set("x@y.com", { email: "x@y.com", email_hash: "", subject_ref: ref, name: "Ana", consent_version: V1, status: "confirmed", nurture_step: 2, nurture_at: new Date(Date.now() - 6 * 86400e3).toISOString() });
  store.m.set("zpc:lead:interest:" + ref, "ia");
  const held = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: false });
  assert.equal(held.held, 1); assert.equal(sent.length, 0);
  const open = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(open.sent, 1); assert.match(sent[0].text, /IA na Prática \(R\$ 197/); assert.match(sent[0].text, /utm_source=email/);
  const link = new URL(await leadOptOutLink(e, "x@y.com", ref));
  assert.equal(link.searchParams.get("r"), ref, "new links carry the stored keyed reference, not a plain hash");
  assert.notEqual(link.searchParams.get("r"), await sha256("x@y.com"));
  const get = await handleLeadMagnet(new Request(link.toString()), e, { sqlFactory: db.factory });
  assert.equal(get.status, 200); assert.ok(db.rows.has("x@y.com"), "GET never erases (mail scanners)");
  const out = await handleLeadMagnet(new Request(link.toString(), { method: "POST" }), e, { sqlFactory: db.factory });
  assert.equal(out.status, 200);
  assert.equal(db.rows.has("x@y.com"), false, "revocation erases e-mail and name");
  assert.equal(store.m.has("zpc:lead:interest:" + ref), false, "interest key erased");
  assert.deepEqual(db.events.map((x) => x.event), ["revoked_and_erased"]);
  assert.equal(db.events[0].subject_ref, ref);
  assert.doesNotMatch(JSON.stringify(db.events), /@|Ana/, "audit trail has no e-mail or name");
});

test("nurture copy only uses catalog prices and the single 7-day rule (open sales only)", () => {
  assert.doesNotMatch(nurtureEmail(1, { name: "", optOutUrl: "u" }).text, /vendas-na-pratica|R\$/);
  const text = nurtureEmail(2, { name: "", optOutUrl: "u", salesOpen: true }).text;
  for (const m of text.matchAll(/R\$ (\d+)/g)) assert.ok([197, 247, 297, 397].includes(Number(m[1])));
  assert.ok(text.includes(CUSTOMER_RULE_7D) && text.includes(DELIVERY_72H), "regra e entrega da política única");
  assert.deepEqual(bannedPolicyHits(text), []);
});

import { interestFromPage, NURTURE_DONE } from "../worker/lead-magnet.mjs";
import { CUSTOMER_RULE_7D, DELIVERY_72H, bannedPolicyHits, hasCheckoutCta } from "../worker/politica-unica.mjs";
test("the offer matches what the lead was reading and the sequence ends", () => {
  assert.equal(interestFromPage("/calculadora-margem-de-lucro"), "caixa");
  assert.equal(interestFromPage("/vendas-na-pratica"), "vendas");
  assert.equal(interestFromPage("/ia-para-padaria"), "ia");
  assert.match(nurtureEmail(2, { name: "", optOutUrl: "u", interest: "caixa", salesOpen: true }).text, /Lucro & Caixa \(R\$ 247/);
  const last = nurtureEmail(4, { name: "", optOutUrl: "u", salesOpen: true }).text;
  assert.match(last, /último e-mail/i); assert.match(last, /R\$ 397/); assert.ok(last.includes(CUSTOMER_RULE_7D));
  for (let s = 0; s < NURTURE_DONE; s++) {
    const t = nurtureEmail(s, { name: "", optOutUrl: "OPTOUT", salesOpen: true }).text;
    assert.match(t, /OPTOUT/);
    assert.deepEqual(bannedPolicyHits(t), [], "step " + s);
    for (const m of t.matchAll(/R\$ (\d+)/g)) assert.ok([197, 247, 297, 397, 641].includes(Number(m[1])), m[0]);
  }
});

test("P13c: com vendas fechadas (padrão) nenhum e-mail de nutrição tem oferta ou chamada de compra", () => {
  for (let s = 0; s < NURTURE_DONE; s++) {
    for (const opts of [{}, { salesOpen: false }, { salesOpen: "true" }]) {
      const mail = nurtureEmail(s, { name: "", optOutUrl: "u", ...opts });
      if (s >= 2) { assert.equal(mail, null, `passo ${s} fechado não monta oferta`); continue; }
      assert.equal(hasCheckoutCta(mail.text + mail.subject), false, "passo " + s);
      assert.doesNotMatch(mail.text, /R\$ \d/, "sem preço com vendas fechadas: passo " + s);
    }
  }
});

test("consent v1 allows the checklist + 2 e-mails: the sequence stops there, in one query", async () => {
  assert.equal(CONSENT_FOLLOWUPS[V1], 2);
  const db = fakeDb(); const sent = mailbox(); const store = kv(); const e = env(store);
  const old = new Date(Date.now() - 20 * 86400e3).toISOString();
  for (const [email, step] of [["a@x.com", 3], ["b@x.com", 4], ["c@x.com", 1]]) db.rows.set(email, { email, email_hash: "", subject_ref: await subjectRef(e, email), name: null, consent_version: V1, status: "confirmed", nurture_step: step, nurture_at: old });
  const out = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(out.sent, 1, "only the lead still within its consent receives an e-mail");
  assert.match(sent[0].subject, /hábitos/);
  assert.equal(db.rows.get("a@x.com").nurture_step, 5); assert.equal(db.rows.get("b@x.com").nurture_step, 5);
  assert.equal(db.queries.filter((q) => /consent_version=\$2/.test(q)).length, 1, "bulk cap, not one query per lead");
  // c@x.com: step 1 sent (tips) -> 2; then offer (step 2) -> 3; then nothing more.
  db.rows.get("c@x.com").nurture_at = old;
  await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  db.rows.get("c@x.com").nurture_at = old;
  const after = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(sent.length, 2 + 0 + (after.sent || 0)); assert.equal(after.sent, 0);
  assert.equal(db.rows.get("c@x.com").nurture_step, 5);
  assert.equal(sent.filter((m) => m.to[0] === "c@x.com").length, 2, "checklist (sent at confirmation) + exactly 2 follow-ups");
});

test("legacy opt-out links already sent keep working; forged tokens never erase", async () => {
  const db = fakeDb(); mailbox(); const store = kv(); const e = env(store);
  const id = await sha256("old@y.com");
  db.rows.set("old@y.com", { email: "old@y.com", email_hash: id, subject_ref: null, name: null, consent_version: V1, status: "confirmed", nurture_step: 2 });
  store.m.set("zpc:lead:interest:" + id, "caixa");
  const forged = await handleLeadMagnet(new Request(`https://zevanory.api.br/material-gratuito/sair?i=${id}&t=${"0".repeat(32)}`, { method: "POST" }), e, { sqlFactory: db.factory });
  assert.equal(forged.status, 400); assert.ok(db.rows.has("old@y.com"));
  const legacyToken = createHmac("sha256", "zevanory-lead-optout-v1:" + e.RESEND_API_KEY).update(id).digest("hex").slice(0, 32);
  const ok = await handleLeadMagnet(new Request(`https://zevanory.api.br/material-gratuito/sair?i=${id}&t=${legacyToken}`, { method: "POST" }), e, { sqlFactory: db.factory });
  assert.equal(ok.status, 200);
  assert.equal(db.rows.has("old@y.com"), false);
  assert.equal(store.m.has("zpc:lead:interest:" + id), false, "legacy interest key erased too");
  assert.equal(db.events[0].event, "revoked_and_erased");
  assert.notEqual(db.events[0].subject_ref, id, "events never store the plain hash");
});

test("retention erases unconfirmed, revoked, sequence-ended (30 days) and inactive leads once a day, with bounded queries and no e-mail in the audit", async () => {
  const db = fakeDb(); mailbox(); const store = kv(); const e = env(store);
  const D = 86400e3, ago = (d) => new Date(Date.now() - d * D).toISOString();
  const add = async (email, extra) => db.rows.set(email, { email, email_hash: await sha256(email), subject_ref: await subjectRef(e, email), name: "Nome", consent_version: V1, nurture_step: 0, ...extra });
  await add("pend-old@x.com", { status: "pending", token_expires_at: Date.now() - 8 * D });
  await add("pend-new@x.com", { status: "pending", token_expires_at: Date.now() - 2 * D });
  await add("unsub@x.com", { status: "unsubscribed" });
  await add("inactive@x.com", { status: "confirmed", nurture_at: ago(731) });
  await add("active@x.com", { status: "confirmed", nurture_step: 2, nurture_at: ago(30) });
  await add("ended@x.com", { status: "confirmed", nurture_step: 5, nurture_at: ago(31) });
  await add("ended-recent@x.com", { status: "confirmed", nurture_step: 5, nurture_at: ago(10) });
  const sql = db.factory();
  const before = db.queries.length;
  const out = await runLeadRetention(e, sql);
  assert.deepEqual([out.erased, out.erased_unconfirmed, out.erased_revoked, out.erased_inactive, out.erased_sequence_ended], [4, 1, 1, 1, 1]);
  assert.deepEqual([...db.rows.keys()].sort(), ["active@x.com", "ended-recent@x.com", "pend-new@x.com"]);
  assert.ok(db.queries.slice(before).filter((q) => !/^create|^alter/i.test(q)).length <= 4, "bounded external subrequests");
  assert.equal(db.events.length, 4);
  assert.doesNotMatch(JSON.stringify(db.events), /@|Nome/);
  for (const ev of db.events) assert.match(ev.subject_ref, /^[0-9a-f]{64}$/);
  assert.equal(store.m.get(RETENTION_MARKER), new Date().toISOString().slice(0, 10));
  assert.equal((await runLeadRetention(e, sql)).skipped, "already_ran_today");
  db.events.push({ subject_ref: "x", event: "old", at: Date.now() - 800 * D });
  await runLeadRetention(e, sql, { force: true });
  assert.equal(db.events.some((x) => x.event === "old"), false, "event log pruned after the retention period");
});

test("subscribe stores keyed references only; without a privacy key no identifier is derived", async () => {
  const db = fakeDb(); mailbox(); const store = kv();
  await handleLeadMagnet(subscribeReq({ email: "Novo@Empresa.com", consent: true }), env(store), { sqlFactory: db.factory });
  const plain = await sha256("novo@empresa.com");
  for (const [k, v] of store.m) { assert.ok(!k.includes(plain), "KV key " + k); assert.ok(!String(v).includes(plain) && !String(v).includes("novo@"), "KV value"); }
  assert.deepEqual(db.events.map((x) => [x.event, x.consent_version]), [["consent_given", V1]]);
  const db2 = fakeDb(); const store2 = kv();
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const noKey = { DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", ZEVANORY_PRIVATE_ARTIFACTS: store2 };
  assert.equal(await subjectRef(noKey, "a@b.com"), null, "never derived from the e-mail provider key");
  assert.match(await leadOptOutLink(noKey, "a@b.com"), /sair\?i=[0-9a-f]{64}&t=[0-9a-f]{32}$/, "without the key, unsubscribe keeps working (legacy link)");
  await handleLeadMagnet(subscribeReq({ email: "a@b.com", consent: true }), noKey, { sqlFactory: db2.factory }).catch(() => null);
  assert.equal(db2.events[0]?.subject_ref ?? null, null);
  assert.equal([...store2.m.keys()].some((k) => k.startsWith("zpc:lead:interest:")), false);
});

test("key rotation: links sent before keep working; the row identity never changes", async () => {
  const db = fakeDb(); const sent = mailbox(); const store = kv();
  const eA = env(store);
  await handleLeadMagnet(subscribeReq({ email: "rot@x.com", consent: true }), eA, { sqlFactory: db.factory });
  const stored = db.rows.get("rot@x.com").subject_ref;
  const oldLink = await leadOptOutLink(eA, "rot@x.com", stored);
  // Rotation: B becomes current, A stays as previous.
  const eB = env(store, { LEAD_PRIVACY_SECRET: KEY_B, LEAD_PRIVACY_SECRET_PREVIOUS: KEY_A });
  const newLink = new URL(await leadOptOutLink(eB, "rot@x.com", stored));
  assert.equal(newLink.searchParams.get("r"), stored, "new links still point to the stored reference");
  assert.notEqual(newLink.searchParams.get("t"), new URL(oldLink).searchParams.get("t"), "signed with the new key");
  // Re-subscribing does not replace the stored identity.
  await handleLeadMagnet(subscribeReq({ email: "rot@x.com", consent: true }), eB, { sqlFactory: db.factory });
  assert.equal(db.rows.get("rot@x.com").subject_ref, stored);
  const res = await handleLeadMagnet(new Request(oldLink, { method: "POST" }), eB, { sqlFactory: db.factory });
  assert.equal(res.status, 200, "a link signed with the previous key still revokes");
  assert.equal(db.rows.has("rot@x.com"), false);
  // After PREVIOUS is removed, old tokens stop being accepted (documented end of the rotation).
  const eOnlyB = env(store, { LEAD_PRIVACY_SECRET: KEY_B });
  db.rows.set("rot2@x.com", { email: "rot2@x.com", email_hash: "z", subject_ref: stored, consent_version: V1, status: "confirmed", nurture_step: 1 });
  assert.equal((await handleLeadMagnet(new Request(oldLink, { method: "POST" }), eOnlyB, { sqlFactory: db.factory })).status, 400);
});

test("KV failure during erasure: the answer says so, the residual is queued and retried", async () => {
  const db = fakeDb(); mailbox(); const store = kv(); const e = env(store);
  const ref = await subjectRef(e, "kv@x.com");
  db.rows.set("kv@x.com", { email: "kv@x.com", email_hash: "h", subject_ref: ref, consent_version: V1, status: "confirmed", nurture_step: 2 });
  store.m.set("zpc:lead:interest:" + ref, "caixa");
  const realDelete = store.delete; store.delete = async () => { throw new Error("kv down"); };
  const res = await handleLeadMagnet(new Request(await leadOptOutLink(e, "kv@x.com", ref), { method: "POST" }), e, { sqlFactory: db.factory });
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(db.rows.has("kv@x.com"), false, "e-mail and name erased");
  assert.match(body, /não pôde ser apagado agora/, "the person is told about the residual");
  assert.ok(db.events.some((x) => x.event === "erase_kv_pending" && x.subject_ref === ref));
  assert.ok(store.m.has("zpc:lead:interest:" + ref), "residual still there");
  store.delete = realDelete;
  const out = await runLeadRetention(e, db.factory(), { force: true });
  assert.equal(out.kv_retried, 1);
  assert.equal(store.m.has("zpc:lead:interest:" + ref), false, "retried and erased");
  assert.ok(db.events.some((x) => x.event === "erase_kv_done" && x.subject_ref === ref));
  assert.equal((await runLeadRetention(e, db.factory(), { force: true })).kv_retried, 0, "not retried again once done");
  // Without residuals the answer has no residual note.
  db.rows.set("ok@x.com", { email: "ok@x.com", email_hash: "h2", subject_ref: await subjectRef(e, "ok@x.com"), consent_version: V1, status: "confirmed", nurture_step: 2 });
  const ok = await handleLeadMagnet(new Request(await leadOptOutLink(e, "ok@x.com", db.rows.get("ok@x.com").subject_ref), { method: "POST" }), e, { sqlFactory: db.factory });
  assert.doesNotMatch(await ok.text(), /não pôde/);
});

test("revocation between selection and sending: nothing is sent", async () => {
  const db = fakeDb(); const sent = mailbox(); const store = kv(); const e = env(store);
  const old = new Date(Date.now() - 20 * 86400e3).toISOString();
  for (const email of ["stays@x.com", "leaves@x.com"]) db.rows.set(email, { email, email_hash: "h-" + email, subject_ref: await subjectRef(e, email), consent_version: V1, status: "confirmed", nurture_step: 1, nurture_at: old });
  // The person revokes right after the batch was selected, before the claim/send.
  db.hooks.beforeClaim = (email) => { if (email === "leaves@x.com") db.rows.delete("leaves@x.com"); };
  const out = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(out.sent, 1); assert.equal(out.skipped_revoked, 1);
  assert.deepEqual(sent.map((m) => m.to[0]), ["stays@x.com"]);
});

test("a failed send releases the claim so the step is retried later", async () => {
  const db = fakeDb(); const store = kv(); const e = env(store);
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  db.rows.set("f@x.com", { email: "f@x.com", email_hash: "h", subject_ref: await subjectRef(e, "f@x.com"), consent_version: V1, status: "confirmed", nurture_step: 1, nurture_at: new Date(Date.now() - 20 * 86400e3).toISOString() });
  const out = await runLeadNurture(e, { sqlFactory: db.factory, salesOpen: true });
  assert.equal(out.sent, 0);
  assert.equal(db.rows.get("f@x.com").nurture_step, 1);
});

test("the published privacy policy states exactly the retention the code enforces", async () => {
  const { readFileSync } = await import("node:fs");
  const lm = await import("../worker/lead-magnet.mjs");
  const backup = readFileSync(new URL("../worker/data-backup.mjs", import.meta.url), "utf8");
  for (const f of ["../privacidade/index.html", "../sales-public/privacidade.html"]) {
    const page = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(page, new RegExp(`pedidos não confirmados, até ${2 + lm.PENDING_GRACE_DAYS} dias`), f + ": 48 h link + grace"); // 2 days link validity + grace
    assert.match(page, new RegExp(`até ${lm.SEQUENCE_END_GRACE_DAYS} dias depois do fim da sequência`), f);
    assert.match(page, /até 2 e-mails de dicas e produtos/, f + ": consent text");
    assert.equal(lm.CONSENT_FOLLOWUPS["lead-magnet-v1-2026-10-07"], 2);
    assert.match(page, new RegExp(`por até ${lm.DEFAULT_EVENT_RETENTION_DAYS / 365} anos, para comprovar o consentimento`), f);
    assert.match(page, /cópias de segurança feitas pela ZEVANORY expiram automaticamente em até 8 dias/, f);
  }
  assert.match(backup, /expirationTtl: 8 \* DAY/, "table copies expire in 8 days (KV TTL)");
  assert.doesNotMatch(backup, /"zpc:lead:interest:"/, "lead data not in the KV->Neon copy");
});
