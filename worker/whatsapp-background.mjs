export function deferMetaWebhook(request, env, ctx, processRequest) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/webhooks/meta") return null;
  if (!ctx?.waitUntil) return Response.json({ error: "background_context_missing" }, { status: 503 });
  const copy = request.clone();
  // The original handler still verifies the signature before any delivery.
  ctx.waitUntil(Promise.resolve().then(() => processRequest(copy, env, ctx)).then(async response => {
    if (!response.ok) console.error("whatsapp_background_handler_http", response.status);
    await response.body?.cancel().catch(() => {});
  }).catch(() => console.error("whatsapp_background_handler_failed")));
  return Response.json({ accepted: true }, { headers: { "cache-control": "no-store" } });
}

export function whatsappStageRecorder(kv, status, now = Date.now) {
  const started = now();
  return async function checkpoint(stage, details = {}) {
    Object.assign(status, details, { stage, elapsed_ms: now() - started });
    status.steps ||= [];
    status.steps.push({ stage, elapsed_ms: status.elapsed_ms });
    status.steps = status.steps.slice(-24);
    if (!kv?.put) { console.error("whatsapp_checkpoint_storage_missing"); return; }
    try { await kv.put("whatsapp:instant:last", JSON.stringify(status), { expirationTtl: 604800 }); }
    catch { console.error("whatsapp_checkpoint_write_failed", stage); }
  };
}
