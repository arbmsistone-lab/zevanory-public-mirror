// P18 verificação comercial (Roteiro v4.9, seção 5/P18, R15; VC-H controles 7 e 10). Sem rede: fixtures HTML
// sintéticas (tests/fixtures/p18-commercial) e fetch falso. Cada asserção leva um marcador [P18C.n] usado pelos
// mutantes (scripts/ci/mutants_p18_commercial.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllowlist, validateAllowlist, extractPurchaseLinks, checkLinkShape, readSalesMode, classifyCheckout, decideCheckout,
  decideSiteRoute, safeGet, safeInit, assertSafeInit, runOffline, runLive, buildReport, workerCheckoutLinks, PASS, FAIL, MAX_REDIRECTS,
  loadDirectAuthorization, validateDirectAuthorization, cashPrices, directEntry, decideDirectCheckout,
} from "../scripts/b0/p18-commercial.mjs";

const FX = (n) => readTextNormalized(new URL("./fixtures/p18-commercial/" + n, import.meta.url));
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
  for (const rel of ["data/p18-commercial-allowlist.json", "data/p18-hotmart-direct-authorization.json", "data/products.json", "worker/sales-public-worker.mjs"]) {
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
  const loose = offlineTree((d) => { const f = join(d, "worker/sales-public-worker.mjs"); writeFileSync(f, readTextNormalized(f) + '\nconst LEGACY="https://pay.hotmart.com/Q1?off=z";\n'); });
  assert.deepEqual(loose.results.filter((x) => x.verdict === FAIL).map((x) => x.reason), ["checkout_url_outside_registered_pairs"], "[P18C.17] URL de checkout solta no Worker reprova");
  const cat = offlineTree((d) => { const f = join(d, "data/products.json"); const j = JSON.parse(readTextNormalized(f)); j.products[0].name = "IA Pro"; writeFileSync(f, JSON.stringify(j)); });
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
function liveFake({ release = [200, '{"sales_mode":"globally-blocked"}'], site = () => [200, null, FX("site-hotmart-paused.html")], checkout = () => [200, null, FX("hotmart-closed-049.html")], hotmart = null } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init.method });
    let r;
    if (url === allow.release_url) r = release === "throw" ? (() => { throw new Error("ECONNRESET"); })() : [release[0], null, release[1]];
    else if (hotmart && url === new URL("/api/sales/hotmart-status", allow.release_url).href) r = [hotmart[0], null, hotmart[1]];
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

