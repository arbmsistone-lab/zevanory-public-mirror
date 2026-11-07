// P18 verificação comercial (Roteiro v4.9, seção 5/P18, R15; VC-H controles 7 e 10). Sem rede: fixtures HTML
// sintéticas (tests/fixtures/p18-commercial) e fetch falso. Cada asserção leva um marcador [P18C.n] usado pelos
// mutantes (scripts/ci/mutants_p18_commercial.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllowlist, validateAllowlist, extractPurchaseLinks, checkLinkShape, readSalesMode, classifyCheckout, decideCheckout,
  decideSiteRoute, safeGet, safeInit, assertSafeInit, runOffline, runLive, buildReport, workerCheckoutLinks, PASS, FAIL, MAX_REDIRECTS,
} from "../scripts/b0/p18-commercial.mjs";

const FX = (n) => readFileSync(new URL("./fixtures/p18-commercial/" + n, import.meta.url), "utf8");
const allow = loadAllowlist(".");
const P = (slug) => allow.products.find((p) => p.slug === slug);
const IA = P("ia-na-pratica");
const IA_URL = "https://pay.hotmart.com/F107979716H?off=g9knd34r";

test("lista fechada: arquivo real válido e um para um com data/products.json (5 kits + assinatura)", () => {
  assert.equal(allow.products.length, 6, "[P18C.1] seis produtos na lista fechada");
  const off = runOffline(".");
  const cat = off.results.filter((r) => r.source === "data/products.json");
  assert.equal(cat.length, 6, "[P18C.1] seis produtos do catálogo conferidos");
  assert.ok(cat.every((r) => r.verdict === PASS), "[P18C.1] catálogo inteiro na lista fechada");
  assert.deepEqual(allow.products.map((p) => p.hotmart_product_id), ["8704733", "8704826", "8704851", "8704861", "8704871", "8704905"], "[P18C.1] IDs Hotmart");
  const dup = structuredClone(allow); dup.products[1].checkout_code = dup.products[0].checkout_code;
  assert.throws(() => validateAllowlist(dup), /duplicate checkout_code/, "[P18C.1] código de checkout duplicado derruba");
  const noProd = structuredClone(allow); delete noProd.producer.cnpj;
  assert.throws(() => validateAllowlist(noProd), /producer/, "[P18C.1] produtor sem CNPJ derruba");
});

test("modo offline: links do Worker de vendas = lista fechada; páginas estáticas sem link de compra", () => {
  const r = runOffline(".");
  assert.equal(r.verdict, PASS, "[P18C.2] repositório atual passa: " + JSON.stringify(r.results.filter((x) => x.verdict === FAIL)));
  assert.equal(r.results.filter((x) => x.source === "worker/sales-public-worker.mjs").length, 6, "[P18C.2] seis links do Worker conferidos");
  assert.ok(r.pages_scanned >= 10, "[P18C.2] páginas de sales-public/ lidas");
  const w = workerCheckoutLinks('export const HOTMART_CHECKOUT=Object.freeze({\n "ia-na-pratica":"https://pay.hotmart.com/F107979716H?off=g9knd34r",\n});\nexport const SERVICE_CHECKOUT="https://pay.hotmart.com/X107980075B?off=4ydutio7";\nconst x="https://pay.hotmart.com/Q1?off=z";');
  assert.equal(w.pairs.length, 2, "[P18C.2] pares slug->URL extraídos");
  assert.equal(w.all.length, 3, "[P18C.2] URL solta fora dos pares é vista");
});

