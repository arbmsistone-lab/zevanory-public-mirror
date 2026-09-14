const TARGETS = [
  "https://zevanory.api.br/api/live",
  "https://edge.zevanory.api.br/api/live",
  "https://backup.zevanory.api.br/api/live",
];

export default {
  async fetch(_request, env) {
    const version = env.CF_VERSION_METADATA || null;
    const results = [];
    for (const url of TARGETS) {
      const started = Date.now();
      try {
        const res = await fetch(url, { headers: { "user-agent": "zevanory-cloudflare-certifier" } });
        results.push({ url, ok: res.ok, status: res.status, latency_ms: Date.now() - started });
      } catch (error) {
        results.push({ url, ok: false, status: 0, latency_ms: Date.now() - started, error: String(error) });
      }
    }
    const ok = results.filter((item) => item.ok).length >= 2 && Boolean(version?.id && version?.tag);
    return Response.json({ schema: "zevanory-remote-cert-v2", provider: "cloudflare-workers", deployment_version_id:version?.id||null, served_version:version?.tag||null, sales_gate:'blocked', zero_spend:true, paid_fallback_used:false, ok, results }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};