test("live, modo Hotmart (trava completa fechada + canal Hotmart aberto): kits abertos, Conteúdo Pronto fechado", async () => {
  const kitSite = (u) => {
    const p = allow.products.find((x) => u.endsWith(x.site_route));
    if (p.kind !== "kit") return [200, null, FX("site-hotmart-paused.html")];
    const href = `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}&src=site`;
    return [200, null, `<a href="${href.replace(/&/g, "&amp;")}">Comprar</a>`];
  };
  const ck = (state) => (u) => { const p = allow.products.find((x) => u.includes(x.checkout_code)); return [200, null, productFixture(p.slug, p.kind === "kit" ? state : "hotmart-closed-049.html")]; };
  const f = liveFake({ site: kitSite, checkout: ck("hotmart-open-ok.html"), hotmart: [200, '{"open":true,"channel":"hotmart","products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'] });
  const r = await runLive({ allow, fetchImpl: f });
  assert.equal(r.hotmart_channel, true, "[P18C.H1] canal Hotmart lido");
  assert.equal(r.verdict, PASS, "[P18C.H1] coerente: " + JSON.stringify(r.results.filter((x) => x.verdict === FAIL)));
  assert.ok(f.calls.every((c) => c.method === "GET"), "[P18C.H1] só GET");
  // Plataforma ainda fechada (ex.: verificação da conta pendente): o site vende e a Hotmart recusa = FAIL real.
  const g = liveFake({ site: kitSite, checkout: ck("hotmart-closed-049.html"), hotmart: [200, '{"open":true,"products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'] });
  const r2 = await runLive({ allow, fetchImpl: g });
  assert.deepEqual([...new Set(r2.results.filter((x) => x.verdict === FAIL).map((x) => x.reason))], ["hotmart_closed_while_enabled"], "[P18C.H2] checkout fechado com o canal aberto");
  // Canal ilegível ou fechado: volta às expectativas da trava fechada (rota com checkout = FAIL).
  for (const hm of [[500, '{"open":true,"products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'], [200, '{"open":"true"}'], [200, "<html>"], [200, '{"open":false}']]) {
    const h = liveFake({ site: kitSite, checkout: ck("hotmart-closed-049.html"), hotmart: hm });
    const r3 = await runLive({ allow, fetchImpl: h });
    assert.equal(r3.hotmart_channel, false, "[P18C.H3] fail-closed " + hm.join(" "));
    assert.ok(r3.results.some((x) => x.reason === "site_route_checkout_while_locked"), "[P18C.H3] rota aberta sem canal = FAIL");
  }
  // Assinatura nunca abre pelo canal Hotmart.
  const cp = allow.products.find((x) => x.kind === "subscription");
  const i = liveFake({ site: (u) => (u.endsWith(cp.site_route) ? [302, `https://pay.hotmart.com/${cp.checkout_code}?off=${cp.offer}`, ""] : kitSite(u)), checkout: ck("hotmart-open-ok.html"), hotmart: [200, '{"open":true,"products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'] });
  const r4 = await runLive({ allow, fetchImpl: i });
  assert.deepEqual(r4.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [[cp.slug, "site_route_checkout_while_locked"]], "[P18C.H4] Conteúdo Pronto segue a trava completa");
  // NC-1004-01: assinatura desativada responde 404 (DEC-04) = PASS; a exceção nunca alcança os kits.
  const j = liveFake({ site: (u) => (u.endsWith(cp.site_route) ? [404, null, "<html>Página indisponível</html>"] : kitSite(u)), checkout: ck("hotmart-open-ok.html"), hotmart: [200, '{"open":true,"products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'] });
  const r5 = await runLive({ allow, fetchImpl: j });
  assert.equal(r5.verdict, PASS, "[P18C.H5] Conteúdo Pronto 404 sem checkout: " + JSON.stringify(r5.results.filter((x) => x.verdict === FAIL)));
  assert.equal(r5.results.find((x) => x.slug === cp.slug && x.source === "live:site_route").reason, "site_route_subscription_retired_404", "[P18C.H5] motivo");
  const k = liveFake({ site: (u) => [404, null, "<html>Página indisponível</html>"], checkout: ck("hotmart-closed-049.html") });
  const r6 = await runLive({ allow, fetchImpl: k });
  assert.deepEqual(r6.results.filter((x) => x.verdict === FAIL).map((x) => x.slug).sort(), allow.products.filter((x) => x.kind === "kit").map((x) => x.slug).sort(), "[P18C.H5] kit com 404 nunca passa");
  assert.ok(r6.results.filter((x) => x.verdict === FAIL).every((x) => x.reason === "site_route_not_paused:http_404"), "[P18C.H5] motivo dos kits");
});

test("relatório: nenhum link conferido nunca é PASS", () => {
  const r = buildReport("live", []);
  assert.equal(r.verdict, FAIL, "[P18C.16] vazio reprova");
  assert.equal(r.reason, "no_links_checked", "[P18C.16] motivo");
  assert.equal(buildReport("live", [{ verdict: PASS }, { verdict: FAIL }]).verdict, FAIL, "[P18C.16] um FAIL derruba");
});

