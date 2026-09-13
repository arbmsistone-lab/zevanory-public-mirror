const TARGETS = [
  "https://zevanory.api.br/api/live",
  "https://edge.zevanory.api.br/api/live",
  "https://backup.zevanory.api.br/api/live",
];

export default {
  async fetch(_request, env) {
    const expectedSha = String(env.EXPECTED_SHA || "").trim();
    if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
      return Response.json({ schema: "zevanory-remote-cert-v1", ok: false, error: "expected_sha_not_configured" }, { status: 503 });
    }
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
    const ok = results.filter((item) => item.ok).length >= 2;
    return Response.json({ schema: "zevanory-remote-cert-v1", provider: "cloudflare-workers", exact_sha: expectedSha, sales_gate_expected: "blocked", ok, results }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};