import test from "node:test";
import assert from "node:assert/strict";

test("snapshot main runs end-to-end against a mocked network and writes every section", async () => {
  const store = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => {
    u = String(u);
    const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u.includes("/storage/kv/")) {
      if (u.includes("/keys?")) return res(200, { result: [] });
      const k = decodeURIComponent(u.match(/values\/([^?]+)/)[1]);
      if ((o.method || "GET") === "PUT") { store.set(k, o.body); return res(200, {}); }
      return store.has(k) ? res(200, store.get(k)) : res(404, "");
    }
    if (u.includes("oauth2") || u.includes("token")) return res(200, { access_token: "x", expires_in: 3600 });
    return res(200, {});
  };
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", KV_NAMESPACE_ID: "n" });
  try {
    const { main, SNAPSHOT_KEY } = await import("../scripts/audit/command-center-snapshot.mjs");
    await main();
    const s = JSON.parse(store.get(SNAPSHOT_KEY));
    for (const k of ["goals", "revenue", "funnel", "acquisition", "autonomy", "operations", "forecast", "recommendations"]) assert.ok(s[k], k);
    assert.equal(s.revenue.salesToday.integrity, "webhook_authenticated");
    assert.equal(s.funnel.visitors7.integrity, "missing"); // no funnel summary → never a number
    assert.equal(s.forecast.status, "insufficient");
  } finally { globalThis.fetch = realFetch; }
});