// Desde o #1061 (16/11) o botão "Comprar" da página /hotmart/<slug> é interno (/hotmart/<slug>/ir, que mede o clique e
// responde 302 para a oferta cadastrada). O monitor ficou vermelho desde 15/11 por procurar só link externo na página.
// Agora: com a venda aberta e o botão /ir na página, o salto (seguido com utm_source=diagnostico) precisa ser 302 para
// um checkout da lista fechada; sem salto, salto sem 302 ou destino fora da lista = FAIL.
test("P18C.20: botão interno /hotmart/<slug>/ir — 302 para a oferta da lista passa; sem salto, sem 302 ou destino errado reprova", () => {
  const pagina = { status: 200, headers: {}, body: '<a class="button" href="/hotmart/ia-na-pratica/ir?utm_source=direto">Comprar agora · R$ 97</a>' };
  const ir = (status, location) => ({ status, headers: { location } });
  assert.equal(decideSiteRoute("enabled", pagina, IA, allow, { ir: ir(302, IA_URL + "&src=diagnostico") }).verdict, PASS, "[P18C.20] /ir 302 para a oferta certa");
  assert.equal(decideSiteRoute("enabled", pagina, IA, allow).reason, "site_route_ir_not_followed", "[P18C.20] botão /ir sem seguir o salto");
  assert.equal(decideSiteRoute("enabled", pagina, IA, allow, { ir: ir(200, null) }).reason, "site_route_ir_without_redirect:http_200", "[P18C.20] /ir sem redirecionamento");
  assert.equal(decideSiteRoute("enabled", pagina, IA, allow, { ir: ir(302, "https://pay.hotmart.com/F107979716H?off=errado1") }).reason, "site_route_link_offer_mismatch", "[P18C.20] /ir para oferta errada");
  assert.match(decideSiteRoute("enabled", pagina, IA, allow, { ir: ir(302, "https://pay.hotmart.com/L107979973K?off=ksb5di36&src=diagnostico") }).reason, /wrong_product_for_page/, "[P18C.20] /ir para o produto errado");
  assert.match(decideSiteRoute("enabled", pagina, IA, allow, { ir: ir(302, "https://evil.example/F107979716H?off=g9knd34r") }).reason, /host_not_allowed/, "[P18C.20] /ir para host fora da lista");
  assert.equal(decideSiteRoute("globally-blocked", pagina, IA, allow, { ir: ir(302, IA_URL) }).verdict, FAIL, "[P18C.20] trava fechada com botão de compra continua reprovando");
  // GPT-6 (#1068): página com "vendas pausadas" E o botão /ir, sem salto consultado (como no runLive com a trava fechada)
  const pausadaComBotao = { status: 200, headers: {}, body: '<p>As vendas do IA na Prática estão pausadas no momento.</p><a href="/hotmart/ia-na-pratica/ir?utm_source=direto">Comprar</a>' };
  assert.ok(allow.site_paused_markers.some((m) => /pausad/i.test(m)), "[P18C.20] o marcador de pausa da lista está no texto do caso");
  assert.equal(decideSiteRoute("globally-blocked", pausadaComBotao, IA, allow).reason, "site_route_ir_button_while_locked", "[P18C.20] pausada + botão /ir com a trava fechada reprova");
  assert.equal(decideSiteRoute("globally-blocked", { status: 200, headers: {}, body: '<p>As vendas do IA na Prática estão pausadas no momento.</p>' }, IA, allow).verdict, PASS, "[P18C.20] pausada sem botão continua passando");
});
test("P18C.21: runLive segue o /ir só com utm_source=diagnostico (fora das métricas comerciais) e só pelo host do site", async () => {
  const pedidos = [];
  const html = (slug) => `<a href="/hotmart/${slug}/ir?utm_source=direto">Comprar</a>`;
  const fetchImpl = async (url, init) => {
    pedidos.push(String(url)); const u = new URL(url);
    const H = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
    if (u.pathname === "/api/release") return { status: 200, headers: H({}), text: async () => JSON.stringify({ sales_mode: "globally-blocked" }) };
    if (u.pathname === "/api/sales/hotmart-status") return { status: 200, headers: H({}), text: async () => JSON.stringify({ open: true, products: ["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"] }) };
    const m = u.pathname.match(/^\/hotmart\/([a-z-]+)\/ir$/);
    if (m) { const p = allow.products.find((x) => x.slug === m[1]); return { status: 302, headers: H({ location: `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}&src=${u.searchParams.get("utm_source")}` }), text: async () => "" }; }
    const r = u.pathname.match(/^\/hotmart\/([a-z-]+)$/);
    if (r) return { status: 200, headers: H({}), text: async () => html(r[1]) };
    return { status: 404, headers: H({}), text: async () => "" };
  };
  const rep = await runLive({ allow, fetchImpl, renderCheckout: async () => ({ status: 0, error: "nao_testado_aqui" }) });
  const irs = pedidos.filter((x) => /\/ir(\?|$)/.test(x));
  assert.ok(irs.length >= 1, "[P18C.21] /ir seguido");
  for (const x of irs) { assert.equal(new URL(x).searchParams.get("utm_source"), "diagnostico", "[P18C.21] só origem diagnostico"); assert.equal(new URL(x).hostname, new URL(allow.site_origin).hostname, "[P18C.21] só o host do site"); }
  const rotas = rep.results.filter((r) => r.source === "live:site_route" && /^\/hotmart\//.test(new URL(r.link).pathname));
  assert.ok(rotas.length >= 1 && rotas.every((r) => r.verdict === PASS), "[P18C.21] rotas /hotmart passam com o salto válido: " + JSON.stringify(rotas.map((r) => [r.slug, r.reason])));
});

// ---------------------------------------------------------------- abertura direta autorizada (decisão de 25/11/2026)
// Estado decidido: trava do site fechada, canal Hotmart do site fechado, e SÓ os 5 kits vendendo pelo link direto da
// Hotmart, pelo preço à vista registrado. Tudo fora disso continua FAIL (desvio real).
const direct = loadDirectAuthorization(".", allow);
const KITS = allow.products.filter((p) => p.kind === "kit");
const CP = allow.products.find((p) => p.kind === "subscription");
const priceOf = (slug) => direct.products.find((x) => x.slug === slug).price_cash_brl;
const withPrice = (html, price) => html.replace("</section>", `<p>12 x de R$ 10,03 *</p><p>Ou R$ ${price} à vista</p></section>`);
const openKit = (slug, price = priceOf(slug)) => withPrice(productFixture(slug, "hotmart-open-ok.html"), price);
const closedOf = (slug) => productFixture(slug, "hotmart-closed-049.html");
const slugOfUrl = (u) => allow.products.find((p) => u.includes(p.checkout_code)).slug;
// Estado autorizado: kits abertos com o preço certo, Conteúdo Pronto fechado, rotas do site pausadas.
const authorizedCheckout = (u) => { const s = slugOfUrl(u); return [200, null, s === CP.slug ? closedOf(s) : openKit(s)]; };

test("P18C.D1: decisão de abertura direta válida, um para um com a lista fechada; formas inválidas derrubam", () => {
  assert.deepEqual(direct.products.map((x) => x.slug).sort(), KITS.map((x) => x.slug).sort(), "[P18C.D1] só os 5 kits");
  assert.deepEqual(direct.products.map((x) => x.price_cash_brl), ["97,00", "97,00", "147,00", "157,00", "247,00"], "[P18C.D1] preços decididos");
  const bad = (f) => { const d = structuredClone(direct); f(d); return () => validateDirectAuthorization(d, allow); };
  assert.throws(bad((d) => d.products.push({ slug: CP.slug, hotmart_product_id: CP.hotmart_product_id, checkout_code: CP.checkout_code, offer: CP.offer, price_cash_brl: "197,00" })), /not_a_kit/, "[P18C.D1] assinatura nunca entra");
  assert.throws(bad((d) => { d.products[0].offer = "outra123"; }), /diverges_from_closed_list/, "[P18C.D1] oferta divergente da lista fechada");
  assert.throws(bad((d) => { d.products[0].checkout_code = "Z107979716H"; }), /diverges_from_closed_list/, "[P18C.D1] código divergente da lista fechada");
  assert.throws(bad((d) => { d.products[0].price_cash_brl = "97"; }), /price/, "[P18C.D1] preço sem centavos");
  assert.throws(bad((d) => { d.products[1].slug = d.products[0].slug; }), /entry/, "[P18C.D1] produto repetido");
  assert.throws(bad((d) => { d.products[0].slug = "kit-inventado"; }), /unknown_slug/, "[P18C.D1] produto fora da lista");
  assert.throws(bad((d) => { d.scope = "everything"; }), /scope/, "[P18C.D1] escopo diferente");
  assert.throws(bad((d) => { delete d.decision.record; }), /decision/, "[P18C.D1] decisão sem registro");
  assert.throws(bad((d) => { d.products = []; }), /products/, "[P18C.D1] lista vazia");
});

test("P18C.D2: preço à vista do checkout real ('Ou R$ 97,00 à vista') é lido; parcelas não contam", () => {
  const real = "zevanory ia na prática autor: a. renan alves moreira bitu ltda 12 x de r$ 10,03 * ou r$ 97,00 à vista 1 x de r$ 97,00 total de r$ 120,36";
  assert.deepEqual(cashPrices(real), ["97,00"], "[P18C.D2] preço à vista");
  assert.deepEqual(cashPrices("ou r$ 1.247,00 à vista"), ["1247,00"], "[P18C.D2] milhar");
  assert.deepEqual(cashPrices("12 x de r$ 10,03 total de r$ 120,36"), [], "[P18C.D2] sem à vista não há preço");
  assert.deepEqual(cashPrices("ou r$ 97,00 à vista ... ou r$ 87,00 à vista").length, 2, "[P18C.D2] dois preços distintos");
});

test("P18C.D3: live no estado autorizado (5 kits abertos pelo preço decidido, site pausado, Conteúdo Pronto fechado) passa", async () => {
  const f = liveFake({ checkout: authorizedCheckout });
  const r = await runLive({ allow, direct, fetchImpl: f });
  assert.equal(r.verdict, PASS, "[P18C.D3] estado autorizado: " + JSON.stringify(r.results.filter((x) => x.verdict === FAIL)));
  assert.equal(r.counts.total, 12, "[P18C.D3] 6 rotas + 6 checkouts");
  assert.equal(r.results.filter((x) => x.reason === "open_authorized_direct_hotmart").length, 5, "[P18C.D3] os 5 kits pelo motivo autorizado");
  assert.equal(r.results.find((x) => x.slug === CP.slug && x.source === "live:checkout").reason, "closed_as_expected", "[P18C.D3] Conteúdo Pronto segue fechado");
  assert.equal(r.results.filter((x) => x.source === "live:site_route" && x.verdict === PASS).length, 6, "[P18C.D3] rotas do site pausadas");
  assert.deepEqual(r.direct_authorization.products.sort(), KITS.map((x) => x.slug).sort(), "[P18C.D3] decisão registrada no relatório");
  assert.ok(f.calls.every((c) => c.method === "GET"), "[P18C.D3] só GET");
  // Sem a decisão carregada, o mesmo estado é a reprovação antiga (o monitor não ficou cego).
  const r0 = await runLive({ allow, fetchImpl: liveFake({ checkout: authorizedCheckout }) });
  assert.equal(r0.results.filter((x) => x.reason === "hotmart_open_while_locked").length, 5, "[P18C.D3] sem decisão: abertura com a trava fechada");
});

test("P18C.D4: desvios reais continuam reprovando no estado autorizado", async () => {
  const one = async (slug, body) => {
    const r = await runLive({ allow, direct, fetchImpl: liveFake({ checkout: (u) => (slugOfUrl(u) === slug ? [200, null, body] : authorizedCheckout(u)) }) });
    return r.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]);
  };
  assert.deepEqual(await one("lucro-e-caixa", openKit("lucro-e-caixa", "97,00")), [["lucro-e-caixa", "authorized_direct_price_mismatch:97,00"]], "[P18C.D4] preço diferente do decidido");
  assert.deepEqual(await one("ia-na-pratica", productFixture("ia-na-pratica", "hotmart-open-ok.html")), [["ia-na-pratica", "authorized_direct_price_unverified"]], "[P18C.D4] preço ilegível");
  assert.deepEqual(await one("ia-na-pratica", openKit("ia-na-pratica") + "<p>Ou R$ 9,70 à vista</p>"), [["ia-na-pratica", "authorized_direct_price_ambiguous:97,00|9,70"]], "[P18C.D4] dois preços");
  assert.deepEqual(await one(CP.slug, withPrice(productFixture(CP.slug, "hotmart-open-ok.html"), "197,00")), [[CP.slug, "hotmart_open_while_locked"]], "[P18C.D4] Conteúdo Pronto aberto (fora da decisão)");
  assert.deepEqual(await one("negocio-completo", closedOf("negocio-completo")), [["negocio-completo", "authorized_direct_open_but_closed"]], "[P18C.D4] kit autorizado fechado é desvio do estado decidido");
  const wrongProducer = withPrice(FX("hotmart-open-wrong-producer.html"), "97,00");
  const wp = await one("ia-na-pratica", wrongProducer);
  assert.deepEqual(wp.map((x) => x[0]), ["ia-na-pratica"], "[P18C.D4] produtor divergente");
  assert.match(String(wp[0]?.[1]), /mismatch|forbidden|absent/, "[P18C.D4] motivo de identidade");
  const wd = await one("ia-na-pratica", withPrice(FX("hotmart-open-wrong-product.html"), "97,00"));
  assert.match(String(wd[0]?.[1]), /product_id_mismatch/, "[P18C.D4] produto divergente");
  // Rota do site com link de compra: a decisão NÃO abre a vitrine.
  const h = liveFake({ site: (u) => (u.endsWith("/hotmart/combo-ia-vendas") ? [200, null, FX("site-hotmart-open.html")] : [200, null, FX("site-hotmart-paused.html")]), checkout: authorizedCheckout });
  const r = await runLive({ allow, direct, fetchImpl: h });
  assert.deepEqual(r.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [["combo-ia-vendas", "site_route_checkout_while_locked"]], "[P18C.D4] vitrine continua fechada");
});

