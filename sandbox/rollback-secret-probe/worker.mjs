const NONCE = "zevanory-b01-rollback-secret-probe-v1:";

function hex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/probe") {
      return new Response("not found\n", { status: 404 });
    }
    if (typeof env.PROBE_SECRET !== "string" || env.PROBE_SECRET.length === 0) {
      return new Response("probe secret unavailable\n", { status: 503 });
    }
    const input = new TextEncoder().encode(NONCE + env.PROBE_SECRET);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return new Response(hex(digest) + "\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