// Árvore mínima temporária para o modo offline com uma divergência injetada por vez.
function offlineTree(mutate) {
  const d = mkdtempSync(join(tmpdir(), "p18c-"));
  for (const rel of ["data/p18-commercial-allowlist.json", "data/products.json", "worker/sales-public-worker.mjs"]) {
    mkdirSync(join(d, rel, ".."), { recursive: true }); copyFileSync(rel, join(d, rel));
  }
  mkdirSync(join(d, "sales-public"), { recursive: true });
  writeFileSync(join(d, "sales-public", "ia-na-pratica.html"), FX("site-hotmart-paused.html"));
  mutate(d);
  try { return runOffline(d); } finally { rmSync(d, { recursive: true, force: true }); }
}
test("modo offline reprova: link de compra em página estática, URL solta no Worker, catálogo fora da lista", () => {
  const clean = offlineTree(() => {});
  assert.equal(clean.verdict, PASS, "[P18C.17] árvore mínima limpa passa");
  const page = offlineTree((d) => writeFileSync(join(d, "sales-public", "ia-na-pratica.html"), FX("site-hotmart-open.html")));
  assert.deepEqual(page.results.filter((x) => x.verdict === FAIL).map((x) => x.reason), ["static_page_buy_link:in_closed_list"], "[P18C.17] página estática com checkout (mesmo da lista) reprova");
  const loose = offlineTree((d) => { const f = join(d, "worker/sales-public-worker.mjs"); writeFileSync(f, readFileSync(f, "utf8") + '\nconst LEGACY="https://pay.hotmart.com/Q1?off=z";\n'); });
  assert.deepEqual(loose.results.filter((x) => x.verdict === FAIL).map((x) => x.reason), ["checkout_url_outside_registered_pairs"], "[P18C.17] URL de checkout solta no Worker reprova");
  const cat = offlineTree((d) => { const f = join(d, "data/products.json"); const j = JSON.parse(readFileSync(f, "utf8")); j.products[0].name = "IA Pro"; writeFileSync(f, JSON.stringify(j)); });
  assert.deepEqual(cat.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [["ia-na-pratica", "catalog_name_or_sku_diverges"]], "[P18C.17] catálogo divergente reprova");
});

test("forma do link: host, código, oferta, parâmetros, https, porta, userinfo, fragmento", () => {
  assert.equal(checkLinkShape(IA_URL, allow, { pageSlug: "ia-na-pratica" }).ok, true, "[P18C.3] link oficial passa");
  assert.equal(checkLinkShape(IA_URL + "&src=site_x-1", allow).ok, true, "[P18C.3] src válido passa");
  const bad = {
    "http://pay.hotmart.com/F107979716H?off=g9knd34r": "not_https",
    "https://pay.hotmart.com.evil.example/F107979716H?off=g9knd34r": "host_not_allowed",
    "https://go.hotmart.com/F107979716H?off=g9knd34r": "host_not_allowed",
    "https://pay.hotmart.com/Z999999999Z?off=g9knd34r": "checkout_code_not_in_closed_list",
    "https://pay.hotmart.com/F107979716H?off=8mg88sdd": "offer_mismatch",
    "https://pay.hotmart.com/F107979716H": "offer_mismatch",
    "https://pay.hotmart.com/F107979716H?off=g9knd34r&aff=1": "unexpected_param",
    "https://pay.hotmart.com/F107979716H?off=g9knd34r&off=g9knd34r": "duplicate_query_param",
    "https://pay.hotmart.com/F107979716H?off=g9knd34r&src=<x>": "src_invalid",
    "https://pay.hotmart.com:8443/F107979716H?off=g9knd34r": "port_present",
    "https://u:p@pay.hotmart.com/F107979716H?off=g9knd34r": "userinfo_present",
    "https://pay.hotmart.com/F107979716H?off=g9knd34r#x": "fragment_present",
  };
  for (const [u, why] of Object.entries(bad)) {
    const s = checkLinkShape(u, allow);
    assert.equal(s.ok, false, "[P18C.3] reprovado: " + u);
    assert.ok(s.reason.startsWith(why), `[P18C.3] motivo ${why} para ${u}: ${s.reason}`);
  }
});

test("produto da página: link de outro produto na página de um produto é FAIL", () => {
  const s = checkLinkShape("https://pay.hotmart.com/H107979990T?off=b3ytmah4", allow, { pageSlug: "ia-na-pratica" });
  assert.equal(s.ok, false, "[P18C.4] combo na página do IA reprova");
  assert.match(s.reason, /^wrong_product_for_page:ia-na-pratica->combo-ia-vendas/, "[P18C.4] motivo");
});

