import test from "node:test";
import assert from "node:assert/strict";
import worker, {HOTMART_CHECKOUT, SERVICE_CHECKOUT} from "../worker/sales-public-worker.mjs";

// Owner decision 14/10/2026: with the owner switch closed, NO Hotmart purchase path may be served.
const ctx = {waitUntil() {}};
const env = (status) => ({
  CORE: {fetch: async () => (status === "throw" ? Promise.reject(new Error("down")) : new Response(JSON.stringify({open: status === "open"}), {status: 200}))},
  ASSETS: {fetch: async () => new Response('<html><head></head><body><a href="/comprar/ZEV-IA-011">Comprar</a></body></html>', {status: 200})},
});
const get = (path, e) => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, {headers: {"user-agent": "Mozilla/5.0"}}), e, ctx);

for (const state of ["closed", "throw"]) {
  test(`sales ${state}: /hotmart/<slug> shows paused page, no pay.hotmart link`, async () => {
    for (const slug of Object.keys(HOTMART_CHECKOUT)) {
      const r = await get("/hotmart/" + slug, env(state));
      const body = await r.text();
      assert.equal(r.status, 200, slug);
      assert.match(body, /Vendas pausadas/, slug);
      assert.doesNotMatch(body, /pay\.hotmart\.com/, slug);
      assert.match(body, new RegExp(`href="/${slug}"`), slug + " keeps the informative page");
    }
  });
  test(`sales ${state}: /assinar/conteudo-pronto does not redirect to Hotmart`, async () => {
    const r = await get("/assinar/conteudo-pronto", env(state));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("location"), null);
    const body = await r.text();
    assert.match(body, /Assinaturas pausadas/);
    assert.doesNotMatch(body, /pay\.hotmart\.com/);
  });
}

test("sales open: previous behaviour preserved (Hotmart link and subscribe redirect)", async () => {
  const r = await get("/hotmart/ia-na-pratica", env("open"));
  assert.equal(r.status, 200);
  assert.match(await r.text(), /href="https:\/\/pay\.hotmart\.com\//);
  const s = await get("/assinar/conteudo-pronto", env("open"));
  assert.equal(s.status, 302);
  assert.ok(String(s.headers.get("location")).startsWith(SERVICE_CHECKOUT.split("?")[0]));
});

test("unknown slug stays 404 regardless of switch", async () => {
  assert.equal((await get("/hotmart/nao-existe", env("closed"))).status, 404);
});

test("Lucro & Caixa name is HTML-escaped on the paused page", async () => {
  const body = await (await get("/hotmart/lucro-e-caixa", env("closed"))).text();
  assert.match(body, /Lucro &amp; Caixa/);
});
