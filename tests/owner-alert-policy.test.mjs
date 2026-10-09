import test from "node:test";
import assert from "node:assert/strict";
import { alertOwnerNow, ESCALATION_RE } from "../worker/owner-alerts.mjs";

test("owner alert policy treats refunds and complaints as alertable, not ordinary human requests",async()=>{assert.match("quero reembolso",ESCALATION_RE);assert.match("vou reclamar no procon",ESCALATION_RE);assert.doesNotMatch("quero falar com humano",ESCALATION_RE);const out=await alertOwnerNow({}, {category:"ordinary_metric",channel:"blog",contact:"anon",excerpt:"alcance baixo",reason:"metric"});assert.deepEqual(out,{sent:false,reason:"category_not_alertable"});});

test("stale financial proof with sales open alerts the owner at most once per window", async () => {
  const { alertFinancialProofStale } = await import("../worker/owner-alerts.mjs");
  const map = new Map();
  const kv = { get: async (k) => map.get(k) ?? null, put: async (k, v, o) => { map.set(k, v); map.set(k + ":ttl", o?.expirationTtl); } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  try {
    const env = { RESEND_API_KEY: "re_test_key_value", ZEVANORY_PRIVATE_ARTIFACTS: kv };
    const first = await alertFinancialProofStale(env, { present: true, age_minutes: 71, release_matches: true, ambiguous: 0 });
    const second = await alertFinancialProofStale(env, { present: false });
    assert.equal(first.sent, true);
    assert.deepEqual(second, { sent: false, reason: "recently_alerted" });
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /vendas abertas sem prova financeira/);
    assert.match(sent[0].text, /71 min/);
    assert.equal(map.get("owner-alert:sent:financial-proof-stale:ttl"), 55 * 60);
  } finally { globalThis.fetch = realFetch; }
});