test("P18C.D5: a decisão só vale com a trava completa fechada e o canal Hotmart do site fechado", async () => {
  const k = KITS[0];
  assert.equal(directEntry(direct, k, "globally-blocked", false)?.slug, k.slug, "[P18C.D5] trava fechada + canal fechado");
  assert.equal(directEntry(direct, k, "enabled", false), null, "[P18C.D5] trava aberta: regra normal");
  assert.equal(directEntry(direct, k, null, false), null, "[P18C.D5] trava desconhecida: sem exceção");
  assert.equal(directEntry(direct, k, "globally-blocked", true), null, "[P18C.D5] canal do site aberto: regra do canal");
  assert.equal(directEntry(direct, CP, "globally-blocked", false), null, "[P18C.D5] assinatura nunca");
  assert.equal(directEntry(null, k, "globally-blocked", false), null, "[P18C.D5] sem decisão carregada");
  // Trava aberta com um kit fechado: motivo da regra normal, nunca o da exceção.
  const site = (u) => { const p = allow.products.find((x) => u.endsWith(x.site_route)); const href = `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}&src=site`;
    return p.kind === "subscription" ? [302, href, ""] : [200, null, `<a href="${href.replace(/&/g, "&amp;")}">Comprar</a>`]; };
  const en = await runLive({ allow, direct, fetchImpl: liveFake({ release: [200, '{"sales_mode":"enabled"}'], site, checkout: (u) => [200, null, slugOfUrl(u) === k.slug ? closedOf(k.slug) : productFixture(slugOfUrl(u), "hotmart-open-ok.html")] }) });
  assert.deepEqual(en.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [[k.slug, "hotmart_closed_while_enabled"]], "[P18C.D5] trava aberta segue a regra normal");
  // Canal do site aberto para os kits: regra do canal (sem exigir preço).
  const kitSite = (u) => { const p = allow.products.find((x) => u.endsWith(x.site_route)); if (p.kind !== "kit") return [200, null, FX("site-hotmart-paused.html")];
    const href = `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}&src=site`; return [200, null, `<a href="${href.replace(/&/g, "&amp;")}">Comprar</a>`]; };
  const ch = await runLive({ allow, direct, fetchImpl: liveFake({ site: kitSite, hotmart: [200, '{"open":true,"products":["combo-ia-vendas","ia-na-pratica","lucro-e-caixa","negocio-completo","vendas-na-pratica"]}'],
    checkout: (u) => [200, null, slugOfUrl(u) === CP.slug ? closedOf(CP.slug) : productFixture(slugOfUrl(u), "hotmart-open-ok.html")] }) });
  assert.equal(ch.verdict, PASS, "[P18C.D5] canal aberto: " + JSON.stringify(ch.results.filter((x) => x.verdict === FAIL)));
  // Trava ilegível: tudo FAIL, a exceção não salva ninguém.
  const un = await runLive({ allow, direct, fetchImpl: liveFake({ release: "throw", checkout: authorizedCheckout }) });
  assert.equal(un.counts.fail, un.counts.total, "[P18C.D5] trava fora do ar reprova tudo");
});

