import test from "node:test";
import assert from "node:assert/strict";
import { recordHotmartSale, saleFacts, SALES_SUMMARY_KEY } from "../worker/sales-ledger.mjs";

function memKv() { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; }
const data = (txn, extra = {}) => ({
  product: { id: 123, name: "Lucro & Caixa" },
  buyer: { email: "cliente@example.com", name: "Cliente Real" },
  purchase: { transaction: txn, price: { value: 247 }, approved_date: Date.UTC(2026, 9, 12, 15), origin: { src: "youtube" }, payment: { type: "PIX" } },
  commissions: [{ source: "MARKETPLACE", value: 24.6 }, { source: "PRODUCER", value: 222.4 }],
  ...extra,
});

test("facts are PII-free and split gross/net/fees", () => {
  const f = saleFacts("PURCHASE_APPROVED", data("HP1"));
  assert.equal(f.grossCents, 24700); assert.equal(f.netCents, 22240); assert.equal(f.feesCents, 2460);
  assert.equal(f.src, "youtube"); assert.equal(f.payment, "pix"); assert.equal(f.day, "2026-10-12");
  assert.ok(!JSON.stringify(f).includes("cliente@"));
});

test("approval counted once across APPROVED + COMPLETE, refund tracked", async () => {
  const kv = memKv();
  assert.equal((await recordHotmartSale(kv, "PURCHASE_APPROVED", data("HP1"))).recorded, true);
  assert.equal((await recordHotmartSale(kv, "PURCHASE_COMPLETE", data("HP1"))).recorded, false);
  await recordHotmartSale(kv, "PURCHASE_APPROVED", data("HP2", { purchase: { ...data("HP2").purchase, origin: {} } }));
  await recordHotmartSale(kv, "PURCHASE_REFUNDED", data("HP1"));
  await recordHotmartSale(kv, "PURCHASE_REFUNDED", data("HP1"));
  const s = JSON.parse(kv.m.get(SALES_SUMMARY_KEY));
  assert.equal(s.totals.approved, 2); assert.equal(s.totals.grossCents, 49400); assert.equal(s.totals.refunded, 1);
  assert.equal(s.bySource.youtube.approved, 1); assert.equal(s.bySource["sem-origem"].approved, 1);
  assert.equal(s.byProduct["Lucro & Caixa"].approved, 2);
  assert.equal(s.byDay["2026-10-12"].approved, 2);
  assert.equal(s.integrity, "webhook_authenticated");
  assert.ok(!kv.m.get(SALES_SUMMARY_KEY).includes("cliente@") && !kv.m.get(SALES_SUMMARY_KEY).includes("HP1"));
});

test("unknown events are ignored", async () => {
  const kv = memKv();
  assert.equal((await recordHotmartSale(kv, "SOMETHING", data("X"))).recorded, false);
  assert.equal(kv.m.size, 0);
});
