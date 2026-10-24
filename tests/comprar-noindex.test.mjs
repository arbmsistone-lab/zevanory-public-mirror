import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync} from "node:fs";
import {readTextNormalized} from "./helpers/text.mjs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import worker, {percentDecodeOnce, comprarMatch} from "../worker/sales-public-worker.mjs";
import {WHATSAPP_PUBLIC_RE, WHATSAPP_CHANNEL_RE} from "../worker/politica-unica.mjs";

// Auditor Sol (AVAL 100): /comprar/ on vendas.zevanory.api.br stays out of search indexes by the
// response itself (X-Robots-Tag noindex,nofollow + Cache-Control no-store + robots meta in HTML),
// not by robots.txt. A robots.txt Disallow would stop crawlers from fetching the page, so they would
// never see the noindex: https://developers.google.com/search/docs/crawling-indexing/block-indexing
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readTextNormalized(join(ROOT, p));
const SKUS = ["ZEV-IA-011", "ZEV-VEN-011", "ZEV-LCX-011", "ZEV-CMB-011", "ZEV-NGC-011"];
const BROWSER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const MP_URL = "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1";

// sales: open | closed | error500 | throw ; checkout: ok | fail ; limiter: ok | limited ; core: false => no binding
function makeEnv({sales = "closed", checkout = "ok", limiter = "ok", core = true} = {}) {
  const env = {
    ASSETS: {fetch: async () => new Response("<!doctype html><html><head><title>x</title></head><body>asset</body></html>", {status: 404, headers: {"content-type": "text/html; charset=utf-8"}})},
    BUY_LIMITER: {limit: async () => ({success: limiter === "ok"})},
  };
  if (core) env.CORE = {fetch: async (input) => {
    const u = String(input && input.url || input);
    if (u.endsWith("/api/sales/status")) {
      if (sales === "throw") throw new Error("down");
      if (sales === "error500") return new Response("{}", {status: 500});
      return new Response(JSON.stringify({open: sales === "open"}), {status: 200});
    }
    if (u.includes("checkout.internal")) return checkout === "ok"
      ? new Response(JSON.stringify({checkout_url: MP_URL}), {status: 201})
      : new Response(JSON.stringify({error: "x"}), {status: 500});
    return new Response("{}", {status: 404});
  }};
  return env;
}
const okCtx = {waitUntil() {}};
const call = (path, {method = "GET", ua = BROWSER, env = makeEnv(), ctx = okCtx} = {}) =>
  worker.fetch(new Request("https://vendas.zevanory.api.br" + path, {method, headers: {"user-agent": ua, "cf-connecting-ip": "203.0.113.9"}}), env, ctx);

function assertNoWhatsapp(body, label) {
  const m = WHATSAPP_PUBLIC_RE.exec(body) || WHATSAPP_CHANNEL_RE.exec(body);
  assert.equal(m && m[0], null, label + " [whatsapp]");
}
async function assertNoindex(r, label, expectStatus) {
  if (expectStatus !== undefined) assert.equal(r.status, expectStatus, label + " [status]");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", label + " [x-robots-tag]");
  assert.equal(r.headers.get("cache-control"), "no-store", label + " [cache-control]");
  const body = await r.text();
  // Oráculo cruzado (AVAL Sol #892): WhatsApp da ZEVANORY banido; nenhum corpo de /comprar (qualquer status,
  // alias ou dupla codificação) pode ter wa.me, api.whatsapp.com, whatsapp://, o número banido ou chamada de canal.
  assertNoWhatsapp(body, label);
  if (/^text\/html/i.test(r.headers.get("content-type") || "")) {
    const metas = body.match(/<meta name="robots"[^>]*>/gi) || [];
    assert.deepEqual(metas, ['<meta name="robots" content="noindex,nofollow">'], label + " [meta]");
  }
  return body;
}

