// zevanory-tts-hop: runs on the legacy account's girolocal-rb.workers.dev zone, the only
// origin the self-hosted Piper relay authorizes (Cloudflare stamps CF-Worker with it).
// Zero spend (Workers Free). Accepts only POST /tts with the shared hop token.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true, service: "zevanory-tts-hop" }), { headers: { "content-type": "application/json" } });
    if (url.pathname !== "/tts" || request.method !== "POST") return new Response("not found", { status: 404 });
    const expected = String(env.HOP_TOKEN || "");
    if (expected.length < 24 || request.headers.get("x-zevanory-relay-auth") !== expected) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    const relay = String(env.RELAY_URL || "https://tts.167-172-146-60.sslip.io").replace(/\/+$/, "");
    const upstream = await fetch(relay + "/tts", { method: "POST", headers: { "content-type": "application/json" }, body: await request.text(), signal: AbortSignal.timeout(20000) });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "audio/wav", "cache-control": "no-store" } });
  }
};
