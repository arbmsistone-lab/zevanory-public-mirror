import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/sales-public-worker.mjs";

const html = "<!doctype html><html><head><title>t</title></head><body><main><h1>IA</h1>" + "conteudo ".repeat(800) + "</main></body></html>";
const env = { ASSETS: { fetch: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) } };
const ctx = { waitUntil() {} };

test("sales pages are no-transform (no edge script injection) and gzipped by the Worker", async () => {
  const res = await worker.fetch(new Request("https://vendas.zevanory.api.br/ia-na-pratica", { headers: { "accept-encoding": "gzip, br" } }), env, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-transform/);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.match(res.headers.get("vary") || "", /accept-encoding/i);
  const raw = new Uint8Array(await res.arrayBuffer());
  assert.ok(raw.length < html.length / 5, "compressed");
  const text = await new Response(new Response(raw).body.pipeThrough(new DecompressionStream("gzip"))).text();
  assert.equal(text, html);
});

test("clients without gzip get the plain page", async () => {
  const res = await worker.fetch(new Request("https://vendas.zevanory.api.br/ia-na-pratica"), env, ctx);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(await res.text(), html);
});