// Every product x every state of the buy flow; each case names the status it must produce.
const CASES = [
  ["closed GET (Vendas abrem em breve)", {}, {}, 200, /Vendas abrem em breve/],
  ["closed HEAD", {method: "HEAD"}, {}, 200, null],
  ["closed POST", {method: "POST"}, {}, 200, /Vendas abrem em breve/],
  ["status 500 = closed", {}, {sales: "error500"}, 200, /Vendas abrem em breve/],
  ["status throw = closed", {}, {sales: "throw"}, 200, /Vendas abrem em breve/],
  ["no core binding (503)", {}, {core: false}, 503, /Checkout indisponível/],
  ["open GET confirmation", {}, {sales: "open"}, 200, /Ir para o pagamento seguro/],
  ["open HEAD", {method: "HEAD"}, {sales: "open"}, 200, null],
  ["open POST -> Mercado Pago (303)", {method: "POST"}, {sales: "open"}, 303, null],
  ["open POST automation UA (403)", {method: "POST", ua: "curl/8.0"}, {sales: "open"}, 403, /Acesso não permitido/],
  ["open POST rate limited (429)", {method: "POST"}, {sales: "open", limiter: "limited"}, 429, /Muitas tentativas/],
  ["open POST checkout failure (503)", {method: "POST"}, {sales: "open", checkout: "fail"}, 503, /Não foi possível abrir o pagamento/],
  ["PUT (405)", {method: "PUT"}, {sales: "open"}, 405, null],
  ["DELETE closed (405)", {method: "DELETE"}, {}, 405, null],
];

test("every product and every buy-flow state carries X-Robots-Tag noindex,nofollow, no-store and the robots meta", async () => {
  for (const sku of SKUS) for (const path of ["/comprar/" + sku, "/comprar/" + sku + "/", "/comprar/" + sku.toLowerCase()]) {
    for (const [name, opts, envOpts, status, bodyRe] of CASES) {
      const label = `${path} ${name}`;
      const r = await call(path, {...opts, env: makeEnv(envOpts)});
      const body = await assertNoindex(r, label, status);
      if (bodyRe) assert.match(body, bodyRe, label);
      if (status === 303) assert.equal(r.headers.get("location"), MP_URL, label);
    }
  }
});

test("unknown, malformed or nested /comprar paths never fall through to an indexable response", async () => {
  for (const path of ["/comprar", "/comprar/", "/comprar/x", "/comprar/ZEV-XXX-999", "/comprar/ZEV-IA-011/extra",
    "/comprar/index.html", "/comprar/../comprar/ZEV-IA-011x", "/COMPRAR/ZEV-IA-011", "/Comprar/", "/comprar/ZEV-IA-011?utm_source=x"]) {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      const r = await call(path, {method, env: makeEnv({sales: "open"})});
      assert.ok(r.status >= 200 && r.status < 600, path);
      await assertNoindex(r, `${method} ${path}`);
    }
  }
  const unknown = await call("/comprar/ZEV-XXX-999");
  await assertNoindex(unknown, "unknown sku", 404);
});

test("an unexpected exception inside the buy flow still answers 5xx with the noindex headers", async () => {
  const throwingCtx = {waitUntil() { throw new Error("boom"); }};
  let r;
  try { r = await call("/comprar/ZEV-IA-011", {env: makeEnv({sales: "open"}), ctx: throwingCtx}); }
  catch (e) { assert.fail("[exception] buy flow threw instead of answering 503: " + e.message); }
  const body = await assertNoindex(r, "exception", 503);
  assert.match(body, /Checkout indisponível/, "[exception]");
});

