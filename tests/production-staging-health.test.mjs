import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeClosedCommercialStaging } from "../worker/production-health-safety.mjs";
const flags = {
  SALE_GLOBALLY_ENABLED: false,
  PRE_SALE_GATES_APPROVED: true,
  CHECKOUT_ENABLED: true,
  FINANCIAL_EVENTS_ENABLED: true,
  WHATSAPP_SALES_ENABLED: false
};
const env = {
  MERCADOPAGO_ENV: "production",
  PAYMENT_PROVIDER: "mercadopago",
  ABSOLUTE_RELEASE_APPROVED: "true"
};
test("reproduce: prelaunch production/closed flags are not accepted by legacy health", () => {
  const legacy = !flags.SALE_GLOBALLY_ENABLED && flags.PRE_SALE_GATES_APPROVED &&
    flags.CHECKOUT_ENABLED && flags.WHATSAPP_SALES_ENABLED && flags.FINANCIAL_EVENTS_ENABLED;
  assert.equal(legacy,false);
  assert.equal(safeClosedCommercialStaging(env,false,flags),true);
});
test("production readiness classification stays fail-closed for altered flags", () => {
  assert.equal(safeClosedCommercialStaging(env,true,flags),false);
  assert.equal(safeClosedCommercialStaging(env,false,{...flags,SALE_GLOBALLY_ENABLED:true}),false);
  assert.equal(safeClosedCommercialStaging(env,false,{...flags,PRE_SALE_GATES_APPROVED:false}),false);
  assert.equal(safeClosedCommercialStaging(env,false,{...flags,CHECKOUT_ENABLED:false}),false);
  assert.equal(safeClosedCommercialStaging(env,false,{...flags,FINANCIAL_EVENTS_ENABLED:false}),false);
  // The owner can close checkout while inbound WhatsApp support remains enabled.
  assert.equal(safeClosedCommercialStaging(env,false,{...flags,WHATSAPP_SALES_ENABLED:true}),true);
  assert.equal(safeClosedCommercialStaging({...env,MERCADOPAGO_ENV:"sandbox"},false,flags),false);
  assert.equal(safeClosedCommercialStaging({...env,ABSOLUTE_RELEASE_APPROVED:"false"},false,flags),false);
  assert.equal(safeClosedCommercialStaging({...env,PAYMENT_PROVIDER:"asaas"},false,flags),false);
});
test("prepared deployment injects health classifier without disabling checks", () => {
  const prepare = readFileSync(new URL("../scripts/deploy/prepare-central-candidate.py",import.meta.url),"utf8");
  assert.match(prepare,/HEALTH_SAFETY_ANCHOR_CHANGED/);
  assert.match(prepare,/safeClosedCommercialStaging\(env, ownerSalesOpen, switches\)/);
  assert.doesNotMatch(prepare,/res\.statusCode = 200/);
});
