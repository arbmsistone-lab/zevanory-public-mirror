// B02 sandbox (sandbox-route-probe.yml): Worker descartável. Responde só um marcador público, sem segredo,
// para provar qual script atende cada rota de girolocal.api.br (zona descartável do proprietário).
export default {
  async fetch(request, env) {
    const version = typeof env.PROBE_VERSION === "string" ? env.PROBE_VERSION : "unset";
    return new Response(`zevanory-route-probe ${version}\n`, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
