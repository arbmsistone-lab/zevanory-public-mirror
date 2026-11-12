// ZEVANORY | P18, verificação COMERCIAL dos links de venda (Roteiro v4.9, seção 5/P18, R15; VC-H controles 7 e 10).
// "HTTP 200 sozinho não basta": cada link de compra precisa apontar para o produto certo (lista fechada
// data/p18-commercial-allowlist.json), sob a identidade comercial esperada (A. RENAN ALVES MOREIRA BITU LTDA,
// CNPJ 69.077.233/0001-99, marca ZEVANORY), e alcançar um checkout legítimo, SEM criar transação.
//
// Garantias de segurança (testadas e com mutantes):
//  - somente GET; sem corpo; sem cookie, sem Authorization; credentials "omit"; redirect "manual" (cada salto é
//    conferido contra redirect_hosts antes de ser seguido; no máximo MAX_REDIRECTS);
//  - nunca /comprar nem pagamento próprio; nunca clique, formulário ou POST; o renderizador opcional por navegador
//    (p18-commercial-browser.mjs) aborta toda requisição que não seja GET;
//  - nenhum segredo, nenhum dado pessoal.
//
// Coerência com a trava global (sales_mode em /api/release):
//  - globally-blocked: o checkout Hotmart PRECISA estar fechado ("vendas temporariamente encerradas", erro 049) e as
//    rotas do site (/hotmart/<slug>, /assinar/<slug>) precisam responder "pausadas" sem link de checkout;
//    checkout aberto com a trava fechada = FAIL (o interruptor não é global);
//  - enabled: o checkout precisa estar aberto e mostrar o produto e o produtor esperados; fechado = FAIL;
//  - trava ilegível ou fora do ar = FAIL de todos os links (fail-closed).
// Página que só responde 200, sem produto, sem produtor e sem o aviso de vendas fechadas = FAIL
// (http_200_without_commercial_evidence).
//
// Modos: --mode offline (PR; sem rede: lista fechada x data/products.json x worker x páginas de sales-public/) e
// --mode live (agendado; GET na trava, nas rotas do site e em cada checkout). Saída: relatório JSON com PASS/FAIL e
// motivo por link; exit 1 se houver FAIL ou nenhum link conferido.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_REPORT = "zevanory.p18.commercial.v1";
export const SCHEMA_ALLOW = "zevanory.p18.commercial-allowlist.v1";
export const PASS = "PASS", FAIL = "FAIL";
export const MAX_REDIRECTS = 3;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 2_000_000;
export const USER_AGENT = "ZevanoryP18CommercialMonitor/1.0 (+https://zevanory.api.br; somente-leitura; bot)";
const ALLOWED_HEADER_NAMES = new Set(["accept", "accept-language", "user-agent"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;
const digits = (s) => String(s).replace(/\D+/g, "");

// ---------------------------------------------------------------- lista fechada
export function validateAllowlist(a) {
  const fail = (m) => { throw new Error("P18C_ALLOWLIST_INVALID " + m); };
  if (!isObj(a) || a.schema !== SCHEMA_ALLOW) fail("schema");
  for (const k of ["checkout_hosts", "redirect_hosts", "informational_hosts", "payment_host_suffixes", "allowed_extra_params", "closed_markers", "closed_error_codes", "site_paused_markers"])
    if (!Array.isArray(a[k]) || !a[k].every(isStr)) fail(k);
  if (a.checkout_hosts.length === 0) fail("checkout_hosts_empty");
  // #1014 NC-D: isenção por CAMINHO (opcional), host exato + prefixo; nunca host inteiro nem subdomínio
  if (a.informational_paths !== undefined && (!Array.isArray(a.informational_paths) || !a.informational_paths.every((x) => isObj(x)
    && /^[a-z0-9.-]+$/.test(x.host || "") && /^\/[A-Za-z0-9/_-]+\/$/.test(x.path_prefix || "")))) fail("informational_paths");
  if (!isObj(a.producer) || !isStr(a.producer.legal_name) || !/^\d{14}$/.test(a.producer.cnpj || "") || !isStr(a.producer.brand)) fail("producer");
  if (!Array.isArray(a.products) || a.products.length === 0) fail("products");
  const seen = { slug: new Set(), checkout_code: new Set(), hotmart_product_id: new Set(), offer: new Set() };
  for (const p of a.products) {
    if (!isObj(p) || !/^[a-z-]{3,40}$/.test(p.slug || "") || !/^[A-Z0-9]{6,20}$/.test(p.checkout_code || "") || !/^[a-z0-9]{4,20}$/.test(p.offer || "")
      || !/^\d{5,10}$/.test(p.hotmart_product_id || "") || !isStr(p.name) || !isStr(p.hotmart_name) || !/^\/(hotmart|assinar)\/[a-z-]{3,40}$/.test(p.site_route || ""))
      fail("product " + JSON.stringify(p?.slug));
    for (const k of Object.keys(seen)) { if (seen[k].has(p[k])) fail("duplicate " + k + " " + p[k]); seen[k].add(p[k]); }
  }
  return a;
}
export const loadAllowlist = (root = ".") => validateAllowlist(JSON.parse(readFileSync(join(root, "data/p18-commercial-allowlist.json"), "utf8")));

// ---------------------------------------------------------------- texto
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return Object.hasOwn(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}
// Texto pesquisável: HTML sem tags (conteúdo de <script> mantido, porque checkouts SPA guardam o estado em JSON),
// entidades e escapes \uXXXX decodificados, espaços colapsados, minúsculas, NFC.
export function searchableText(html) {
  const unesc = String(html).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return decodeEntities(unesc.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().toLowerCase().normalize("NFC");
}
const norm = (s) => String(s).toLowerCase().normalize("NFC");

// ---------------------------------------------------------------- extração de links das páginas
const hostOf = (href) => { try { return new URL(href).hostname.toLowerCase(); } catch { return null; } };
const hostMatches = (host, suffixes) => suffixes.some((s) => host === s || host.endsWith("." + s));
// #1014 NC-D: link informativo por caminho (ex.: recrutamento de afiliados da Hotmart). Estrito: https, host idêntico
// (sem subdomínio), sem porta/credencial/query/fragmento e exatamente UM segmento alfanumérico após o prefixo.
export function isInformationalPath(href, allow) {
  let u; try { u = new URL(href); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password || u.search || u.hash) return false;
  const host = u.hostname.toLowerCase();
  return (allow.informational_paths || []).some((x) => host === x.host && u.pathname.startsWith(x.path_prefix)
    && /^[A-Za-z0-9]+$/.test(u.pathname.slice(x.path_prefix.length)));
}
export function extractPurchaseLinks(html, allow, { source = "?", slug = null } = {}) {
  const out = [], seen = new Set();
  const add = (href, kind) => { const k = kind + " " + href; if (!seen.has(k)) { seen.add(k); out.push({ href, kind, source, page_slug: slug }); } };
  const hrefs = [...String(html).matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => decodeEntities(m[1] ?? m[2] ?? "").trim());
  const bare = [...String(html).matchAll(/https?:\/\/[A-Za-z0-9.-]+\/[^\s"'<>)\\]*/g)].map((m) => decodeEntities(m[0]));
  for (const h of [...hrefs, ...bare]) {
    if (/^\/(comprar|assinar|hotmart)\//i.test(h)) { add(h, "internal_buy"); continue; }
    const host = hostOf(h);
    if (!host || hostMatches(host, allow.informational_hosts) || isInformationalPath(h, allow)) continue;
    if (hostMatches(host, allow.payment_host_suffixes) || allow.checkout_hosts.includes(host)) add(h, "external_checkout");
  }
  return out;
}

// ---------------------------------------------------------------- forma do link (lista fechada)
export function checkLinkShape(href, allow, { pageSlug = null } = {}) {
  let u;
  try { u = new URL(href); } catch { return { ok: false, reason: "url_invalid" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (u.username || u.password) return { ok: false, reason: "userinfo_present" };
  if (u.port) return { ok: false, reason: "port_present" };
  if (u.hash) return { ok: false, reason: "fragment_present" };
  if (!allow.checkout_hosts.includes(u.hostname.toLowerCase())) return { ok: false, reason: "host_not_allowed:" + u.hostname.slice(0, 60) };
  const code = (u.pathname.match(/^\/([A-Za-z0-9]+)\/?$/) || [])[1];
  const product = allow.products.find((p) => p.checkout_code === code);
  if (!product) return { ok: false, reason: "checkout_code_not_in_closed_list:" + String(code || u.pathname).slice(0, 40) };
  const keys = [...u.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "duplicate_query_param", product };
  if (u.searchParams.get("off") !== product.offer) return { ok: false, reason: "offer_mismatch", product };
  for (const k of keys) if (k !== "off" && !allow.allowed_extra_params.includes(k)) return { ok: false, reason: "unexpected_param:" + k.slice(0, 30), product };
  if (u.searchParams.has("src") && !new RegExp(allow.src_pattern).test(u.searchParams.get("src"))) return { ok: false, reason: "src_invalid", product };
  if (pageSlug && pageSlug !== product.slug && !(pageSlug === "solucoes")) return { ok: false, reason: "wrong_product_for_page:" + pageSlug + "->" + product.slug, product };
  return { ok: true, reason: "shape_ok", product };
}

// ---------------------------------------------------------------- trava global
export function readSalesMode(status, bodyText) {
  if (status !== 200) return { mode: null, reason: "release_http_" + status };
  let j;
  try { j = JSON.parse(bodyText); } catch { return { mode: null, reason: "release_not_json" }; }
  const m = isObj(j) ? j.sales_mode : undefined;
  if (m === "globally-blocked" || m === "enabled") return { mode: m, reason: "release_ok" };
  return { mode: null, reason: "release_sales_mode_unknown:" + String(m).slice(0, 30) };
}

// Modo Hotmart (roteiro v5.0, Nível 1, PR #1003): com a trava completa fechada, o canal próprio
// /api/sales/hotmart-status pode abrir SÓ a compra pela Hotmart dos kits. Falha fechada: qualquer resposta que
// não seja HTTP 200 com {"open": true} conta como canal fechado (as expectativas da trava fechada continuam).
export function readHotmartChannel(status, bodyText) {
  if (status !== 200) return { open: false, reason: "hotmart_channel_http_" + status };
  let j;
  try { j = JSON.parse(bodyText); } catch { return { open: false, reason: "hotmart_channel_not_json" }; }
  return isObj(j) && j.open === true ? { open: true, reason: "hotmart_channel_open" } : { open: false, reason: "hotmart_channel_closed" };
}
// Expectativa efetiva por produto: no modo Hotmart só os kits são julgados como abertos; assinatura e serviço
// (Conteúdo Pronto) seguem a trava completa.
export function effectiveSalesMode(mode, hotmartOpen, product) {
  if (mode === "globally-blocked" && hotmartOpen === true && product && product.kind === "kit") return "enabled";
  return mode;
}

// ---------------------------------------------------------------- classificação do checkout
// Retorna { state: "closed" | "open" | "unverifiable" | "mismatch", reason, identity }.
export function classifyCheckout({ status, body }, product, allow) {
  const raw = String(body || ""), text = searchableText(raw);
  const prod = allow.producer;
  const identity = { product_id_expected_seen: false, product_ids_seen: [], product_name_seen: false, producer_legal_name_seen: false,
    producer_cnpjs_seen: [], brand_seen: false, closed_marker: null };
  if (!Number.isInteger(status) || status >= 500 || status === 0) return { state: "unverifiable", reason: "checkout_http_" + status, identity };
  // IDs de produto expostos (JSON de estado ou atributos).
  for (const m of raw.matchAll(/["']?(?:productId|product_id|idProduct|productID)["']?\s*[:=]\s*["']?(\d{5,10})/g)) identity.product_ids_seen.push(m[1]);
  for (const m of raw.matchAll(/data-product-id\s*=\s*["'](\d{5,10})["']/gi)) identity.product_ids_seen.push(m[1]);
  identity.product_ids_seen = [...new Set(identity.product_ids_seen)];
  identity.product_id_expected_seen = identity.product_ids_seen.includes(product.hotmart_product_id);
  identity.product_name_seen = text.includes(norm(product.name));
  identity.producer_legal_name_seen = text.includes(norm(prod.legal_name));
  identity.brand_seen = text.includes(norm(prod.brand));
  // CNPJ só quando formatado (00.000.000/0000-00) ou logo depois da palavra "cnpj": um número qualquer de 14
  // dígitos (id, carimbo de tempo) nunca vira CNPJ divergente.
  for (const m of text.matchAll(/\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b|cnpj\W{0,20}(\d{14})\b/g)) identity.producer_cnpjs_seen.push(digits(m[1] || m[2]));
  identity.producer_cnpjs_seen = [...new Set(identity.producer_cnpjs_seen)];
  // Divergência domina tudo (inclusive o aviso de vendas fechadas): produto ou produtor errado nunca passa.
  const otherIds = identity.product_ids_seen.filter((id) => id !== product.hotmart_product_id);
  if (otherIds.length) return { state: "mismatch", reason: "product_id_mismatch:" + otherIds[0], identity };
  const otherCnpj = identity.producer_cnpjs_seen.filter((c) => c !== prod.cnpj);
  if (otherCnpj.length) return { state: "mismatch", reason: "producer_cnpj_mismatch", identity };
  for (const bad of prod.forbidden_names || []) if (text.includes(norm(bad))) return { state: "mismatch", reason: "producer_name_forbidden", identity };
  const marker = allow.closed_markers.find((mk) => text.includes(norm(mk)));
  const code = allow.closed_error_codes.find((c) => new RegExp("(?:erro|error|c[oó]digo|code)\\W{0,12}" + c + "\\b", "i").test(text));
  if (marker || code) { identity.closed_marker = marker || "error_" + code; return { state: "closed", reason: "sales_closed_marker", identity }; }
  if (status !== 200) return { state: "unverifiable", reason: "checkout_http_" + status, identity };
  const productOk = identity.product_id_expected_seen || identity.product_name_seen;
  const producerOk = identity.producer_legal_name_seen || identity.producer_cnpjs_seen.includes(prod.cnpj) || identity.brand_seen;
  if (productOk && producerOk) return { state: "open", reason: "open_identity_verified", identity };
  if (!productOk && !producerOk) return { state: "unverifiable", reason: "http_200_without_commercial_evidence", identity };
  return { state: "unverifiable", reason: productOk ? "producer_identity_absent" : "product_identity_absent", identity };
}

// ---------------------------------------------------------------- decisão (coerência com a trava)
export function decideCheckout(mode, cls) {
  if (mode !== "globally-blocked" && mode !== "enabled") return { verdict: FAIL, reason: "release_unknown" };
  if (cls.state === "mismatch" || cls.state === "unverifiable") return { verdict: FAIL, reason: cls.reason };
  if (mode === "globally-blocked") return cls.state === "closed" ? { verdict: PASS, reason: "closed_as_expected" } : { verdict: FAIL, reason: "hotmart_open_while_locked" };
  return cls.state === "open" ? { verdict: PASS, reason: "open_identity_verified" } : { verdict: FAIL, reason: "hotmart_closed_while_enabled" };
}

// Rota do site (/hotmart/<slug>, /assinar/<slug>): fechada = "pausadas" sem checkout; aberta = checkout da lista.
export function decideSiteRoute(mode, { status, headers = {}, body }, product, allow) {
  if (mode !== "globally-blocked" && mode !== "enabled") return { verdict: FAIL, reason: "release_unknown" };
  const loc = headers.location || null;
  const links = extractPurchaseLinks(body || "", allow, { source: "live", slug: product.slug }).filter((l) => l.kind === "external_checkout").map((l) => l.href);
  if (loc && /^https?:/i.test(loc)) links.push(loc);
  const text = searchableText(body || "");
  if (mode === "globally-blocked") {
    if (links.length) return { verdict: FAIL, reason: "site_route_checkout_while_locked" };
    if (status === 200 && allow.site_paused_markers.some((m) => text.includes(norm(m)))) return { verdict: PASS, reason: "site_route_paused_as_expected" };
    // NC-1004-01 (DEC-04): a assinatura desativada responde 404 sem redirecionamento e sem checkout. Só vale para
    // produto de kind "subscription"; os kits continuam exigindo a página "vendas pausadas".
    if (status === 404 && product.kind === "subscription" && !loc) return { verdict: PASS, reason: "site_route_subscription_retired_404" };
    return { verdict: FAIL, reason: "site_route_not_paused:http_" + status };
  }
  if (!links.length) return { verdict: FAIL, reason: "site_route_without_checkout:http_" + status };
  for (const l of links) {
    const s = checkLinkShape(l, allow, { pageSlug: product.slug });
    if (!s.ok) return { verdict: FAIL, reason: "site_route_link_" + s.reason };
  }
  return { verdict: PASS, reason: "site_route_checkout_in_closed_list" };
}

// ---------------------------------------------------------------- GET seguro
export function safeInit(signal) {
  return { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
    headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.5", "accept-language": "pt-BR,pt;q=0.9", "user-agent": USER_AGENT }, ...(signal ? { signal } : {}) };
}
export function assertSafeInit(init) {
  if (!isObj(init) || init.method !== "GET") throw new Error("P18C_UNSAFE_REQUEST method");
  if (init.body !== undefined && init.body !== null) throw new Error("P18C_UNSAFE_REQUEST body");
  if (init.redirect !== "manual") throw new Error("P18C_UNSAFE_REQUEST redirect");
  if (init.credentials !== "omit") throw new Error("P18C_UNSAFE_REQUEST credentials");
  for (const k of Object.keys(init.headers || {})) if (!ALLOWED_HEADER_NAMES.has(k.toLowerCase())) throw new Error("P18C_UNSAFE_REQUEST header " + k);
  return init;
}
const headerGet = (h, k) => (h && typeof h.get === "function" ? h.get(k) : h?.[k]) ?? null;
// Segue no máximo MAX_REDIRECTS saltos, cada um só para um host da lista (allowHosts). Nunca lança.
export async function safeGet(url, { fetchImpl = fetch, allowHosts, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const hops = [];
  let cur = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const host = hostOf(cur);
    if (!host || !allowHosts.includes(host)) return { status: 0, error: "redirect_host_not_allowed:" + String(host).slice(0, 60), hops, final_url: cur };
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let r;
    try { r = await fetchImpl(cur, assertSafeInit(safeInit(ctl?.signal))); }
    catch (e) { if (t) clearTimeout(t); return { status: 0, error: "network:" + String(e?.message || e).slice(0, 80), hops, final_url: cur }; }
    if (t) clearTimeout(t);
    const status = r.status;
    hops.push({ url: cur, status });
    const loc = headerGet(r.headers, "location");
    if (status >= 300 && status < 400 && loc) {
      if (i === MAX_REDIRECTS) return { status, error: "too_many_redirects", hops, final_url: cur };
      cur = new URL(loc, cur).toString();
      continue;
    }
    let body = "";
    try { body = (await r.text()).slice(0, MAX_BODY_BYTES); } catch { body = ""; }
    return { status, headers: { location: loc }, body, hops, final_url: cur };
  }
  return { status: 0, error: "too_many_redirects", hops, final_url: cur };
}

// Igual ao safeGet, mas sem seguir redirecionamento (rotas do site: o 302 é a própria resposta a conferir).
export async function safeGetNoFollow(url, { fetchImpl = fetch, allowHosts, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const host = hostOf(url);
  if (!host || !allowHosts.includes(host)) return { status: 0, error: "host_not_allowed", headers: {}, body: "" };
  try {
    const r = await fetchImpl(url, assertSafeInit(safeInit()));
    let body = "";
    try { body = (await r.text()).slice(0, MAX_BODY_BYTES); } catch { body = ""; }
    return { status: r.status, headers: { location: headerGet(r.headers, "location") }, body };
  } catch (e) { return { status: 0, error: "network:" + String(e?.message || e).slice(0, 80), headers: {}, body: "" }; }
}

// ---------------------------------------------------------------- relatório
export function buildReport(mode, results, extra = {}) {
  const pass = results.filter((r) => r.verdict === PASS).length, fail = results.length - pass;
  const verdict = results.length > 0 && fail === 0 ? PASS : FAIL;
  return { schema: SCHEMA_REPORT, mode, verdict, reason: results.length === 0 ? "no_links_checked" : fail ? "links_failed" : "all_links_pass",
    counts: { total: results.length, pass, fail }, results, ...extra };
}

// ---------------------------------------------------------------- modo offline (PR, sem rede)
// Links registrados no código do Worker de vendas (HOTMART_CHECKOUT/SERVICE_CHECKOUT): par slug -> URL.
export function workerCheckoutLinks(src) {
  const out = [];
  const block = (String(src).match(/export const HOTMART_CHECKOUT\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/) || [])[1] || "";
  for (const m of block.matchAll(/"([a-z-]+)"\s*:\s*"([^"]*)"/g)) out.push({ slug: m[1], href: m[2] });
  const svc = (String(src).match(/export const SERVICE_CHECKOUT\s*=\s*"([^"]*)"/) || [])[1];
  if (svc !== undefined) out.push({ slug: "conteudo-pronto", href: svc });
  const all = [...String(src).matchAll(/https:\/\/pay\.hotmart\.com\/[^"'`\s]*/g)].map((m) => m[0]);
  return { pairs: out, all };
}

export function runOffline(root = ".") {
  const allow = loadAllowlist(root);
  const results = [];
  const products = JSON.parse(readFileSync(join(root, "data/products.json"), "utf8"));
  const catalog = [...products.products.map((p) => ({ slug: p.slug, sku: p.sku, name: p.name })), { slug: products.subscription.slug, sku: null, name: products.subscription.name }];
  // 1. cobertura: catálogo oficial <-> lista fechada (um para um, nome e SKU iguais).
  for (const c of catalog) {
    const p = allow.products.find((x) => x.slug === c.slug);
    const ok = !!p && p.name === c.name && (p.sku ?? null) === c.sku;
    results.push({ link: null, source: "data/products.json", slug: c.slug, verdict: ok ? PASS : FAIL, reason: ok ? "catalog_in_closed_list" : p ? "catalog_name_or_sku_diverges" : "catalog_product_missing_in_closed_list" });
  }
  for (const p of allow.products) if (!catalog.some((c) => c.slug === p.slug))
    results.push({ link: null, source: "data/p18-commercial-allowlist.json", slug: p.slug, verdict: FAIL, reason: "closed_list_product_not_in_catalog" });
  // 2. links do Worker: cada um na lista fechada, no slug certo; nenhuma URL de checkout solta fora dos pares.
  const w = workerCheckoutLinks(readFileSync(join(root, "worker/sales-public-worker.mjs"), "utf8"));
  for (const { slug, href } of w.pairs) {
    const s = checkLinkShape(href, allow, { pageSlug: slug });
    results.push({ link: href, source: "worker/sales-public-worker.mjs", slug, verdict: s.ok ? PASS : FAIL, reason: s.reason });
  }
  for (const p of allow.products) if (!w.pairs.some((x) => x.slug === p.slug && x.href === `https://pay.hotmart.com/${p.checkout_code}?off=${p.offer}`))
    results.push({ link: null, source: "worker/sales-public-worker.mjs", slug: p.slug, verdict: FAIL, reason: "closed_list_link_absent_from_worker" });
  for (const href of w.all) if (!w.pairs.some((x) => x.href === href))
    results.push({ link: href, source: "worker/sales-public-worker.mjs", slug: null, verdict: FAIL, reason: "checkout_url_outside_registered_pairs" });
  // 3. páginas públicas estáticas: P13 as constrói SEMPRE fechadas; qualquer link de compra nelas é FAIL
  //    (e um link externo fora da lista ganha o motivo específico).
  const dir = join(root, "sales-public");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".html")).sort()) {
    const slug = f.replace(/\.html$/, "");
    for (const l of extractPurchaseLinks(readFileSync(join(dir, f), "utf8"), allow, { source: "sales-public/" + f, slug })) {
      const s = l.kind === "external_checkout" ? checkLinkShape(l.href, allow, { pageSlug: slug }) : { ok: false, reason: "internal_buy_link" };
      results.push({ link: l.href, source: l.source, slug, verdict: FAIL, reason: "static_page_buy_link:" + (s.ok ? "in_closed_list" : s.reason) });
    }
  }
  return buildReport("offline", results, { pages_scanned: readdirSync(dir).filter((x) => x.endsWith(".html")).length });
}

// ---------------------------------------------------------------- modo live (agendado, somente GET)
export async function runLive({ allow, fetchImpl = fetch, renderCheckout = null, now = () => Date.now() } = {}) {
  const started = new Date(now()).toISOString();
  const siteHost = hostOf(allow.site_origin), relHost = hostOf(allow.release_url);
  const rel = await safeGetNoFollow(allow.release_url, { fetchImpl, allowHosts: [relHost] });
  const sm = readSalesMode(rel.status, rel.body);
  // Canal Hotmart só é consultado com a trava completa fechada (mesmo host da trava; somente GET).
  let hc = { open: false, reason: "hotmart_channel_not_consulted" };
  if (sm.mode === "globally-blocked") {
    const h = await safeGetNoFollow(new URL("/api/sales/hotmart-status", allow.release_url).href, { fetchImpl, allowHosts: [relHost] });
    hc = readHotmartChannel(h.status, h.body);
  }
  const results = [];
  for (const p of allow.products) {
    const em = effectiveSalesMode(sm.mode, hc.open, p);
    const routeUrl = allow.site_origin + p.site_route;
    const route = await safeGetNoFollow(routeUrl, { fetchImpl, allowHosts: [siteHost] });
    const rd = decideSiteRoute(em, route, p, allow);
    results.push({ link: routeUrl, source: "live:site_route", slug: p.slug, verdict: rd.verdict, reason: sm.mode ? rd.reason : sm.reason, http_status: route.status });
    const href = `https://${allow.checkout_hosts[0]}/${p.checkout_code}?off=${p.offer}`;
    const shape = checkLinkShape(href, allow, { pageSlug: p.slug });
    if (!shape.ok) { results.push({ link: href, source: "live:checkout", slug: p.slug, verdict: FAIL, reason: shape.reason }); continue; }
    const got = renderCheckout ? await renderCheckout(href) : await safeGet(href, { fetchImpl, allowHosts: allow.redirect_hosts });
    const cls = got.error && !got.body ? { state: "unverifiable", reason: got.error, identity: null } : classifyCheckout(got, p, allow);
    const d = decideCheckout(em, cls);
    results.push({ link: href, source: "live:checkout", slug: p.slug, verdict: d.verdict, reason: sm.mode ? d.reason : sm.reason,
      http_status: got.status, hops: got.hops || [], state: cls.state, identity: cls.identity, ...(got.blocked_non_get !== undefined ? { blocked_non_get: got.blocked_non_get } : {}) });
  }
  return buildReport("live", results, { started_at: started, finished_at: new Date(now()).toISOString(), sales_mode: sm.mode, sales_mode_reason: sm.reason, hotmart_channel: hc.open, hotmart_channel_reason: hc.reason });
}

// ---------------------------------------------------------------- CLI
async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const mode = arg("--mode", "offline"), out = arg("--out", null), root = arg("--root", ".");
  let report;
  if (mode === "offline") report = runOffline(root);
  else if (mode === "live") {
    const allow = loadAllowlist(root);
    let renderCheckout = null;
    if (argv.includes("--browser")) renderCheckout = (await import("./p18-commercial-browser.mjs")).makeBrowserRenderer(allow);
    try { report = await runLive({ allow, renderCheckout }); } finally { await renderCheckout?.close?.(); }
  } else throw new Error("modo desconhecido: " + mode);
  const json = JSON.stringify(report, null, 2) + "\n";
  if (out) writeFileSync(out, json);
  for (const r of report.results) console.log(`${r.verdict} ${r.source} ${r.slug ?? "-"} ${r.reason}${r.link ? " " + r.link : ""}`);
  console.log(`P18_COMMERCIAL mode=${report.mode} verdict=${report.verdict} total=${report.counts.total} pass=${report.counts.pass} fail=${report.counts.fail}${report.sales_mode !== undefined ? " sales_mode=" + report.sales_mode : ""}${report.hotmart_channel !== undefined ? " hotmart_channel=" + report.hotmart_channel : ""}`);
  return report.verdict === PASS ? 0 : 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(String(e?.stack || e)); process.exitCode = 2; });
