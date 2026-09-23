const VERSION="ZEVANORY-WHATSAPP-PROVISIONING-GATE/1.0";

function bool(v){ return v===true; }

function nonEmpty(v){ return typeof v==="string" && v.trim().length>0; }

export function evaluateWhatsAppProvisioning(input={}){
  const expected=input.expected||{};
  const observed=input.observed||{};
  const checks={
    business_id_present:nonEmpty(observed.business_id),
    waba_id_present:nonEmpty(observed.waba_id),
    app_id_present:nonEmpty(observed.app_id),
    phone_number_id_present:nonEmpty(observed.phone_number_id),
    phone_present:nonEmpty(observed.phone_e164),
    expected_business_match:nonEmpty(expected.business_id)&&observed.business_id===expected.business_id,
    expected_waba_match:nonEmpty(expected.waba_id)&&observed.waba_id===expected.waba_id,
    expected_app_match:nonEmpty(expected.app_id)&&observed.app_id===expected.app_id,
    webhook_verified:bool(observed.webhook_verified),
    token_verified:bool(observed.token_verified),
    send_test_passed:bool(observed.send_test_passed),
    receive_test_passed:bool(observed.receive_test_passed),
    media_test_passed:bool(observed.media_test_passed),
    audio_test_passed:bool(observed.audio_test_passed),
    no_duplicate_binding:observed.duplicate_binding!==true,
    no_legacy_number_binding:observed.legacy_number_binding!==true,
    onboarding_route_count:Number(observed.onboarding_route_count||0)===1,
    retry_guard_enabled:bool(observed.retry_guard_enabled),
    retry_attempts_within_limit:Number(observed.retry_attempts||0)<=Number(observed.retry_limit||3),
    ownership_verified:bool(observed.ownership_verified)
  };
  const blockers=Object.entries(checks).filter(([,ok])=>!ok).map(([k])=>k);
  return {
    schema:"zevanory-whatsapp-provisioning/v1",
    gate:VERSION,
    fail_closed:true,
    decision:blockers.length===0?"ALLOW":"DENY",
    eligible_for_activation:blockers.length===0,
    checks,
    blockers
  };
}

export function whatsappProvisioningContract(){
  return {
    gate:VERSION,
    authority:"ZEVANORY Control Core",
    fail_closed:true,
    max_retry_default:3,
    rules:[
      "one canonical Meta Business",
      "one canonical WABA",
      "one canonical Meta app",
      "one onboarding route",
      "no blind retries",
      "no activation without ownership verification",
      "no activation without send/receive/media/audio E2E"
    ]
  };
}
