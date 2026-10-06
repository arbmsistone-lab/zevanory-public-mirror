import { test } from "node:test";
import assert from "node:assert/strict";
import { readSalesSwitch, resetSalesSwitchCache, applySalesSwitch, handleSalesControl } from "../worker/sales-control.mjs";

const kv = (map = {}) => ({ async get(k) { return map[k] ?? null; }, async put(k, v) { map[k] = v; } });

test("sales stay closed unless the owner switch says enabled:true", async () => {
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv() })).enabled, false);
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": "garbage" }) })).enabled, false);
  resetSalesSwitchCache();
  assert.equal((await readSalesSwitch({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ "sales:open:v1": JSON.stringify({ enabled: true, by: "owner" }) }) })).enabled, true);
  assert.equal(applySalesSwitch({ enabled: true }), true);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, true);
  assert.equal(applySalesSwitch({ enabled: false }), false);
  assert.equal(globalThis.__ZEVANORY_SALES_SWITCH__, false);
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