test("percent-encoded aliases of /comprar are decoded once (URL rules) and get the same flow and headers", async () => {
  // Single-encoded aliases are equivalent to /comprar under URL rules: same buy flow, same noindex/no-store.
  const routable = ["/%63omprar/ZEV-IA-011", "/comp%72ar/ZEV-IA-011", "/co%6Dprar/ZEV-IA-011", "/co%6dprar/ZEV-IA-011",
    "/%63%6F%6D%70%72%61%72/ZEV-IA-011", "/%43OMPRAR/zev-ia-011", "/Co%4DpRaR/ZEV-IA-011", "/comprar/%5AEV-IA-011", "/comprar%2FZEV-IA-011"];
  for (const path of routable) {
    const closed = await call(path);
    assert.match(await assertNoindex(closed, `[alias] closed ${path}`, 200), /Vendas abrem em breve/, `[alias] ${path}`);
    const open = await call(path, {method: "POST", env: makeEnv({sales: "open"})});
    await assertNoindex(open, `[alias] open POST ${path}`, 303);
  }
  for (const path of ["/%63omprar", "/%63omprar/", "/comp%72ar/x", "/%63omprar/%ZZ", "/%63omprar/ZEV-IA-011/extra"]) {
    await assertNoindex(await call(path, {env: makeEnv({sales: "open"})}), `[alias] ${path}`, 404);
  }
  // Double (or deeper) encoding is NOT /comprar under URL rules: never routed to the buy flow, but still noindex.
  for (const path of ["/%2563omprar/ZEV-IA-011", "/comp%2572ar/ZEV-IA-011", "/%25252563omprar/ZEV-IA-011", "/%2563omprar/"]) {
    for (const method of ["GET", "POST"]) {
      const r = await call(path, {method, env: makeEnv({sales: "open"})});
      const body = await assertNoindex(r, `[double] ${method} ${path}`, 404);
      assert.doesNotMatch(body, /Ir para o pagamento seguro/, `[double] ${path} routed`);
    }
  }
  assert.equal(comprarMatch("/%63omprar-agora"), null, "[alias] prefix without separator is not /comprar");
  assert.equal(percentDecodeOnce("/%E2%82%AC%zz%4"), "/€%zz%4", "[decode] UTF-8 and malformed escapes");
  assert.equal(percentDecodeOnce("/%FF"), "/\uFFFD", "[decode] invalid UTF-8 becomes U+FFFD");
  assert.equal(percentDecodeOnce("/%2563"), "/%63", "[decode] exactly one round");
});

test("noindex,nofollow stays scoped to /comprar: product pages keep index,follow", async () => {
  const env = makeEnv();
  env.ASSETS = {fetch: async () => new Response("<html><head></head><body>p</body></html>", {status: 200, headers: {"content-type": "text/html"}})};
  for (const path of ["/solucoes", "/ia-na-pratica", "/comprar-agora-nao-existe"]) {
    const r = await call(path, {env});
    assert.notEqual(r.headers.get("x-robots-tag"), "noindex, nofollow", path);
  }
});

test("no sitemap lists a /comprar URL", () => {
  for (const file of ["sales-public/sitemap.xml", "sitemap.xml"]) {
    const xml = read(file);
    assert.ok(/<urlset/.test(xml), file + " parsed");
    assert.doesNotMatch(xml, /\/comprar(\/|<|\?|$)/im, `[sitemap:${file}]`);
  }
});

test("robots.txt for vendas does not Disallow /comprar (crawlers must fetch it to see the noindex)", () => {
  const files = ["sales-public/robots.txt", "sales-overlay/robots.txt"];
  for (const file of files) {
    const txt = read(file);
    assert.match(txt, /^Sitemap: https:\/\/vendas\.zevanory\.api\.br\/sitemap\.xml$/m, file);
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*disallow\s*:\s*(\S*)/i.exec(line);
      if (!m) continue;
      const rule = m[1];
      // Any Disallow that matches /comprar/ (/, /c, /comp*, /*comprar...) hides the noindex header.
      const re = new RegExp("^" + rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      assert.ok(rule === "" || !re.test("/comprar/ZEV-IA-011"), `[robots:${file}] "${line.trim()}" blocks /comprar/`);
    }
  }
  assert.equal(read(files[0]), read(files[1]), "published robots.txt must equal the overlay source");
});

test("no published sales page points a canonical, og:url or alternate link at /comprar", () => {
  const dir = join(ROOT, "sales-public");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length > 50, "sales pages found");
  for (const f of pages) {
    const html = readTextNormalized(join(dir, f));
    assert.doesNotMatch(html, /<link[^>]*rel="(canonical|alternate)"[^>]*href="[^"]*\/comprar\//i, f + " [canonical]");
    assert.doesNotMatch(html, /<link[^>]*href="[^"]*\/comprar\/[^"]*"[^>]*rel="(canonical|alternate)"/i, f + " [canonical]");
    assert.doesNotMatch(html, /<meta property="og:url" content="[^"]*\/comprar\//i, f + " [og:url]");
  }
});
