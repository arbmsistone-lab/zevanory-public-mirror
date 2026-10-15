import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compat = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
const prep = readFileSync(new URL("../scripts/deploy/prepare-central-candidate.py", import.meta.url), "utf8");
const metrics = readFileSync(new URL("../worker/commercial-metrics-projection.mjs", import.meta.url), "utf8");
const CRONS = JSON.parse(/CENTRAL_CRONS=(\[[^\]]+\])/.exec(prep)[1]);
const minutes = (c) => c.split(" ")[0].split(",").map(Number);

test("central keeps exactly 3 crons (Workers Free: 5 per account, shared)", () => {
  assert.deepEqual(CRONS, ["15,45 * * * *", "16,46 * * * *", "17 * * * *"]);
  for (const c of CRONS) assert.equal(c.split(" ").length, 5, c);
});
test("every database-touching cron fires within 2 minutes after a financial-proof tick", () => {
  const proof = minutes("15,45 * * * *");
  for (const c of CRONS) for (const m of minutes(c)) assert.ok(proof.some((p) => m - p >= 0 && m - p <= 2), `${c} at :${m}`);
});
test("the code dispatches each cron by its exact expression; old expressions are gone", () => {
  assert.match(compat, /controller\?\.cron === "16,46 \* \* \* \*"/);
  assert.match(compat, /controller\?\.cron === "15,45 \* \* \* \*"/);
  assert.equal(compat.includes('"5,35 * * * *"'), false);
  assert.equal(compat.includes('"0 * * * *"'), false);
});
test("16,46 split keeps the old semantics: :16 brand profiles, :46 acquisition (tickMinute >= 30)", () => {
  const block = compat.slice(compat.indexOf('controller?.cron === "16,46 * * * *"'), compat.indexOf('controller?.cron === "15,45 * * * *"'));
  assert.match(block, /tickMinute >= 30/);
  const pick = (m) => (m >= 30 ? "acquisition" : "brand");
  assert.equal(pick(16), "brand"); assert.equal(pick(46), "acquisition");
  assert.ok(block.indexOf("runAcquisitionEngine") < block.indexOf("syncBrandProfiles"));
  assert.ok(block.indexOf("syncProductionActivity") > block.indexOf("syncBrandProfiles"), "activity sync still runs on both ticks");
});
test("financial proof cadence and TTL untouched; the :17 refresh is not forced (skips DB when < 50 min)", () => {
  const iso = compat.slice(compat.indexOf('controller?.cron === "15,45 * * * *"'));
  assert.match(iso.slice(0, 1500), /force: true/);
  assert.match(metrics, /65\*60\*1000/);
  assert.match(metrics, /now-priorAt<MIN_REFRESH_MS/);
  const hourly = compat.slice(compat.indexOf("tasks.push(recordLaunchEpoch(normalized, salesSwitchState)"));
  assert.match(hourly.slice(0, 200), /refreshFinancialProofSnapshot\(normalized, \{ sqlFactory: whatsappProofDatabase \}\)/);
});
test("hourly maintenance (post-sale, nurture, refunds, delivery watchdog) still runs once per hour in its own invocation", () => {
  const hourly = compat.slice(compat.indexOf("const beat = { at: new Date().toISOString(), cron: String(controller?.cron"));
  for (const t of ["runPaidDeliveryWatchdog", "runLeadNurture", "runRefundWatchdog", "runPostSale"]) assert.ok(hourly.includes(t), t);
  assert.equal(CRONS.filter((c) => minutes(c).length === 1).length, 1, "one hourly cron");
});
