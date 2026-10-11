import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// The compat Worker imports cloudflare:node and cannot be loaded in Node; the
// contract is asserted on the source, and the derived value on sales-control.
const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
const start = src.indexOf('if (url.pathname === "/api/support/instant-status"');
const block = src.slice(start, src.indexOf("\n    }\n", start));

test("instant-status derives sales_globally_enabled from the effective /api/sales/status readback", () => {
  assert.ok(start > 0);
  assert.match(block, /handleSalesControl\(new Request\(new URL\("\/api\/sales\/status", url\), \{ method: "GET" \}\)/);
  assert.match(block, /sales_globally_enabled: salesEffective/);
  assert.match(block, /\?\.open === true/);
});
test("regression: instant-status no longer reports the fail-closed deploy var as the sales state", () => {
  // Live 2026-10-11: sales_globally_enabled=false while /api/sales/status open=true.
  assert.doesNotMatch(block, /sales_globally_enabled:\s*normalized\.SALE_GLOBALLY_ENABLED/);
});
test("a failing sales readback reports closed (fail-closed), never open", () => {
  assert.match(block, /catch \{ salesEffective = false; \}/);
  assert.match(block, /let salesEffective = false;/);
});
