// Commercial containment regression suite (owner order 12-13/10/2026).
// Creatives may only promote the official ZEVANORY catalog; OFFER-0001 (ARBM SIST, R$ 1.197)
// must never be generated or published again, without touching checkout or healthy channels.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ZEV_CREATIVE_CATALOG, DEFAULT_CREATIVE_OFFER, SALES_ORIGIN,
  brandSafeCreativeViolation, assertBrandSafeCreative, creativeLandingUrl,
  CREATIVE_AUTOPUBLISH_PAUSE_KEY
} from "../worker/creative-autonomy.mjs";
import { runMultichannelAutonomy, PINTEREST_APPROVED_BRAND_PIN_URL } from "../worker/multichannel-autonomy.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const worker = read("../worker/cloudflare-worker.recovered.mjs");
const products = JSON.parse(read("../data/products.json"));
const official = { creative_id: "c-zev", offer_id: "ZEV-LCX-011", product: "ZEVANORY Lucro & Caixa", price_brl: 247, brand: "ZEVANORY", title: "Passo a passo para salão", content: "Lucro & Caixa · garantia de 7 dias.", landing_url: "https://vendas.zevanory.api.br/lucro-e-caixa?utm_source=pinterest" };
const arbm = { creative_id: "c-arbm", offer_id: "OFFER-0001", product: "ARBM SIST", price_brl: 1197, brand: "ZEVANORY", title: "Programa ZEVANORY", content: "Pesquisa e automação com evidência para Gerenciamento de risco. Garantia de 7 dias.", landing_url: "https://zevanory.api.br/solucoes" };

test("1. creative catalog mirrors data/products.json exactly (sku, slug, name, price)", () => {
  const fromSource = Object.fromEntries(products.products.map((p) => [p.sku, { slug: p.slug, name: p.name, price_brl: p.price }]));
  assert.deepEqual(JSON.parse(JSON.stringify(ZEV_CREATIVE_CATALOG)), fromSource);
  assert.ok(ZEV_CREATIVE_CATALOG[DEFAULT_CREATIVE_OFFER], "default creative offer must be official");
  assert.equal(ZEV_CREATIVE_CATALOG["OFFER-0001"], undefined);
});

test("2. OFFER-0001, ARBM text, foreign prices and foreign links are rejected; official creative passes", () => {
  assert.equal(brandSafeCreativeViolation(official), null);
  assert.equal(brandSafeCreativeViolation(arbm), "creative_offer_not_in_zev_catalog");
  assert.equal(brandSafeCreativeViolation({ ...official, offer_id: undefined }), "creative_offer_missing");
  assert.equal(brandSafeCreativeViolation({ ...official, price_brl: 1197 }), "creative_price_not_official");
  assert.equal(brandSafeCreativeViolation({ ...official, content: "Conheça o ARBM SIST hoje" }), "creative_legacy_product_text");
  assert.equal(brandSafeCreativeViolation({ ...official, content: "Agora por R$ 1.197,00" }), "creative_price_not_official");
  assert.equal(brandSafeCreativeViolation({ ...official, brand: "OUTRA" }), "creative_brand_invalid");
  assert.equal(brandSafeCreativeViolation({ ...official, landing_url: "https://controle.zevanory.api.br/" }), "creative_link_not_official");
  assert.equal(brandSafeCreativeViolation({ ...official, landing_url: "http://vendas.zevanory.api.br/x" }), "creative_link_not_official");
  assert.throws(() => assertBrandSafeCreative(arbm), /creative_offer_not_in_zev_catalog/);
  assert.match(creativeLandingUrl("ZEV-CMB-011", { source: "pinterest", campaign: "c1" }), /^https:\/\/vendas\.zevanory\.api\.br\/combo-ia-vendas\?utm_source=pinterest&utm_medium=organic&utm_campaign=c1$/);
  // Unknown/legacy/empty offers are rejected explicitly — no silent fallback to another product.
  for (const bad of ["OFFER-0001", "ZEV-XXX-999", "", undefined, null]) assert.throws(() => creativeLandingUrl(bad, { source: "pinterest" }), /creative_offer_not_in_zev_catalog/);
  for (const sku of Object.keys(ZEV_CREATIVE_CATALOG)) assert.equal(new URL(creativeLandingUrl(sku)).origin, SALES_ORIGIN);
});

function kv() { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => m.set(k, v), m }; }
const brandPng = () => new Response(readFileSync(new URL("../assets/brand/export/pin.png", import.meta.url)), { status: 200, headers: { "content-type": "image/png" } });