test("extração: links de compra internos e externos, ignorando reembolso e Minhas compras", () => {
  const l = extractPurchaseLinks(FX("page-mixed-links.html"), allow, { source: "t", slug: "ia-na-pratica" });
  const kinds = l.map((x) => x.kind + " " + x.href).sort();
  assert.deepEqual(kinds, [
    "external_checkout https://pay.hotmart.com/F107979716H?off=g9knd34r",
    "external_checkout https://pay.kiwify.com.br/abc123",
    "external_checkout https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=1",
    "internal_buy /comprar/ZEV-IA-011",
  ], "[P18C.5] quatro links de compra; informativos fora");
  assert.equal(extractPurchaseLinks(FX("site-hotmart-paused.html"), allow).length, 0, "[P18C.5] página pausada sem link de compra");
});

test("trava global: só globally-blocked ou enabled; o resto é desconhecido (fail-closed)", () => {
  assert.equal(readSalesMode(200, '{"sales_mode":"globally-blocked"}').mode, "globally-blocked", "[P18C.6] bloqueada");
  assert.equal(readSalesMode(200, '{"sales_mode":"enabled"}').mode, "enabled", "[P18C.6] aberta");
  assert.equal(readSalesMode(200, '{"sales_mode":"ENABLED"}').mode, null, "[P18C.6] variação de caixa não vale");
  assert.equal(readSalesMode(200, '{"salesMode":"enabled"}').mode, null, "[P18C.6] campo errado não vale");
  assert.equal(readSalesMode(200, "<html>").mode, null, "[P18C.6] não-JSON");
  assert.equal(readSalesMode(503, '{"sales_mode":"enabled"}').mode, null, "[P18C.6] HTTP diferente de 200");
});

test("checkout fechado (erro 049 / vendas temporariamente encerradas) é reconhecido", () => {
  const c = classifyCheckout({ status: 200, body: FX("hotmart-closed-049.html") }, IA, allow);
  assert.equal(c.state, "closed", "[P18C.7] estado fechado");
  assert.equal(c.identity.product_id_expected_seen, true, "[P18C.7] ID do produto lido do JSON de estado");
  assert.equal(classifyCheckout({ status: 200, body: FX("hotmart-closed-code-only.html") }, IA, allow).state, "closed", "[P18C.7] só o código 049");
  assert.equal(classifyCheckout({ status: 404, body: FX("hotmart-closed-049.html") }, IA, allow).state, "closed", "[P18C.7] fechado com 404");
  assert.equal(classifyCheckout({ status: 200, body: "<p>Pedido 1049 aprovado</p>" }, IA, allow).state, "unverifiable", "[P18C.7] 049 solto não é aviso");
});

test("checkout aberto: produto e produtor esperados", () => {
  const c = classifyCheckout({ status: 200, body: FX("hotmart-open-ok.html") }, IA, allow);
  assert.equal(c.state, "open", "[P18C.8] aberto com identidade");
  assert.equal(c.identity.producer_legal_name_seen, true, "[P18C.8] razão social");
  assert.deepEqual(c.identity.producer_cnpjs_seen, ["69077233000199"], "[P18C.8] CNPJ esperado");
  assert.equal(classifyCheckout({ status: 200, body: FX("hotmart-open-ok.html") }, P("vendas-na-pratica"), allow).state, "mismatch", "[P18C.8] ID de outro produto reprova");
});

