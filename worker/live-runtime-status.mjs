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
