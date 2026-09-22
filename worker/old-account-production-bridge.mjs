export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const upstream = new URL(incoming.pathname + incoming.search, "https://zevanory.girolocal-rb.workers.dev");
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
    const init = {
      method: request.method,
      headers,
      redirect: "manual"
    };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
    const response = await fetch(new Request(upstream, init));
    const outHeaders = new Headers(response.headers);
    const location = outHeaders.get("location");
    if (location && location.startsWith("https://zevanory.girolocal-rb.workers.dev")) {
      outHeaders.set("location", location.replace("https://zevanory.girolocal-rb.workers.dev", "https://zevanory.api.br"));
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders
    });
  }
};