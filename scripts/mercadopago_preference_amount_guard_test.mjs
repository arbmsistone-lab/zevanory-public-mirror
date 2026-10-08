// Behavioral regression for issue #307: a Mercado Pago preference may only charge
// the persisted order amount. Extracts the guard from the shipped runtime and runs it.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const runtime = readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const start = runtime.indexOf("function preferenceMatchesPersistedOrder(");
const end = runtime.indexOf('__name(preferenceMatchesPersistedOrder, "preferenceMatchesPersistedOrder");');
assert.ok(start >= 0 && end > start, "GUARD_MISSING_FROM_RUNTIME");
const guard = new Function(`${runtime.slice(start, end)}\nreturn preferenceMatchesPersistedOrder;`)();

// The guard must run before the provider call, inside the canonical checkout handler.
const callSite = runtime.indexOf("if (!preferenceMatchesPersistedOrder(payload, claimed[0]))");
const providerCall = runtime.indexOf("raw = await createMercadoPagoPreference(payload, providerToken);");
assert.ok(callSite > 0 && providerCall > callSite, "GUARD_NOT_BEFORE_PROVIDER_CALL");
assert.equal((runtime.match(/\/checkout\/preferences`/g) || []).length, 1, "UNEXPECTED_PREFERENCE_CREATION_POINT");

const order = { amount: "197.00", offer_id: "ZEV-IA-011" };
const pref = (unit_price, extra = {}) => ({ items: [{ id: "ZEV-IA-011", quantity: 1, currency_id: "BRL", unit_price, ...extra }] });

assert.equal(guard(pref(197), order), true, "MATCHING_AMOUNT_ACCEPTED");
assert.equal(guard(pref(197), { amount: "5.00", offer_id: "ZEV-IA-011" }), false, "ISSUE_307_197_VS_5_REJECTED");
assert.equal(guard(pref(5), order), false, "LOWER_AMOUNT_REJECTED");
assert.equal(guard(pref(197.01), order), false, "CENT_DIFFERENCE_REJECTED");
assert.equal(guard(pref(197, { quantity: 2 }), order), false, "QUANTITY_REJECTED");
assert.equal(guard(pref(197, { currency_id: "USD" }), order), false, "CURRENCY_REJECTED");
assert.equal(guard(pref(197, { id: "ZEV-OTHER" }), order), false, "OFFER_MISMATCH_REJECTED");
assert.equal(guard({ items: [...pref(197).items, ...pref(197).items] }, order), false, "MULTI_ITEM_REJECTED");
assert.equal(guard(pref(197), { amount: "0", offer_id: "ZEV-IA-011" }), false, "ZERO_ORDER_REJECTED");
assert.equal(guard(null, order), false, "EMPTY_PAYLOAD_REJECTED");

console.log("PREFERENCE_AMOUNT_GUARD_TEST=PASS");
