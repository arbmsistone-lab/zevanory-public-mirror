import { test } from "node:test";
import assert from "node:assert/strict";
import { readSalesSwitch, resetSalesSwitchCache, applySalesSwitch, handleSalesControl, validOwnerAuthorization } from "../worker/sales-control.mjs";
const AUTH = () => ({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner", at: new Date().toISOString(), ref: "github:issue-comment:123456" });

const kv = (map = {}) => ({ async get(k) { return map[k] ?? null; }, async put(k, v) { map[k] = v; } });

test("sales stay closed unless the owner switch says enabled:true", async () => {
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv() })).enabled, false);
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": "garbage" }) })).enabled, false);
  resetSalesSwitchCache();
  // Switch alone is not enough: production preflight must be green and fresh.
  const blocked = await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(AUTH()) }) });
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.blocked, "preflight_not_green");
  resetSalesSwitchCache();
  const stale = JSON.stringify({ ok: true, at: new Date(Date.now() - 4 * 3600e3).toISOString(), checks: [] });
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(AUTH()), "zpc-sales-preflight:v1": stale }) })).enabled, false);
  resetSalesSwitchCache();
  const red = JSON.stringify({ ok: false, at: new Date().toISOString(), checks: [] });
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(AUTH()), "zpc-sales-preflight:v1": red }) })).enabled, false);
  resetSalesSwitchCache();
  const green = JSON.stringify({ ok: true, at: new Date().toISOString(), checks: [] });
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(AUTH()), "zpc-sales-preflight:v1": green }) })).enabled, true);
  assert.equal(applySalesSwitch({ enabled: true }), true);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, true);
  assert.equal(applySalesSwitch({ enabled: false }), false);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, false);
  resetSalesSwitchCache();
});

test("an incomplete owner authorization never opens sales, even with a green preflight", async () => {
  const green = JSON.stringify({ ok: true, at: new Date().toISOString(), checks: [] });
  const base = AUTH();
  const variants = [
    { ...base, authorization: undefined }, { ...base, authorization: "liberar vendas" }, { ...base, authorization: "AUTORIZO COMPRA REAL" },
    { ...base, by: "" }, { ...base, by: undefined }, { ...base, ref: "" }, { ...base, ref: undefined }, { ...base, ref: "x" },
    { ...base, at: "" }, { ...base, at: "not-a-date" }, { ...base, at: new Date(Date.now() + 3600e3).toISOString() },
    { ...base, enabled: "true" }, { enabled: true }, { enabled: true, by: "owner" }
  ];
  for (const record of variants) {
    assert.equal(validOwnerAuthorization(record), false, JSON.stringify(record));
    resetSalesSwitchCache();
    const out = await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(record), "zpc-sales-preflight:v1": green }) });
    assert.equal(out.enabled, false, JSON.stringify(record));
    if (record.enabled === true) assert.equal(out.blocked, "owner_authorization_incomplete");
  }
  assert.equal(validOwnerAuthorization(base), true);
  resetSalesSwitchCache();
  const open = await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify(base), "zpc-sales-preflight:v1": green }) });
  assert.equal(open.enabled, true);
  assert.equal(open.authorized, true);
  resetSalesSwitchCache();
});

test("resend-delivery never reveals whether an order exists", async () => {
  const rows = [{ order_id: "11111111-1111-4111-8111-111111111111", status: "paid", fulfillment_status: "delivered", evidence_ref: JSON.stringify({ email_recipient: "real@cliente.com", email_destination_kind: "payer" }) }];
  const sqlFactory = () => ({ query: async (text) => (text.includes("from orders") ? rows : []) });
  const env = { DATABASE_URL: "x", ZEVANORY_PRIVATE_ARTIFACTS: kv() };
  const req = (body) => new Request("https://zevanory.api.br/api/support/resend-delivery", { method: "POST", headers: { "cf-connecting-ip": "198.51.100." + Math.floor(Math.random() * 200) }, body: JSON.stringify(body) });
  const wrong = await handleSalesControl(req({ order_id: rows[0].order_id, email: "intruso@x.com" }), env, { sqlFactory });
  const missing = await handleSalesControl(req({ order_id: "22222222-2222-4222-8222-222222222222", email: "a@b.com" }), env, { sqlFactory: () => ({ query: async () => [] }) });
  assert.equal(wrong.status, 200);
  assert.equal(missing.status, 200);
  assert.deepEqual(await wrong.json(), await missing.json());
  const bad = await handleSalesControl(req({ order_id: "x", email: "y" }), env, { sqlFactory });
  assert.equal(bad.status, 400);
});

test("emergency close is observable by revision and never opens sales", async () => {
  resetSalesSwitchCache();
  const map = { "sales:open:v1": JSON.stringify({ enabled: false, at: "2026-10-08T21:40:00.000Z", by: "drill" }) };
  const calls = [];
  const store = { async get(k, opts) { calls.push(opts); return map[k] ?? null; } };
  const sw = await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: store });
  assert.equal(sw.enabled, false);
  assert.equal(sw.revision, "2026-10-08T21:40:00.000Z");
  assert.equal(calls[0].cacheTtl, 30);
  const res = await handleSalesControl(new Request("https://zevanory.api.br/api/sales/status"), { ZEVANORY_PRIVATE_ARTIFACTS: store });
  const body = await res.json();
  assert.equal(body.open, false);
  assert.equal(body.revision, "2026-10-08T21:40:00.000Z");
  resetSalesSwitchCache();
});
test("switch cache expires within 10 s so a close propagates in < 60 s", async () => {
  resetSalesSwitchCache();
  const map = { "sales:open:v1": JSON.stringify({ enabled: false, at: "r1" }) };
  const store = { async get(k) { return map[k] ?? null; } };
  const t0 = 1_000_000;
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: store }, t0)).revision, "r1");
  map["sales:open:v1"] = JSON.stringify({ enabled: false, at: "r2" });
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: store }, t0 + 9_000)).revision, "r1");
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: store }, t0 + 10_001)).revision, "r2");
  resetSalesSwitchCache();
});

test("public sales status remains fail-closed despite an approved owner switch while release proof is missing", async () => {
  resetSalesSwitchCache();
  const store = kv({
    "sales:open:v1": JSON.stringify(AUTH()),
    "zpc-sales-preflight:v1": JSON.stringify({ ok: true, at: new Date().toISOString() })
  });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: store,
    ABSOLUTE_RELEASE_APPROVED: "true", PRE_SALE_GATES_APPROVED: "true", MERCADOPAGO_ENV: "production" };
  const req = new Request("https://zevanory.api.br/api/sales/status");
  const sw = await readSalesSwitch(env);
  assert.equal(sw.enabled, true, "owner switch is unchanged");
  const status = await (await handleSalesControl(req, env)).json();
  assert.equal(status.open, false, "unproven financial snapshot cannot announce live sales");
  assert.equal(status.requested, true);
  assert.equal(status.blocked, "release_or_financial_proof_pending");
  resetSalesSwitchCache();
});