test("P18C.D6: modo offline confere o preço da decisão contra o catálogo oficial", () => {
  const ok = offlineTree(() => {});
  assert.equal(ok.results.filter((x) => x.reason === "direct_price_matches_catalog").length, 5, "[P18C.D6] 5 preços iguais ao catálogo");
  const div = offlineTree((d) => { const f = join(d, "data/p18-hotmart-direct-authorization.json"); writeFileSync(f, readTextNormalized(f).replace('"147,00"', '"117,00"')); });
  assert.deepEqual(div.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [["lucro-e-caixa", "direct_price_diverges_from_catalog:147,00"]], "[P18C.D6] preço divergente do catálogo");
  assert.equal(decideDirectCheckout({ state: "open" }, "ou r$ 97,00 à vista", { price_cash_brl: "97,00" }).verdict, PASS, "[P18C.D6] decisão unitária");
});

test("P18C.D7: preço lido do HTML inicial do servidor quando a página redesenhada não o mostra; scripts nunca contam", async () => {
  const kits = new Set(KITS.map((k) => k.slug));
  const render = (ssrFor) => async (u) => { const s = slugOfUrl(u); return kits.has(s) ? { status: 200, body: productFixture(s, "hotmart-open-ok.html"), ssr: ssrFor(s) } : { status: 200, body: closedOf(s) }; };
  const ok = await runLive({ allow, direct, fetchImpl: liveFake(), renderCheckout: render((s) => `<div>Ou R$ ${priceOf(s)} à vista</div>`) });
  assert.equal(ok.verdict, PASS, "[P18C.D7] preço do HTML do servidor: " + JSON.stringify(ok.results.filter((x) => x.verdict === FAIL)));
  const inScript = await runLive({ allow, direct, fetchImpl: liveFake(), renderCheckout: render((s) => `<script>var t="Ou R$ ${priceOf(s)} à vista"</script>`) });
  assert.equal(inScript.results.filter((x) => x.reason === "authorized_direct_price_unverified").length, 5, "[P18C.D7] preço só dentro de script não conta");
  const wrong = await runLive({ allow, direct, fetchImpl: liveFake(), renderCheckout: render((s) => `<div>Ou R$ ${s === "ia-na-pratica" ? "87,00" : priceOf(s)} à vista</div>`) });
  assert.deepEqual(wrong.results.filter((x) => x.verdict === FAIL).map((x) => [x.slug, x.reason]), [["ia-na-pratica", "authorized_direct_price_mismatch:87,00"]], "[P18C.D7] preço errado no HTML do servidor reprova");
});
