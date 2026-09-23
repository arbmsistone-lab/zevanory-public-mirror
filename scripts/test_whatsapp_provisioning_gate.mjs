import assert from "node:assert/strict";
import { evaluateWhatsAppProvisioning } from "../worker/whatsapp-provisioning-gate.mjs";

const expected={business_id:"biz",waba_id:"waba",app_id:"app"};
const good={
  business_id:"biz",waba_id:"waba",app_id:"app",phone_number_id:"phone-id",phone_e164:"+5500000000000",
  webhook_verified:true,token_verified:true,send_test_passed:true,receive_test_passed:true,
  media_test_passed:true,audio_test_passed:true,duplicate_binding:false,legacy_number_binding:false,
  onboarding_route_count:1,retry_guard_enabled:true,retry_attempts:0,retry_limit:3,ownership_verified:true
};

const pass=evaluateWhatsAppProvisioning({expected,observed:good});
assert.equal(pass.decision,"ALLOW");
assert.equal(pass.eligible_for_activation,true);

for (const mutation of [
  o=>({...o,business_id:"wrong"}),
  o=>({...o,duplicate_binding:true}),
  o=>({...o,legacy_number_binding:true}),
  o=>({...o,onboarding_route_count:2}),
  o=>({...o,retry_guard_enabled:false}),
  o=>({...o,retry_attempts:4}),
  o=>({...o,ownership_verified:false}),
  o=>({...o,send_test_passed:false}),
  o=>({...o,receive_test_passed:false}),
  o=>({...o,audio_test_passed:false})
]){
  const r=evaluateWhatsAppProvisioning({expected,observed:mutation(good)});
  assert.equal(r.decision,"DENY");
  assert.equal(r.eligible_for_activation,false);
}
console.log("WHATSAPP_PROVISIONING_GATE_PASS");