test("HTTP 200 sozinho nunca é PASS", () => {
  const shell = classifyCheckout({ status: 200, body: FX("hotmart-spa-shell.html") }, IA, allow);
  assert.equal(shell.state, "unverifiable", "[P18C.9] casca SPA sem evidência");
  assert.equal(shell.reason, "http_200_without_commercial_evidence", "[P18C.9] motivo");
  for (const mode of ["globally-blocked", "enabled"]) assert.equal(decideCheckout(mode, shell).verdict, FAIL, "[P18C.9] FAIL em " + mode);
  const nameOnly = classifyCheckout({ status: 200, body: FX("hotmart-open-name-only.html") }, IA, allow);
  assert.equal(nameOnly.reason, "producer_identity_absent", "[P18C.9] produto sem produtor não basta");
  assert.equal(decideCheckout("enabled", nameOnly).verdict, FAIL, "[P18C.9] FAIL");
  assert.equal(classifyCheckout({ status: 200, body: "<p>Pedido 12345678901234 ok</p>" }, IA, allow).identity.producer_cnpjs_seen.length, 0, "[P18C.9] número de 14 dígitos não é CNPJ");
});

test("produtor divergente reprova, inclusive com vendas fechadas", () => {
  const c = classifyCheckout({ status: 200, body: FX("hotmart-open-wrong-producer.html") }, IA, allow);
  assert.equal(c.state, "mismatch", "[P18C.10] CNPJ de outra empresa");
  assert.equal(c.reason, "producer_cnpj_mismatch", "[P18C.10] motivo");
  const z = classifyCheckout({ status: 200, body: FX("hotmart-closed-wrong-producer.html") }, IA, allow);
  assert.equal(z.reason, "producer_name_forbidden", "[P18C.10] 'Zeva Nory' reprova mesmo fechado");
  assert.equal(decideCheckout("globally-blocked", z).verdict, FAIL, "[P18C.10] FAIL com a trava fechada");
});

test("produto divergente reprova", () => {
  const c = classifyCheckout({ status: 200, body: FX("hotmart-open-wrong-product.html") }, IA, allow);
  assert.equal(c.state, "mismatch", "[P18C.11] ID 9999999");
  assert.equal(c.reason, "product_id_mismatch:9999999", "[P18C.11] motivo");
});

test("matriz de coerência com a trava", () => {
  const closed = { state: "closed", reason: "x" }, open = { state: "open", reason: "x" };
  assert.deepEqual(decideCheckout("globally-blocked", closed), { verdict: PASS, reason: "closed_as_expected" }, "[P18C.12] bloqueada+fechado");
  assert.deepEqual(decideCheckout("globally-blocked", open), { verdict: FAIL, reason: "hotmart_open_while_locked" }, "[P18C.12] bloqueada+aberto");
  assert.deepEqual(decideCheckout("enabled", open), { verdict: PASS, reason: "open_identity_verified" }, "[P18C.12] aberta+aberto");
  assert.deepEqual(decideCheckout("enabled", closed), { verdict: FAIL, reason: "hotmart_closed_while_enabled" }, "[P18C.12] aberta+fechado");
  assert.equal(decideCheckout(null, closed).verdict, FAIL, "[P18C.12] trava desconhecida");
  assert.deepEqual(decideCheckout(null, open), { verdict: FAIL, reason: "release_unknown" }, "[P18C.12] trava desconhecida com checkout aberto");
  const paused = { status: 200, headers: {}, body: FX("site-hotmart-paused.html") }, openPage = { status: 200, headers: {}, body: FX("site-hotmart-open.html") };
  assert.equal(decideSiteRoute("globally-blocked", paused, IA, allow).verdict, PASS, "[P18C.12] rota pausada com trava fechada");
  assert.equal(decideSiteRoute("globally-blocked", openPage, IA, allow).reason, "site_route_checkout_while_locked", "[P18C.12] rota com checkout e trava fechada");
  assert.equal(decideSiteRoute("enabled", openPage, IA, allow).verdict, PASS, "[P18C.12] rota aberta com link da lista");
  assert.equal(decideSiteRoute("enabled", paused, IA, allow).verdict, FAIL, "[P18C.12] rota pausada com trava aberta");
  assert.match(decideSiteRoute("enabled", { status: 200, headers: {}, body: FX("site-hotmart-open-foreign.html") }, IA, allow).reason, /checkout_code_not_in_closed_list/, "[P18C.12] link fora da lista");
  const svc = { status: 302, headers: { location: "https://pay.hotmart.com/X107980075B?off=4ydutio7&src=site" }, body: "" };
  assert.equal(decideSiteRoute("enabled", svc, P("conteudo-pronto"), allow).verdict, PASS, "[P18C.12] /assinar 302 para a oferta certa");
  assert.equal(decideSiteRoute("globally-blocked", svc, P("conteudo-pronto"), allow).verdict, FAIL, "[P18C.12] /assinar 302 com trava fechada");
});

