import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { OFFICIAL_PURCHASE_SKUS, purchaseLinkFor, catalogFacts, validateReply, converse } from "../worker/whatsapp-conversation.mjs";

const BUY_ROOT = "https://vendas.zevanory.api.br/comprar/";
const WHATSAPP_UTM = "?utm_source=whatsapp&utm_medium=chat";
test("official SKU links match published sales worker for every catalog product", () => {
  const source = readFileSync(new URL("../worker/sales-public-worker.mjs", import.meta.url), "utf8");
  for (const [slug, sku] of Object.entries(OFFICIAL_PURCHASE_SKUS)) {
    assert.ok(SUPPORT_PRODUCTS[slug], "missing product " + slug);
    assert.match(source, new RegExp(sku));
    assert.equal(purchaseLinkFor(slug, true), BUY_ROOT + sku + WHATSAPP_UTM);
    assert.equal(purchaseLinkFor(slug, false), null);
    assert.equal(validateReply(BUY_ROOT + sku + WHATSAPP_UTM).ok, true);
    assert.equal(validateReply(BUY_ROOT + sku).ok, false);
  }
  assert.equal(purchaseLinkFor("unknown-product", true), null);
  assert.equal(validateReply(BUY_ROOT + "FAKE-SKU").ok, false);
});
test("seller never sends checkout URL while owner sales are closed", async () => {
  assert.doesNotMatch(catalogFacts({ salesOpen: false }), /\/comprar\/ZEV-/);
  const answer = await converse({ question: "Quanto custa o combo?", salesOpen: false });
  assert.doesNotMatch(answer.body, /\/comprar\/ZEV-/);
});
test("owner-open inbound question receives one verified checkout SKU", async () => {
  const answer = await converse({ question: "Quanto custa o combo?", salesOpen: true });
  assert.equal(answer.intent, "price");
  assert.match(answer.body, /https:\/\/vendas\.zevanory\.api\.br\/comprar\/ZEV-CMB-011/);
  assert.equal(validateReply(answer.body).ok, true);
});
test("grounded model response also carries correct SKU without fake or external URL", async () => {
  const answer = await converse({
    question: "Quanto custa IA na Prática?",
    salesOpen: true,
    ai: { run: async () => ({ response: "IA na Prática custa R$ 197,00." }) }
  });
  assert.equal(answer.mode, "ai_grounded");
  assert.match(answer.body, /\/comprar\/ZEV-IA-011/);
  assert.equal(validateReply(answer.body).ok, true);
});
test("voice mode does not append a checkout URL", async () => {
  const answer = await converse({ question: "Quanto custa Vendas na Prática?", salesOpen: true, voice: true });
  assert.doesNotMatch(answer.body, /\/comprar\/ZEV-/);
});
test("deploy activates only WhatsApp commercial inbound; owner KV remains authoritative", () => {
  const source = readFileSync(new URL("../scripts/deploy/prepare-central-candidate.py", import.meta.url), "utf8");
  assert.match(source, /c\["vars"\]\["WHATSAPP_SALES_ENABLED"\]="true"/);
  assert.match(source, /c\["vars"\]\["SALE_GLOBALLY_ENABLED"\]="false"/);
  assert.match(source, /c\["vars"\]\["CHECKOUT_ENABLED"\]="true"/);
});


test("AI cannot send a checkout link when sales are closed", async () => {
  const answer = await converse({
    question: "Quanto custa IA na Prática?",
    salesOpen: false,
    ai: { run: async () => ({ response: "Compre agora: " + BUY_ROOT + "ZEV-IA-011" }) }
  });
  assert.doesNotMatch(answer.body, /\/comprar\//);
  assert.notEqual(answer.mode, "ai_grounded");
});

test("AI cannot substitute another valid SKU while sales are open", async () => {
  const answer = await converse({
    question: "Quanto custa IA na Prática?",
    salesOpen: true,
    ai: { run: async () => ({ response: "Compre aqui: " + BUY_ROOT + "ZEV-NGC-011" }) }
  });
  assert.match(answer.body, /\/comprar\/ZEV-IA-011/);
  assert.doesNotMatch(answer.body, /\/comprar\/ZEV-NGC-011/);
  assert.notEqual(answer.mode, "ai_grounded");
});

test("AI cannot add a checkout link when product is not identified", async () => {
  const answer = await converse({
    question: "Olá, quero saber mais",
    salesOpen: true,
    ai: { run: async () => ({ response: "Veja " + BUY_ROOT + "ZEV-IA-011" }) }
  });
  assert.doesNotMatch(answer.body, /\/comprar\//);
});

test("voice replies reject model-supplied checkout links", async () => {
  const answer = await converse({
    question: "Quanto custa IA na Prática?",
    salesOpen: true,
    voice: true,
    ai: { run: async () => ({ response: "Acesse " + BUY_ROOT + "ZEV-IA-011" }) }
  });
  assert.doesNotMatch(answer.body, /\/comprar\//);
});

test("WhatsApp attribution is required on every allowed checkout URL", async () => {
  for (const [slug, sku] of Object.entries(OFFICIAL_PURCHASE_SKUS)) {
    const answer = await converse({ question: `Quanto custa ${SUPPORT_PRODUCTS[slug].name}?`, salesOpen: true });
    if (answer.body.includes("/comprar/")) {
      assert.ok(answer.body.includes(BUY_ROOT + sku + WHATSAPP_UTM));
      assert.equal(validateReply(answer.body).ok, true);
    }
    assert.equal(validateReply(BUY_ROOT + sku + "?utm_source=other&utm_medium=chat").ok, false);
  }
});
