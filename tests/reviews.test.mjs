import { test } from "node:test";
import assert from "node:assert/strict";
import { handleReviews, reviewLinks } from "../worker/reviews.mjs";

const OID = "11111111-1111-4111-8111-111111111111";
function fakeDb(orderStatus = "paid") {
  const reviews = new Map();
  const query = async (text, params = []) => {
    if (/create table/i.test(text)) return [];
    if (/from orders/.test(text)) return params[0] === OID ? [{ order_id: OID, offer_id: "ZEV-CMB-011", status: orderStatus, certification_pilot: false }] : [];
    if (/insert into zevanory_reviews/.test(text)) { reviews.set(params[0], { offer_id: params[1], rating: params[2], comment: params[3], consent: params[4] }); return []; }
    if (/from zevanory_reviews group by/.test(text)) {
      const by = {};
      for (const r of reviews.values()) { by[r.offer_id] = by[r.offer_id] || []; by[r.offer_id].push(r.rating); }
      return Object.entries(by).map(([offer_id, list]) => ({ offer_id, n: list.length, avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10 }));
    }
    throw new Error("sql " + text.slice(0, 40));
  };
  return { reviews, factory: () => ({ query }) };
}
const env = () => { const m = new Map(); return { DATABASE_URL: "x", RESEND_API_KEY: "re_test_123456789", ZEVANORY_PRIVATE_ARTIFACTS: { async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } }, _kv: m }; };

test("only HMAC links from the paid order can rate; GET never stores", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const db = fakeDb(); const e = env();
  const links = await reviewLinks(e, OID);
  assert.equal(links.length, 5);
  const forged = await handleReviews(new Request(`https://zevanory.api.br/avaliar?o=${OID}&n=5&t=${"0".repeat(32)}`, { method: "POST" }), e, { sqlFactory: db.factory });
  assert.equal(forged.status, 400);
  const get = await handleReviews(new Request(links[4]), e, { sqlFactory: db.factory });
  assert.equal(get.status, 200);
  assert.equal(db.reviews.size, 0);
  const body = new FormData(); body.set("n", "2"); body.set("comentario", "faltou exemplo, meu zap 88 99999-0000"); body.set("publicar", "sim");
  const post = await handleReviews(new Request(links[1], { method: "POST", body }), e, { sqlFactory: db.factory });
  assert.equal(post.status, 200);
  assert.equal(db.reviews.get(OID).rating, 2);
  const panel = [...e._kv.entries()].find(([k]) => k.startsWith("zpc-activity:v1:support:"));
  assert.ok(panel && /ATENÇÃO/.test(panel[1]) && !/99999/.test(panel[1]), "low score flagged, phone masked");
});

test("public summary hides products with fewer than 3 ratings", async () => {
  const db = fakeDb(); const e = env();
  const s1 = await (await handleReviews(new Request("https://zevanory.api.br/api/reviews/summary"), e, { sqlFactory: db.factory })).json();
  assert.deepEqual(s1.products, {});
});

test("unpaid orders cannot rate", async () => {
  const db = fakeDb("created"); const e = env();
  const links = await reviewLinks(e, OID);
  assert.equal((await handleReviews(new Request(links[4]), e, { sqlFactory: db.factory })).status, 400);
});
