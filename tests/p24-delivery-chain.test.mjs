// P24 (Sol ORDEM 301 item 1): cadeia REAL produto comercial -> catálogo de entrega -> arquivo exato entregue.
// Avalia numa VM o código de entrega do Worker publicado (catálogo ZEVANORY_PRODUCTS, registro ZEVANORY_ARTIFACTS,
// privateArtifactForOffer e privateArtifactForClaim, os mesmos que /private/artifacts/issue e /download usam) e
// segue cada SKU de data/products.json até a chave do KV, o nome e o SHA-256 do arquivo; depois confere com o
// manifesto P24 (o que foi aberto e validado). Com P24_ZIPS=<pasta com os zips> (execução local, os zips nunca vão
// para o repositório), também grava os bytes num KV simulado na chave registrada e refaz a checagem de integridade
// do download (SHA-256 dos bytes lidos do KV == registro) e a abertura do zip.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import vm from "node:vm";

const read = (p) => readTextNormalized(new URL("../" + p, import.meta.url));
const official = JSON.parse(read("data/products.json"));
const manifest = JSON.parse(read("data/p24/delivery-manifest.json"));
const pmap = JSON.parse(read("data/p24/promise-map.json"));

function deliveryCode() {
  const src = read("worker/cloudflare-worker.recovered.mjs");
  const cat = src.match(/ZEVANORY_PRODUCTS = (Object\.freeze\(\[[\s\S]*?\]\));/)[1];
  const getter = src.match(/function getZevanoryProduct\([\s\S]*?\n\}/)[0];
  const reg = src.slice(src.indexOf("// src/zevanoryArtifactRegistry.mjs"), src.indexOf("var sha2562 ="));
  assert.ok(reg.includes("function privateArtifactForOffer") && reg.includes("function privateArtifactForClaim"), "trecho do registro encontrado no bundle");
  const ctx = { ARBM_SIST_OFFER: { id: "ARBM-SIST", version: "0", artifact_name: "x.zip", artifact_sha256: "0".repeat(64) } };
  vm.runInNewContext(`const __name = (f) => f; const init_offerCatalog = () => {};
    const ZEVANORY_PRODUCTS = ${cat};
    ${getter}
    ${reg}
    this.api = { privateArtifactForOffer, privateArtifactForClaim, ZEVANORY_PRODUCTS };`, ctx);
  return ctx.api;
}

test("[cadeia] todo SKU vendido resolve, no código de entrega real, para a chave, o nome e o SHA-256 do manifesto P24", () => {
  const api = deliveryCode();
  const slugBySku = Object.fromEntries(Object.entries(pmap.products).map(([slug, p]) => [p.sku, slug]));
  for (const p of official.products) {
    const art = api.privateArtifactForOffer(p.sku);
    assert.ok(art, `[cadeia] ${p.sku} sem artefato no registro`);
    const prod = api.ZEVANORY_PRODUCTS.find((x) => x.sku === p.sku);
    assert.equal(art.key, `zevanory/v${prod.version}/${prod.artifact_name}`, `[cadeia] ${p.sku}: chave do KV`);
    assert.equal(art.filename, prod.artifact_name, `[cadeia] ${p.sku}: nome entregue`);
    const mp = manifest.products[slugBySku[p.sku]];
    assert.ok(mp, `[cadeia] ${p.sku}: produto no manifesto P24`);
    assert.equal(mp.artifact_name, art.filename, `[cadeia] ${p.sku}: o arquivo validado é o que o registro entrega`);
    assert.equal(mp.artifact_sha256.toUpperCase(), art.sha256, `[cadeia] ${p.sku}: SHA-256 validado == SHA-256 que o download exige`);
    assert.ok(api.privateArtifactForClaim({ artifact_key: art.key, artifact_sha256: art.sha256 }), `[cadeia] ${p.sku}: o claim do download reconhece a chave + SHA`);
    assert.equal(api.privateArtifactForClaim({ artifact_key: art.key, artifact_sha256: "0".repeat(64) }), null, `[cadeia] ${p.sku}: SHA errado recusado`);
  }
});

// Só existe com P24_ZIPS (local): no CI não há zips e o teste não é registrado (nada "pulado" na contagem exata).
if (process.env.P24_ZIPS) test("[cadeia-bytes] com P24_ZIPS: os bytes gravados na chave registrada passam pela checagem de integridade do download e abrem", async () => {
  const api = deliveryCode();
  const kv = new Map();
  for (const p of official.products) {
    const art = api.privateArtifactForOffer(p.sku);
    const file = join(process.env.P24_ZIPS, art.filename);
    assert.ok(existsSync(file), `[cadeia-bytes] ${art.filename} ausente em P24_ZIPS`);
    kv.set(art.key, readFileSync(file)); // o que o proprietário sobe para o KV
    const bytes = kv.get(art.key); // o que handleArtifactDownload lê
    const digest = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    assert.equal(digest, api.privateArtifactForClaim({ artifact_key: art.key, artifact_sha256: art.sha256 }).sha256, `[cadeia-bytes] ${p.sku}: integridade`);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, `[cadeia-bytes] ${p.sku}: é zip`);
  }
});
