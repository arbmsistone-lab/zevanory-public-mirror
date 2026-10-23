import { evaluateMetaStatusSnapshot, WHATSAPP_META_STATUS_ENV_KEY } from "./whatsapp-meta-truth.mjs";

// Fail-closed: only a fresh persisted Meta snapshot (env[WHATSAPP_META_STATUS_ENV_KEY], injected per
// request from KV) can make the WhatsApp transport operational. The isolate-local runtime/broker
// globals (onboarding identity flag, broker state) are ignored on purpose: they diverged from Meta.
export function whatsappTransportVerdict(env = {}, { now = Date.now() } = {}) {
  return evaluateMetaStatusSnapshot(env?.[WHATSAPP_META_STATUS_ENV_KEY], { now });
}

export function whatsappTransportIsOperational(env = {}, _runtime = {}, _broker = {}, { now = Date.now() } = {}) {
  return whatsappTransportVerdict(env, { now }).ready === true;
}

export function projectLiveStatus(body = {}, { salesOpen = false, whatsappTransportOperational = false, whatsappReason = null } = {}) {
  const sales = salesOpen ? "enabled" : "globally-blocked";
  const runtime = {
    ...(body.runtime || {}),
    sales,
    whatsapp: whatsappTransportOperational === true ? "enabled" : "disabled",
    whatsapp_reason: whatsappTransportOperational === true ? "meta_truth_fresh_healthy" : String(whatsappReason || body.runtime?.whatsapp_reason || "meta_snapshot_missing"),
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