test("GET seguro: só GET, sem corpo, sem cookie, sem Authorization, redirecionamento conferido", async () => {
  const seen = [];
  const fake = (routes) => async (url, init) => { seen.push({ url, init }); const r = routes[url]; return { status: r[0], headers: { get: (k) => (k === "location" ? r[1] ?? null : null) }, text: async () => r[2] ?? "" }; };
  const r = await safeGet("https://pay.hotmart.com/A", { fetchImpl: fake({ "https://pay.hotmart.com/A": [302, "/B"], "https://pay.hotmart.com/B": [200, null, "ok"] }), allowHosts: ["pay.hotmart.com"] });
  assert.equal(r.status, 200, "[P18C.13] segue salto dentro da lista");
  assert.equal(r.hops.length, 2, "[P18C.13] saltos registrados");
  for (const s of seen) {
    assert.equal(s.init.method, "GET", "[P18C.13] método GET");
    assert.equal(s.init.body, undefined, "[P18C.13] sem corpo");
    assert.equal(s.init.credentials, "omit", "[P18C.13] credentials omit");
    assert.equal(s.init.redirect, "manual", "[P18C.13] redirect manual");
    assert.deepEqual(Object.keys(s.init.headers).sort(), ["accept", "accept-language", "user-agent"], "[P18C.13] só cabeçalhos neutros");
  }
  const out = await safeGet("https://pay.hotmart.com/A", { fetchImpl: fake({ "https://pay.hotmart.com/A": [302, "https://evil.example/x"] }), allowHosts: ["pay.hotmart.com"] });
  assert.match(out.error, /^redirect_host_not_allowed/, "[P18C.13] salto para fora da lista para");
  const loop = {}; for (let i = 0; i <= MAX_REDIRECTS + 1; i++) loop["https://pay.hotmart.com/L" + i] = [302, "/L" + (i + 1)];
  assert.equal((await safeGet("https://pay.hotmart.com/L0", { fetchImpl: fake(loop), allowHosts: ["pay.hotmart.com"] })).error, "too_many_redirects", "[P18C.13] limite de saltos");
  for (const bad of [{ ...safeInit(), method: "POST" }, { ...safeInit(), body: "x" }, { ...safeInit(), credentials: "include" }, { ...safeInit(), redirect: "follow" }, { ...safeInit(), headers: { cookie: "a=b" } }, { ...safeInit(), headers: { authorization: "x" } }])
    assert.throws(() => assertSafeInit(bad), /P18C_UNSAFE_REQUEST/, "[P18C.13] requisição insegura recusada");
});

// Rede falsa para o modo live: trava, rotas do site e checkouts por URL.
function liveFake({ release = [200, '{"sales_mode":"globally-blocked"}'], site = () => [200, null, FX("site-hotmart-paused.html")], checkout = () => [200, null, FX("hotmart-closed-049.html")] } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method });
    let r;
    if (url === allow.release_url) r = release === "throw" ? (() => { throw new Error("ECONNRESET"); })() : [release[0], null, release[1]];
    else if (url.startsWith(allow.site_origin)) r = site(url);
    else r = checkout(url);
    return { status: r[0], headers: { get: (k) => (k === "location" ? r[1] : null) }, text: async () => r[2] };
  };
  f.calls = calls;
  return f;
}
const productFixture = (slug, kind) => FX(kind).replace(/8704733/g, P(slug).hotmart_product_id).replace(/IA na Pr(á|\\u00e1)tica/g, P(slug).name);

