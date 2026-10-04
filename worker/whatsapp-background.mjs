export function deferMetaWebhook(request, env, ctx, processRequest) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/webhooks/meta") return null;
  if (!ctx?.waitUntil) return Response.json({ error: "background_context_missing" }, { status: 503 });
  const copy = request.clone();
  // The original handler still verifies the signature before any delivery.
  ctx.waitUntil(Promise.resolve().then(() => processRequest(copy, env, ctx)).then(async response => {
    if (!response.ok) {
      const failure = await response.clone().json().catch(() => ({}));
      const code = /^[a-z_]{1,80}$/.test(failure.error || "") ? failure.error : "unknown";
      console.error("whatsapp_background_handler_http", response.status, code);
    }
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

// Read the Web Request directly before invoking the existing signed Node handler.
// handleAsNodeRequest's request stream is tied to its HTTP bridge lifecycle;
// the background webhook must own its bytes independently of that bridge.
export async function handleNodeWebhookFetch(request, handler, maxBytes = 256 * 1024) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) return Response.json({ error: "payload_too_large" }, { status: 413 });
  const chunks = [], reader = request.body?.getReader();
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return Response.json({ error: "payload_too_large" }, { status: 413 }); }
      chunks.push(value);
    }
  }
  const req = {
    method: request.method, url: request.url,
    headers: Object.fromEntries(request.headers), query: { provider: "meta" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
  let body = "";
  const headers = new Headers();
  const res = {
    statusCode: 200, headersSent: false, writableEnded: false,
    setHeader(name, value) { headers.set(name, String(value)); },
    getHeader(name) { return headers.get(name); },
    end(value = "") { body = value; this.headersSent = true; this.writableEnded = true; }
  };
  await handler(req, res);
  return new Response(body, { status: res.statusCode, headers });
}
