const EXPECTED_SHA = "6e916ff031b8bfb7b9e683088c3cdcda003aa82d";
const TARGETS = [
  "https://zevanory.api.br/api/live",
  "https://edge.zevanory.api.br/api/live",
  "https://backup.zevanory.api.br/api/live",
];

export default {
  async fetch() {
    const results = [];
    for (const url of TARGETS) {
      const started = Date.now();
      try {
        const res = await fetch(url, { headers: { "user-agent": "zevanory-cloudflare-certifier" } });
        const body = await res.text();
        results.push({ url, ok: res.ok, status: res.status, latency_ms: Date.now() - started, sha_signal: body.includes(EXPECTED_SHA) });
      } catch (error) {
        results.push({ url, ok: false, status: 0, latency_ms: Date.now() - started, error: String(error) });
      }
    }
    const ok = results.filter((item) => item.ok).length >= 2;
    return Response.json({ schema: "zevanory-remote-cert-v1", provider: "cloudflare-workers", exact_sha: EXPECTED_SHA, sales_gate_expected: "blocked", ok, results }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};