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

// Delta r2 (ordem GPT-6 15/10 13:03): estados inválidos, métodos e cache.
const envRaw = (status, body) => ({CORE: {fetch: async () => new Response(body, {status})}, ASSETS: env("open").ASSETS});
for (const [label, e] of [["HTTP 500 com open:true", envRaw(500, JSON.stringify({open: true}))], ["corpo não JSON", envRaw(200, "<html>erro</html>")],
                          ['open como texto "true"', envRaw(200, JSON.stringify({open: "true"}))], ["open:1", envRaw(200, JSON.stringify({open: 1}))],
                          ["sem campo open", envRaw(200, "{}")]]) {
  test(`status inválido (${label}) = fechado: nenhuma rota leva à Hotmart`, async () => {
    const h = await get("/hotmart/ia-na-pratica", e);
    assert.doesNotMatch(await h.text(), /pay\.hotmart\.com/);
    const s = await get("/assinar/conteudo-pronto", e);
    assert.equal(s.status, 200);
    assert.equal(s.headers.get("location"), null);
  });
}
test("respostas com estado comercial nunca são cacheáveis (aberto e fechado)", async () => {
  for (const st of ["open", "closed"]) {
    for (const path of ["/hotmart/ia-na-pratica", "/assinar/conteudo-pronto"]) {
      const r = await get(path, env(st));
      assert.equal(r.headers.get("cache-control"), "no-store", st + " " + path);
    }
  }
});
test("métodos: /assinar só GET/HEAD; POST em /hotmart não expõe checkout", async () => {
  for (const m of ["POST", "PUT", "DELETE"]) {
    const r = await worker.fetch(new Request("https://vendas.zevanory.api.br/assinar/conteudo-pronto", {method: m}), env("open"), ctx);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.get("location"), null, m);
  }
  const h = await get("/assinar/conteudo-pronto", env("closed"));
  assert.equal(h.status, 200);
  const head = await worker.fetch(new Request("https://vendas.zevanory.api.br/hotmart/ia-na-pratica", {method: "HEAD"}), env("closed"), ctx);
  assert.equal(head.status, 200);
  const p = await worker.fetch(new Request("https://vendas.zevanory.api.br/hotmart/ia-na-pratica", {method: "POST"}), {...env("open"), ASSETS: {fetch: async () => new Response("not found", {status: 404})}}, ctx);
  assert.doesNotMatch(await p.text(), /pay\.hotmart\.com/);
});
test("/comprar/ continua fechado com status inválido (mesma fonte de verdade)", async () => {
  const r = await get("/comprar/ZEV-IA-011", envRaw(500, JSON.stringify({open: true})));
  assert.match(await r.text(), /Vendas abrem em breve/);
});