test("live, trava fechada: checkouts fechados e rotas pausadas passam; checkout aberto com a trava fechada reprova", async () => {
  const f = liveFake({ checkout: (u) => [200, null, productFixture(allow.products.find((p) => u.includes(p.checkout_code)).slug, "hotmart-closed-049.html")] });
  const r = await runLive({ allow, fetchImpl: f });
  assert.equal(r.sales_mode, "globally-blocked", "[P18C.14] trava lida");
  assert.equal(r.counts.total, 12, "[P18C.14] 6 rotas + 6 checkouts");
  assert.equal(r.verdict, PASS, "[P18C.14] tudo coerente: " + JSON.stringify(r.results.filter((x) => x.verdict === FAIL)));
  assert.ok(f.calls.every((c) => c.method === "GET"), "[P18C.14] só GET");
  assert.ok(!f.calls.some((c) => /\/comprar\//.test(c.url)), "[P18C.14] nunca /comprar");
  const g = liveFake({ checkout: (u) => (u.includes("F107979716H") ? [200, null, FX("hotmart-open-ok.html")] : [200, null, productFixture(allow.products.find((p) => u.includes(p.checkout_code)).slug, "hotmart-closed-049.html")]) });
  const r2 = await runLive({ allow, fetchImpl: g });
  assert.equal(r2.verdict, FAIL, "[P18C.14] divergência derruba o relatório");
  const bad = r2.results.filter((x) => x.verdict === FAIL);
  assert.equal(bad.length, 1, "[P18C.14] só o link divergente");
  assert.equal(bad[0].reason, "hotmart_open_while_locked", "[P18C.14] motivo");
  const h = liveFake({ site: (u) => (u.endsWith("/hotmart/lucro-e-caixa") ? [200, null, FX("site-hotmart-open.html")] : [200, null, FX("site-hotmart-paused.html")]),
    checkout: (u) => [200, null, productFixture(allow.products.find((p) => u.includes(p.checkout_code)).slug, "hotmart-closed-049.html")] });
  const r3 = await runLive({ allow, fetchImpl: h });
  assert.deepEqual(r3.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [["lucro-e-caixa", "site_route_checkout_while_locked"]], "[P18C.14] rota do site aberta com a trava fechada");
});

test("live, trava aberta e trava ilegível", async () => {
  const site = (u) => {
    const p = allow.products.find((x) => u.endsWith(x.site_route));
    const href = `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}&src=site`;
    return p.kind === "subscription" ? [302, href, ""] : [200, null, `<a href="${href.replace(/&/g, "&amp;")}">Comprar</a>`];
  };
  const f = liveFake({ release: [200, '{"sales_mode":"enabled"}'], site, checkout: (u) => [200, null, productFixture(allow.products.find((p) => u.includes(p.checkout_code)).slug, "hotmart-open-ok.html")] });
  const r = await runLive({ allow, fetchImpl: f });
  assert.equal(r.verdict, PASS, "[P18C.15] aberto e coerente: " + JSON.stringify(r.results.filter((x) => x.verdict === FAIL)));
  const g = liveFake({ release: "throw" });
  const r2 = await runLive({ allow, fetchImpl: g });
  assert.equal(r2.sales_mode, null, "[P18C.15] trava fora do ar");
  assert.equal(r2.counts.fail, r2.counts.total, "[P18C.15] todos os links FAIL");
  assert.ok(r2.results.every((x) => x.reason.startsWith("release_")), "[P18C.15] motivo da trava em cada link");
});

test("relatório: nenhum link conferido nunca é PASS", () => {
  const r = buildReport("live", []);
  assert.equal(r.verdict, FAIL, "[P18C.16] vazio reprova");
  assert.equal(r.reason, "no_links_checked", "[P18C.16] motivo");
  assert.equal(buildReport("live", [{ verdict: PASS }, { verdict: FAIL }]).verdict, FAIL, "[P18C.16] um FAIL derruba");
});
