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

export function whatsappStageRecorder(kv, status, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const started = now(), invocation = crypto.randomUUID();
  let lastWrite = null, sequence = 0;
  return async function checkpoint(stage, details = {}) {
    Object.assign(status, details, { stage, elapsed_ms: now() - started });
    status.steps ||= [];
    status.steps.push({ stage, elapsed_ms: status.elapsed_ms });
    status.steps = status.steps.slice(-24);
    if (!kv?.put) { console.error("whatsapp_checkpoint_storage_missing"); return; }
    // KV limits the same key to one write/second. Unique stage records retain
    // every checkpoint without delaying the processing pipeline.
    const key = `whatsapp:instant:stage:${String(9999999999999 - now()).padStart(13, "0")}:${String(999 - sequence++).padStart(3, "0")}:${invocation}`;
    try { await kv.put(key, JSON.stringify(status), { expirationTtl: 86400 }); }
    catch { console.error("whatsapp_checkpoint_write_failed", stage); }
    const terminal = stage === "voice_sent" || stage === "voice_error";
    if (lastWrite !== null && now() - lastWrite < 1100) {
      if (!terminal) return;
      await sleep(1100 - (now() - lastWrite));
    }
    try {
      await kv.put("whatsapp:instant:last", JSON.stringify(status), { expirationTtl: 604800 });
      lastWrite = now();
    } catch { console.error("whatsapp_checkpoint_pointer_failed", stage); }
  };
}

export async function latestWhatsappStage(kv) {
  if (!kv?.get) return null;
  let last = null;
  try { last = JSON.parse(await kv.get("whatsapp:instant:last") || "null"); } catch {}
  if (!kv.list) return last;
  try {
    const page = await kv.list({ prefix: "whatsapp:instant:stage:", limit: 1 });
    if (!page.keys?.[0]?.name) return last;
    const latest = JSON.parse(await kv.get(page.keys[0].name) || "null");
    if (latest && (!last || String(latest.at || "") > String(last.at || "") || (latest.at === last.at && latest.elapsed_ms >= (last.elapsed_ms || 0)))) return latest;
  } catch {}
  return last;
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
