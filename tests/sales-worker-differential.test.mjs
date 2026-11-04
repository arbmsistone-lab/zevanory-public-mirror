// Sol 232 (#914): functional audit of the sales Worker changes, isolated from the design.
// The gh-pages Worker is rebuilt by reverse-applying #914's two hunks to the current file and proven
// byte-identical to the gh-pages blob (git blob id pinned below). Both Workers then answer the SAME
// request matrix (every public route, unknown paths, /api/*, /comprar/*, /assinar, /hotmart, assets,
// robots/sitemap, the tombstone, /health; GET and HEAD; sales closed AND open) and the test asserts
// the only differences are the intended ones:
//   1. unknown PAGE paths: designed /404.html, status 404, noindex, no-store (was a plain 404);
//   2. the Hotmart variant (only served while sales are open) rewrites the new list items.
// NC-017 (tests/helpers/sales-worker-nc017-hunks.mjs, reverse-applied first and pinned to the 81d637e blob) adds:
//   3. DEC-04: /conteudo-pronto and /assinar/conteudo-pronto are 404 noindex no-store, no redirect, same security headers;
//   4. DEC-05: /comprar/<SKU> never opens an own checkout (closed: notice page; open: 302 only to /hotmart/<slug>);
//   5. DEC-02: open product pages differ only in the JSON-LD Offer price.
// Everything else (status, every header incl. CSP/security headers, body bytes) is identical.
// Documented in docs/evidence/sales-ux/worker-changes.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { NC017_SALES_WORKER_HUNKS, NC017_BASE_BLOB } from "./helpers/sales-worker-nc017-hunks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
// git rev-parse origin/gh-pages:worker/sales-public-worker.mjs at the base of #914 (gh-pages 5bb6b552) was
// 9e7e708aac4e7ea28de07a410bfcd44e9df71a68. #893 (funnel v2) changes this Worker on a branch that also starts at
// 5bb6b552, so once it is merged the pre-#914 Worker is the #893 one: reverse-applying #914's two hunks must give
// exactly git rev-parse 4dce12c3:worker/sales-public-worker.mjs (#893 head before merging #914), pinned below.
const GH_PAGES_BLOB = "86c5337c33588b50012266698c9dd0d18300e237";
const NEW_SRC = readTextNormalized(join(ROOT, "worker/sales-public-worker.mjs"));

const HUNK_HOTMART_NEW = `  // Design PR: the hero payment facts are a list (no "·" chain); each item has its Hotmart wording.
  ["Pagamento processado pelo Mercado Pago (Pix ou cartão)","Pagamento processado pela Hotmart (Pix, cartão ou boleto)"],
  [\`Entrega por e-mail em \${DELIVERY_72H}\`,"Acesso por e-mail após a confirmação do pagamento"],
  ["<strong>Pagamento</strong><span>processado pelo Mercado Pago","<strong>Pagamento</strong><span>processado pela Hotmart"],
`;
const HUNK_HOTMART_OLD = `  [\`Pagamento pelo Mercado Pago (Pix ou cartão) · entrega por e-mail em \${DELIVERY_72H} · arrependimento em 7 dias corridos.\`,"Pagamento pela Hotmart (Pix, cartão ou boleto) · acesso por e-mail após a confirmação · arrependimento em 7 dias corridos."],
`;
const HUNK_404 = `  // Designed 404 for unknown PAGE paths (no file extension); asset 404s stay plain. Never cached.
  if(response.status===404&&!page&&(request.method==="GET"||request.method==="HEAD")&&!/\\.[a-z0-9]{1,8}$/i.test(url.pathname)){
    const nf=await env.ASSETS.fetch(new Request(new URL("/404.html",request.url),{method:"GET"}));
    if(nf.status===200) return new Response(request.method==="HEAD"?null:nf.body,{status:404,headers:applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}))});
  }
`;
const gitBlob = (s) => { const b = Buffer.from(s, "utf8"); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };

