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

test("snapshot carries the zero-cost ledger and the support evaluation slot", async () => {
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
    return res(200, {});
  };
  try {
    const { main, SNAPSHOT_KEY } = await import("../scripts/audit/command-center-snapshot.mjs");
    await main();
    const s = JSON.parse(store.get(SNAPSHOT_KEY));
    assert.equal(s.costs.incrementalCostBRL, 0);
    assert.ok(s.costs.providers.length >= 8);
    assert.ok("support" in s);
  } finally { globalThis.fetch = realFetch; }
});

test("public FUNNEL_DIAG notice never singles out a network with fewer than 3 visits", async () => {
  const store = new Map([["zpc-funnel:v1:summary", JSON.stringify({ generatedAt: "2026-10-13T12:00:00Z", products: {}, last7Days: {}, clean: { since: "2026-10-12", pages: {}, sources: {}, campaigns: {}, classes: { mobile_al_br: 14 }, asn: { "28573": 10, "263000": 1, "52965": 2, "7738": 3 } } })]]);
  const realFetch = globalThis.fetch, realLog = console.log, logs = [];
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
  console.log = (...a) => { logs.push(a.join(" ")); };
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", KV_NAMESPACE_ID: "n" });
  try {
    const { main } = await import("../scripts/audit/command-center-snapshot.mjs");
    await main();
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
  const line = logs.find((l) => l.startsWith("::notice title=FUNNEL_DIAG::"));
  assert.ok(line, "FUNNEL_DIAG notice emitted");
  const diag = JSON.parse(line.slice("::notice title=FUNNEL_DIAG::".length));
  assert.deepEqual(diag.asnTop, [["28573", 10], ["7738", 3], ["outros", 3]]);
  assert.doesNotMatch(line, /263000|52965/);
});
