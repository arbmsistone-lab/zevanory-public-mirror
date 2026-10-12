import test from "node:test";
import assert from "node:assert/strict";
import { paidSubscriptions, verdict, NEON_FREE_BYTES } from "../scripts/audit/plan-probe.mjs";

test("a paid subscription or a paid usage model fails; free passes", () => {
  assert.deepEqual(paidSubscriptions([{ price: 0, rate_plan: { id: "workers_free" } }]), []);
  assert.equal(paidSubscriptions([{ price: 5, currency: "USD", product: { name: "Workers Paid" } }]).length, 1);
  assert.deepEqual(verdict({ cloudflare: { paid: [], usageModel: "standard" }, neon: { bytes: 1e6 } }), []);
  assert.ok(verdict({ cloudflare: { paid: [{}] } }).includes("cloudflare_paid_subscription"));
  assert.ok(verdict({ cloudflare: { usageModel: "unbound" } }).includes("cloudflare_usage_model_unbound"));
  assert.ok(verdict({ neon: { bytes: 0.9 * NEON_FREE_BYTES } }).includes("neon_storage_near_free_cap"));
});