async function loadWorkers() {
  // NC-017 first: reverse its exact hunks to get the Worker at 81d637e (pinned), then #914's two hunks.
  let baseSrc = NEW_SRC;
  for (const [cur, prev] of NC017_SALES_WORKER_HUNKS) {
    assert.equal(baseSrc.split(cur).length, 2, "NC-017 hunk present exactly once: " + cur.slice(0, 60));
    baseSrc = baseSrc.replace(cur, () => prev);
  }
  assert.equal(gitBlob(baseSrc), NC017_BASE_BLOB, "NC-017 reverse-applied file is byte-identical to the Worker at 81d637e (no other change)");
  assert.equal(baseSrc.split(HUNK_HOTMART_NEW).length, 2, "Hotmart hunk present exactly once");
  assert.equal(baseSrc.split(HUNK_404).length, 2, "404 hunk present exactly once");
  const oldSrc = baseSrc.replace(HUNK_HOTMART_NEW, HUNK_HOTMART_OLD).replace(HUNK_404, "");
  assert.equal(gitBlob(oldSrc), GH_PAGES_BLOB, "reverse-applied file is byte-identical to the gh-pages Worker (no other change)");
  const tmp = join(ROOT, "worker", `.gh-pages-sales-worker-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, oldSrc);
  try {
    const OLD = (await import(pathToFileURL(tmp).href)).default;
    const NEW = (await import(pathToFileURL(join(ROOT, "worker/sales-public-worker.mjs")).href)).default;
    return { OLD, NEW };
  } finally { rmSync(tmp, { force: true }); }
}

const TYPES = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", webp: "image/webp", avif: "image/avif", woff2: "font/woff2", txt: "text/plain", xml: "application/xml" };
const ASSETS = { fetch: async (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname).slice(1), f = join(PUB, p);
  if (!p || !existsSync(f) || statSync(f).isDirectory()) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(f), { status: 200, headers: { "content-type": TYPES[p.split(".").pop()] || "application/octet-stream" } });
} };
const envFor = (open) => ({ ASSETS, CORE: { fetch: async (u) => String(u?.url || u).endsWith("/api/sales/status") ? new Response(JSON.stringify({ open }), { status: 200 }) : new Response("{}", { status: 200 }) } });
const ctx = { waitUntil() {} };

function matrix() {
  const pages = readdirSync(PUB).filter((f) => f.endsWith(".html") && f !== "index.html" && f !== "404.html").map((f) => "/" + f.slice(0, -5));
  const css = readdirSync(join(PUB, "assets")).find((f) => /^product\.[0-9a-f]{10}\.css$/.test(f));
  const prev = readdirSync(join(PUB, "assets/previews")).find((f) => f.endsWith(".webp"));
  return [...new Set(["/", ...pages, ...pages.slice(0, 5).map((p) => p + "/"),
    "/pagina-que-nao-existe", "/nao/existe/", "/solucoes/extra", "/x",
    "/api/sales/status", "/api/qualquer", "/admin",
    "/comprar/ZEV-IA-011", "/comprar/ZEV-NGC-011", "/comprar/NAOEXISTE", "/comprar/", "/%63omprar/ZEV-IA-011",
    "/assinar/conteudo-pronto", "/hotmart/ia-na-pratica", "/hotmart/negocio-completo", "/reembolso/solicitar",
    `/assets/${css}`, `/assets/previews/${prev}`, "/assets/nao-existe.0123456789.css", "/product.css",
    "/robots.txt", "/sitemap.xml", "/whatsapp-contact.js", "/llms.txt", "/brand/favicon.svg", "/health", "/arbm-sist"])];
}

async function snap(worker, path, method, open) {
  const res = await worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { method, headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0" } }), envFor(open), ctx);
  const headers = {}; res.headers.forEach((v, k) => { headers[k] = v; });
  const body = method === "HEAD" ? "" : Buffer.from(await res.arrayBuffer()).toString("base64");
  return { status: res.status, headers, body };
}

const SEC = ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"];
// NC-017 DEC-02: the only change on open product pages is the JSON-LD Offer price (data/products.json).
const DEC02 = { "/ia-na-pratica": [197, 97], "/vendas-na-pratica": [197, 97], "/lucro-e-caixa": [247, 147], "/combo-ia-vendas": [297, 157], "/negocio-completo": [397, 247] };
const CP_ROUTES = new Set(["/conteudo-pronto", "/assinar/conteudo-pronto"]);
const BUY_ROUTES = /^\/(comprar|%63omprar)\/ZEV-[A-Z]+-011$/;
const html64 = (r) => Buffer.from(r.body, "base64").toString();
// NC-017 intended differences (DEC-02, DEC-04, DEC-05). Returns a label when handled; asserts the guarantee.
function nc017Intended(path, method, open, a, b, key) {
  if (CP_ROUTES.has(path)) {
    // DEC-04: Conteúdo Pronto hidden: 404, noindex, no-store, no redirect to any checkout, same security headers.
    assert.equal(b.status, 404, key); assert.equal(b.headers.location, undefined, key);
    assert.match(b.headers["x-robots-tag"], /noindex/, key); assert.match(b.headers["cache-control"], /no-store/, key);
    for (const h of SEC) assert.equal(b.headers[h], a.headers[h], `${key}: ${h}`);
    if (method === "GET") assert.doesNotMatch(html64(b), /pay\.hotmart|\/assinar\/|R\$/, key);
    return "cp";
  }
  if (BUY_ROUTES.test(path)) {
    // DEC-05: the own buy route never creates a Mercado Pago checkout; open => only the gated Hotmart variant.
    for (const h of SEC) assert.equal(b.headers[h], a.headers[h], `${key}: ${h}`);
    assert.match(b.headers["x-robots-tag"], /noindex/, key); assert.match(b.headers["cache-control"], /no-store/, key);
    if (open) {
      assert.equal(b.status, 302, key); assert.match(b.headers.location, /^\/hotmart\/[a-z-]+$/, key);
    } else {
      assert.equal(b.status, a.status, key); assert.equal(b.headers.location, undefined, key);
      if (method === "GET") { const h = html64(b); assert.match(h, /Vendas abrem em breve/, key); assert.doesNotMatch(h, /href="[^"]*(\/comprar\/|pay\.|mercadopago)/, key); }
    }
    return "dec05";
  }
  if (open && method === "GET" && DEC02[path]) {
    assert.equal(b.status, a.status, key); assert.deepEqual(b.headers, a.headers, key + ": headers identical");
    const [was, now] = DEC02[path];
    assert.equal(html64(b).split(`"price":"${now}.00"`).join(`"price":"${was}.00"`), html64(a), key + ": only the DEC-02 Offer price differs");
    return "dec02";
  }
  return null;
}

const isUnknownPage = (p) => ["/pagina-que-nao-existe", "/nao/existe/", "/solucoes/extra", "/x"].includes(p);

test("differential: gh-pages Worker vs #914 Worker — only the intended differences", async () => {
  const { OLD, NEW } = await loadWorkers();
  const diffs = [];
  let compared = 0;
  for (const open of [false, true]) for (const method of ["GET", "HEAD"]) for (const path of matrix()) {
    const [a, b] = [await snap(OLD, path, method, open), await snap(NEW, path, method, open)];
    compared++;
    const same = a.status === b.status && JSON.stringify(a.headers) === JSON.stringify(b.headers) && a.body === b.body;
    if (same) continue;
    const key = `${open ? "open" : "closed"} ${method} ${path}`;
    if (isUnknownPage(path)) {
      assert.equal(a.status, 404, key + ": was 404"); assert.equal(b.status, 404, key + ": still 404");
      assert.equal(b.headers["cache-control"], "no-store", key); assert.match(b.headers["x-robots-tag"], /noindex/, key);
      assert.equal(b.headers["content-security-policy"], a.headers["content-security-policy"] || b.headers["content-security-policy"], key);
      if (method === "GET") assert.match(Buffer.from(b.body, "base64").toString(), /Esta página não existe\./, key);
      diffs.push("404:" + key); continue;
    }
    if (open && method === "GET" && path.startsWith("/hotmart/")) {
      assert.equal(a.status, b.status, key); assert.deepEqual(a.headers, b.headers, key + ": headers identical");
      const html = Buffer.from(b.body, "base64").toString();
      assert.match(html, /Pagamento processado pela Hotmart \(Pix à vista ou cartão\)/, key);
      assert.match(html, /<strong>Pagamento<\/strong><span>processado pela Hotmart/, key);
      assert.doesNotMatch(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ""), /Mercado Pago|pedir-reembolso|entrega\/reenviar/, key);
      assert.doesNotMatch(html, /boleto|peça em a Hotmart|72 horas/i, key + ": DEC-01 v3 (sem boleto) e nenhuma reescrita quebrada");
      diffs.push("hotmart:" + key); continue;
    }
    const nc = nc017Intended(path, method, open, a, b, key);
    if (nc) { diffs.push(nc + ":" + key); continue; }
    assert.fail(`unexpected difference at ${key}: status ${a.status}->${b.status}`);
  }
  assert.ok(compared > 300, "matrix size " + compared);
  assert.ok(diffs.some((d) => d.startsWith("404:")) && diffs.some((d) => d.startsWith("hotmart:")), "both intended differences observed");
  for (const k of ["cp:", "dec05:", "dec02:"]) assert.ok(diffs.some((d) => d.startsWith(k)), "NC-017 intended difference observed: " + k);
  console.log(`SALES_WORKER_DIFFERENTIAL compared=${compared} intended_differences=${diffs.length}`);
});

test("(a) 404 only for unknown page paths; known routes, /api, /comprar, assets, tombstone, robots/sitemap/legal unchanged", async () => {
  const { NEW } = await loadWorkers();
  for (const p of ["/pagina-que-nao-existe", "/x"]) {
    const r = await snap(NEW, p, "GET", false);
    assert.equal(r.status, 404); assert.equal(r.headers["cache-control"], "no-store"); assert.match(r.headers["x-robots-tag"], /noindex/);
  }
  for (const [p, status] of [["/termos", 200], ["/privacidade", 200], ["/reembolso", 200], ["/robots.txt", 200], ["/sitemap.xml", 200], ["/whatsapp-contact.js", 200], ["/api/qualquer", 404], ["/assets/nao-existe.0123456789.css", 404]]) {
    const r = await snap(NEW, p, "GET", false);
    assert.equal(r.status, status, p);
    if (status === 404) assert.notEqual(r.headers["x-robots-tag"], "noindex", p + ": not the designed 404");
  }
});

test("(c) sales closed: no buy CTA, /comprar link, checkout or InStock on any page served by the Worker", async () => {
  const { NEW } = await loadWorkers();
  for (const path of matrix().filter((p) => !/\.[a-z0-9]+$/.test(p) && !p.startsWith("/api") && !p.startsWith("/comprar") && !p.startsWith("/assinar") && !p.startsWith("/hotmart"))) {
    const r = await snap(NEW, path, "GET", false);
    const html = Buffer.from(r.body, "base64").toString();
    assert.doesNotMatch(html, /href="[^"]*\/(comprar|assinar|hotmart)\/|pay\.hotmart\.com|schema\.org\/InStock|>\s*Comprar agora/, path);
  }
});

test("(e) security headers and CSP byte-identical to gh-pages on pages, assets and checkout routes", async () => {
  const { OLD, NEW } = await loadWorkers();
  for (const p of ["/solucoes", "/ia-na-pratica", "/termos", "/comprar/ZEV-IA-011", "/assinar/conteudo-pronto", "/hotmart/ia-na-pratica", "/whatsapp-contact.js", "/robots.txt"]) {
    const [a, b] = [await snap(OLD, p, "GET", false), await snap(NEW, p, "GET", false)];
    for (const h of SEC) assert.equal(b.headers[h], a.headers[h], `${p}: ${h}`);
  }
});

test("(b) Hotmart list rewrite only in the Hotmart variant; base page already names the Hotmart for payment (DEC-05)", async () => {
  const { NEW } = await loadWorkers();
  const page = Buffer.from((await snap(NEW, "/ia-na-pratica", "GET", true)).body, "base64").toString();
  // NC-019: phase one sells only via Hotmart, so the base page states it; only the delivery item is rewritten.
  assert.match(page, /<li>Pagamento processado pela Hotmart \(Pix à vista ou cartão\)<\/li>/);
  assert.doesNotMatch(page.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ""), /Mercado Pago/);
  assert.doesNotMatch(page, /PDFs e ZIP liberados por e-mail após 192 horas/);
  const hot = await snap(NEW, "/hotmart/ia-na-pratica", "GET", true);
  assert.equal(hot.status, 200, "Hotmart variant served while open (never vacuous)");
  {
    const h = Buffer.from(hot.body, "base64").toString();
    assert.match(h, /<li>Pagamento processado pela Hotmart \(Pix à vista ou cartão\)<\/li>/);
    assert.match(h, /PDFs e ZIP liberados por e-mail após 192 horas \(8 dias\)/);
  }
});

test("(d) checkout and purchase routes return exactly what gh-pages returned (closed and open)", async () => {
  const { OLD, NEW } = await loadWorkers();
  for (const open of [false, true]) for (const p of ["/comprar/ZEV-IA-011", "/comprar/ZEV-NGC-011", "/comprar/NAOEXISTE", "/comprar/", "/%63omprar/ZEV-IA-011", "/assinar/conteudo-pronto", "/reembolso/solicitar", "/api/sales/status"]) {
    const [a, b] = [await snap(OLD, p, "GET", open), await snap(NEW, p, "GET", open)], key = `${open ? "open" : "closed"} GET ${p}`;
    if (nc017Intended(p, "GET", open, a, b, key)) continue;  // DEC-04/DEC-05, asserted fail-closed above
    assert.deepEqual(b, a, key);
  }
});
