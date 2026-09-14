const TARGETS = [
  "https://zevanory.api.br/api/release",
  "https://edge.zevanory.api.br/api/release",
  "https://backup.zevanory.api.br/api/release",
];
const SHA=/^[0-9a-f]{40}$/i;
export default {
  async fetch(_request, env) {
    const version = env.CF_VERSION_METADATA || null;
    const servedVersion=String(version?.tag||'').toLowerCase();
    const results = [];
    for (const url of TARGETS) {
      const started = Date.now();
      try {
        const res = await fetch(url, { headers: { "user-agent": "zevanory-cloudflare-certifier" } });
        const body=await res.json().catch(()=>({}));
        const commitSha=String(body?.deployment?.commit_sha||'').toLowerCase();
        const salesBlocked=String(body?.sales_mode||'')==='globally-blocked' && String(body?.checkout_mode||'')==='globally-blocked';
        results.push({ url, ok: res.ok && SHA.test(commitSha) && commitSha===servedVersion && salesBlocked, status: res.status, commit_sha:commitSha||null, sales_blocked:salesBlocked, latency_ms: Date.now() - started });
      } catch (error) {
        results.push({ url, ok: false, status: 0, latency_ms: Date.now() - started, error: String(error) });
      }
    }
    const verified=results.filter((item) => item.ok).length;
    const ok = SHA.test(servedVersion) && Boolean(version?.id) && verified >= 2;
    return Response.json({ schema: "zevanory-remote-cert-v2", provider: "cloudflare-workers", domain:'workers.dev', commit_sha:servedVersion||null, deployment_version_id:version?.id||null, served_version:servedVersion||null, gate_results:[{name:'production_release_match',status:ok?'passed':'failed',verified_targets:verified,total_targets:results.length}], started_at:null, completed_at:new Date().toISOString(), artifact_hash:null, sales_gate:'blocked', zero_spend:true, paid_fallback_used:false, ok, results }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  },
};
