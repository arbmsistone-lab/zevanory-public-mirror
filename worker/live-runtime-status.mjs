export function whatsappTransportIsOperational(env = {}, runtime = {}, broker = {}) {
  const runtimeReady = runtime?.identity_verified === true
    && Boolean(String(runtime?.access_token || env.WHATSAPP_ACCESS_TOKEN || "").trim())
    && Boolean(String(runtime?.phone_number_id || env.WHATSAPP_PHONE_NUMBER_ID || "").trim());
  const brokerReady = broker?.broker === true && broker?.identity_verified === true;
  return runtimeReady || brokerReady;
}

export function projectLiveStatus(body = {}, { salesOpen = false, whatsappTransportOperational = false } = {}) {
  const sales = salesOpen ? "enabled" : "globally-blocked";
  const runtime = {
    ...(body.runtime || {}),
    sales,
    whatsapp: whatsappTransportOperational ? "enabled" : "disabled",
  };
  const channel_readiness = Object.fromEntries(Object.entries(body.channel_readiness || {}).map(([name, item = {}]) => [name, {
    ...item,
    release_gate: sales,
    commercial_execution: item.commercial === false ? "not_applicable" : (salesOpen ? "enabled" : "blocked"),
  }]));
  return { ...body, runtime, channel_readiness };
}
import { evaluateZea10FromZees16 } from "./zea10-evaluator.mjs";

export function projectLocalZea10(zees16, releaseSha) {
  const evaluation = evaluateZea10FromZees16(zees16);
  const exactRelease = Boolean(releaseSha && zees16?.release_sha === releaseSha);
  return {
    ready: exactRelease && evaluation?.authority === true,
    fail_closed: !(exactRelease && evaluation?.internal_complete === true),
    source: "local_control_core",
    report: {
      framework: evaluation?.framework || "ZEA-10",
      evaluator: evaluation?.evaluator || null,
      authority: evaluation?.authority === true,
      release_sha: evaluation?.release_sha || null,
      counts: evaluation?.counts || null,
      generated_at: zees16?.observed_at || null
    }
  };
}