async function runPinterest(feed) {
  const store = kv(); await store.put("zpc:creative-autonomy:feed:v1", JSON.stringify(feed));
  const pins = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === PINTEREST_APPROVED_BRAND_PIN_URL) return brandPng();
    if (url === "https://api.pinterest.com/v5/pins") { pins.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: "pin-" + pins.length }), { status: 201 }); }
    throw new Error("Unexpected endpoint " + url);
  };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: store, PINTEREST_ACCESS_TOKEN: "test", PINTEREST_BOARD_ID: "board" };
  const outcome = await runMultichannelAutonomy(env, new Date("2026-10-13T18:00:00Z"), fetchImpl);
  return { pins, outcome };
}
const approved = (x) => ({ ...x, status: "approved_for_autopublish", compliance: 100, score: 95, asset_url: "https://zevanory.api.br/api/creative-asset?p=x" });

test("3. Pinterest never publishes an OFFER-0001 creative, even when it is first and fully approved", async () => {
  const onlyArbm = await runPinterest([approved(arbm)]);
  assert.equal(onlyArbm.pins.length, 0);
  assert.equal(onlyArbm.outcome.evidence.some((x) => x.channel === "pinterest"), false);
  const mixed = await runPinterest([approved(arbm), approved(official)]);
  assert.equal(mixed.pins.length, 1);
  assert.equal(mixed.pins[0].title, official.title);
  assert.match(mixed.pins[0].link, /^https:\/\/vendas\.zevanory\.api\.br\/lucro-e-caixa/);
  assert.doesNotMatch(JSON.stringify(mixed.pins), /ARBM|1197/);
});

test("4. legacy feed items without an offer (pre-containment) are not published", async () => {
  const legacy = approved({ creative_id: "legacy", title: "Tema", content: "Texto", landing_url: "https://zevanory.api.br/solucoes" });
  assert.equal((await runPinterest([legacy])).pins.length, 0);
});

test("5. every creative generation path defaults to the official catalog, checkout untouched", () => {
  // The only remaining literal is PROJECT.offerId (checkout configuration), asserted below.
  assert.equal((worker.match(/offerId\s*[:=]\s*"OFFER-0001"/g) || []).length, 1);
  assert.doesNotMatch(worker, /decision\.offer_id \|\| "OFFER-0001"/);
  assert.match(worker, /function createCreativeSpec\(\{ offerId = DEFAULT_CREATIVE_OFFER,/);
  assert.match(worker, /const offer = resolveCreativeOffer\(offerId\);\n  if \(!offer\) throw new Error\("creative_offer_not_in_zev_catalog"\);/);
  assert.match(worker, /function buildCreativeVariants\(\{ offerId = DEFAULT_CREATIVE_OFFER,/);
  assert.match(worker, /const brief = \{ offerId: DEFAULT_CREATIVE_OFFER, channel,/);
  // Failed/empty creatives get no landing (and are unpublishable); never another product's page, never a crash.
  assert.match(worker, /landing_url: creativeCatalogEntry\(item\.spec\.offer_id\) \? creativeLandingUrl\(item\.spec\.offer_id, \{ source: channel, campaign: item\.spec\.campaign_id \|\| cycleId \}\) : null,/);
  assert.match(worker, /if \(!creativeCatalogEntry\(s\.offer_id\)\) return null;/, "signed ARBM assets must stop rendering");
  // Checkout resolvers and the project offer are deliberately unchanged (no payment change without owner order).
  assert.match(worker, /function resolveCheckoutOffer\(id\) \{\n  const key = String\(id \|\| PROJECT\.offerId\)/);
  assert.match(worker, /function resolveCertificationCheckoutOffer\(id\) \{\n  const product = getZevanoryProduct\(id\);\n  if \(!product \|\| product\.artifact_materialized !== true \|\| Number\(product\.table_price_brl\) <= 0\) return null;/);
  assert.match(worker, /offerId: "OFFER-0001",/, "PROJECT config untouched");
});

test("6. publication gate covers every outbox adapter and the agent payload carries the offer", () => {
  assert.match(worker, /ensureCommercialContactConsent\(event\);\n  if \(event\?\.payload\?\.creative_id\) assertBrandSafeCreative\(event\.payload\);/);
  assert.match(worker, /payload\.offer_id = spec\.offer_id;/);
  assert.match(worker, /creativeOffer = \{ offer_id: spec\.offer_id, product: spec\.product, price_brl: spec\.price_brl, brand: spec\.brand \};/);
  assert.match(worker, /media_url: mediaUrl\.slice\(0, 4e3\), \.\.\.creativeOffer, creative_id: creativeId,/);
});

test("7. healthy channels are not paused: no global pause introduced and acquisition engine untouched", () => {
  assert.equal(CREATIVE_AUTOPUBLISH_PAUSE_KEY, "zpc:creative-autonomy:paused:v1");
  const acquisition = read("../worker/acquisition-engine.mjs");
  assert.doesNotMatch(acquisition, /assertBrandSafeCreative|brandSafeCreativeViolation/);
  assert.doesNotMatch(read("../worker/creative-autonomy.mjs"), /setCreativeAutopublishPaused\(env,\s*true\)/);
});
