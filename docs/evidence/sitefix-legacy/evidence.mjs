// Evidence for the legacy-tree/blog PR: before/after screenshots (360/1024/1440 x light/dark) + metrics JSON.
// Usage: node evidence.mjs <beforeTree> <afterTree(worktree)> <outDir>
// Servers (localhost only):
//   pages-before : GitHub Pages emulation of the BEFORE tree (raw files under /zevanory-public-mirror/)
//   pages-after  : Jekyll emulation of the AFTER tree (only pages-mirror stubs at their permalinks; 404 stub otherwise)
//   blog-before  : BEFORE renderBlogIndex/renderBlogArticle
//   blog-after   : AFTER renderers + Worker-served stylesheet + apex brand assets, with the PRODUCTION apex CSP
import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const req = createRequire("/opt/npm-tools/node_modules/noop.js");
const { chromium } = req("playwright");
const [BEFORE, AFTER, OUT] = process.argv.slice(2);
await mkdir(OUT, { recursive: true });
const PFX = "/zevanory-public-mirror";
const T = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain", ".xml": "application/xml" };
const CSP = "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'";
const listen = (handler) => new Promise((res) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${s.address().port}`)); });

async function rawFile(dir, p) {
  let f = normalize(join(dir, p)); if (!f.startsWith(dir)) return null;
  try { if ((await stat(f)).isDirectory()) f = join(f, "index.html"); return { body: await readFile(f), type: T[extname(f)] || "application/octet-stream" }; } catch { return null; }
}
const pagesBefore = await listen(async (q, r) => {
  const p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (!p.startsWith(PFX)) { r.writeHead(404); return r.end("outside project"); }
  const f = await rawFile(BEFORE, p.slice(PFX.length) || "/");
  if (!f) { r.writeHead(404, { "content-type": "text/html" }); return r.end("<h1>404</h1>"); }
  r.writeHead(200, { "content-type": f.type }); r.end(f.body);
});
const stubs = new Map();
for (const n of await readdir(join(AFTER, "pages-mirror"))) {
  const t = await readFile(join(AFTER, "pages-mirror", n), "utf8");
  const m = t.match(/^---\npermalink: ([^\n]+)\n[\s\S]*?---\n/);
  stubs.set(m[1], { body: t.slice(m[0].length), type: n.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8" });
}
const pagesAfter = await listen(async (q, r) => {
  let p = decodeURIComponent(new URL(q.url, "http://x").pathname);
  if (!p.startsWith(PFX)) { r.writeHead(404); return r.end("outside project"); }
  p = p.slice(PFX.length) || "/";
  const s = stubs.get(p) || stubs.get(p + "/");
  if (s) { r.writeHead(200, { "content-type": s.type }); return r.end(s.body); }
  const nf = stubs.get("/404.html"); r.writeHead(404, { "content-type": nf.type }); r.end(nf.body);
});
const kv = (e) => ({ get: async (k) => e[k] ?? null, put: async () => {} });
const ART = { slug: "rotina-de-caixa-2026-10-20", title: "Rotina de caixa em 10 minutos por semana", description: "Um passo a passo simples para fechar a semana sabendo quanto sobrou.", publishedAt: "2026-10-20T12:00:00Z", url: "https://zevanory.api.br/blog/rotina-de-caixa-2026-10-20", day: "2026-10-20", product: "ZEV-LCX-011",
  body: "Separe entradas e saídas todos os dias, no mesmo horário.\n\n## Como começar\n\nAnote o saldo inicial do caixa e cada saída com o motivo.\n\n## O que olhar na sexta\n\nCompare o que entrou com o que saiu e veja quanto sobrou.", faq: [{ q: "Preciso de sistema?", a: "Não. Uma planilha simples resolve no começo." }] };
const fullKv = { "zpc:blog:index:v1": JSON.stringify({ articles: [ART] }), ["zpc:blog:article:" + ART.slug]: JSON.stringify(ART) };
async function blogServer(tree, withAssets) {
  const mc = await import(pathToFileURL(join(tree, "worker/multichannel-autonomy.mjs")).href + "?" + tree);
  const layout = withAssets ? await import(pathToFileURL(join(tree, "worker/blog-layout.mjs")).href) : null;
  return listen(async (q, r) => {
    const u = new URL(q.url, "http://x"), p = u.pathname, empty = u.searchParams.has("vazio");
    const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv(empty ? {} : fullKv), PUBLIC_BASE_URL: "https://zevanory.api.br" };
    const h = { "content-security-policy": CSP };
    if (p === "/blog") { r.writeHead(200, { ...h, "content-type": T[".html"] }); return r.end(await mc.renderBlogIndex(env)); }
    if (p.startsWith("/blog/")) { const a = await mc.renderBlogArticle(env, p.slice(6), { salesOpen: false }); r.writeHead(a ? 200 : 404, { ...h, "content-type": T[".html"] }); return r.end(a || "not found"); }
    if (layout && p === layout.BLOG_CSS_PATH) { const res = layout.blogCssResponse(new Request("http://x" + p)); r.writeHead(200, { ...h, "content-type": res.headers.get("content-type") }); return r.end(await res.text()); }
    if (p === "/brand/zevanory-logo-dark.svg") { const f = await rawFile(join(tree, "sales-public"), p); if (f) { r.writeHead(200, { ...h, "content-type": f.type }); return r.end(f.body); } }
    if (p.startsWith("/brand/export/")) { const f = await rawFile(join(tree, "assets/brand/export"), p.slice(14)); if (f) { r.writeHead(200, { ...h, "content-type": f.type }); return r.end(f.body); } }
    r.writeHead(404, h); r.end("not found");
  });
}
const blogBefore = await blogServer(BEFORE, false);
const blogAfter = await blogServer(AFTER, true);

// Same crawl as the audit repro kit (repro-site/scripts/crawl.mjs): same-origin href/src/url(), status of each.
async function crawl(base, start) {
  const seen = new Map(), refs = new Map(), q = [start];
  while (q.length) {
    const p = q.shift(); if (seen.has(p)) continue;
    const r = await fetch(base + p, { redirect: "manual" }); seen.set(p, r.status);
    const ct = r.headers.get("content-type") || ""; if (!ct.includes("html") && !ct.includes("css")) continue;
    const t = await r.text(); const re = ct.includes("css") ? /url\(["']?([^"')]+)/g : /(?:href|src)="([^"]+)"/g; let m;
    while ((m = re.exec(t))) { let u = m[1].replace(/&amp;/g, "&"); if (/^(mailto:|tel:|data:|javascript:|#|https?:)/.test(u)) continue; u = new URL(u, base + p).pathname; (refs.get(u) || refs.set(u, new Set()).get(u)).add(p); if (!seen.has(u)) q.push(u); }
  }
  const bad = [...seen].filter(([, s]) => s !== 200 && s !== 304).map(([url, status]) => ({ url, status, referrers: [...(refs.get(url) || [])].slice(0, 5) }));
  return { base_kind: base.includes(pagesBefore) ? "before" : "after", start, crawled: seen.size, bad_count: bad.length, bad };
}
const crawls = { pages_before: await crawl(pagesBefore, "/zevanory-public-mirror/"), pages_after: await crawl(pagesAfter, "/zevanory-public-mirror/") };
await writeFile(join(OUT, "crawl-pages-before-after.json"), JSON.stringify(crawls, null, 1) + "\n");
console.log("crawl pages before", crawls.pages_before.crawled, "bad", crawls.pages_before.bad_count, "| after", crawls.pages_after.crawled, "bad", crawls.pages_after.bad_count);
const ROUTES = {
  pages: [["home", "/zevanory-public-mirror/"], ["quem-criou", "/zevanory-public-mirror/quem-criou/"], ["lucro-e-caixa", "/zevanory-public-mirror/lucro-e-caixa/"]],
  blog: [["blog-vazio", "/blog?vazio"], ["blog-com-artigo", "/blog"], ["artigo", "/blog/" + ART.slug]],
};
const VIEWS = [[360, 800], [1024, 768], [1440, 900]];
const browser = await chromium.launch();
const metrics = [];
for (const [state, bases] of [["before", { pages: pagesBefore, blog: blogBefore }], ["after", { pages: pagesAfter, blog: blogAfter }]]) {
  for (const [surface, routes] of Object.entries(ROUTES)) for (const [name, path] of routes) for (const scheme of ["light", "dark"]) for (const [w, hgt] of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme });
    const page = await ctx.newPage();
    const failed = [], cspViolations = [], targets = [];
    // The canonical host is not reachable from the sandbox: a 204 keeps the browser on the stub (the refresh
    // was attempted; its target URL is recorded) so the stub itself can be photographed.
    await page.route("https://vendas.zevanory.api.br/**", (route) => { targets.push(route.request().url()); route.fulfill({ status: 204 }); });
    page.on("response", (res) => { if (res.status() >= 400 && res.url().startsWith("http://127.0.0.1")) failed.push(`${res.status()} ${new URL(res.url()).pathname}`); });
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text().slice(0, 160)); });
    const resp = await page.goto(bases[surface] + path, { waitUntil: "load" });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({
      title: document.title,
      stylesheets_loaded: [...document.styleSheets].filter((s) => { try { return s.cssRules.length > 0; } catch { return true; } }).length,
      stylesheet_links: document.querySelectorAll('link[rel="stylesheet"]').length,
      canonical: document.querySelector('link[rel="canonical"]')?.href || null,
      robots: document.querySelector('meta[name="robots"]')?.content || null,
      refresh: document.querySelector('meta[http-equiv="refresh"]')?.content || null,
      has_header: !!document.querySelector("header"), has_nav: !!document.querySelector("nav"), has_footer: !!document.querySelector("footer"),
      h1: [...document.querySelectorAll("h1")].map((x) => x.textContent.trim()).slice(0, 2),
      broken_images: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")),
      overflow_x: document.documentElement.scrollWidth > window.innerWidth,
      bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color,
      price_text: /R\$\s?\d/.test(document.body.innerText),
      text_head: document.body.innerText.replace(/\s+/g, " ").slice(0, 160),
    }));
    const file = `${state}-${surface}-${name}-${w}-${scheme}.png`;
    await page.screenshot({ path: join(OUT, file), fullPage: false });
    metrics.push({ state, surface, name, path, width: w, scheme, status: resp.status(), file, failed_requests: [...new Set(failed)], csp_violations: cspViolations, refresh_navigation_attempted_to: [...new Set(targets)], ...m });
    await ctx.close();
  }
}
if (process.env.AXE) {
  const AXE = await readFile(process.env.AXE, "utf8"), axeOut = [];
  for (const [surface, path] of [["blog", "/blog?vazio"], ["blog", "/blog"], ["blog", "/blog/" + ART.slug], ["pages", "/zevanory-public-mirror/quem-criou/"], ["pages", "/zevanory-public-mirror/nao-existe"]]) for (const scheme of ["light", "dark"]) for (const w of [360, 1440]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, bypassCSP: true });
    const page = await ctx.newPage();
    await page.route("https://vendas.zevanory.api.br/**", (route) => route.fulfill({ status: 204 }));
    await page.goto((surface === "blog" ? blogAfter : pagesAfter) + path, { waitUntil: "load" });
    await page.addScriptTag({ content: AXE });
    const r = await page.evaluate(async () => { const x = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"] } }); return { version: axe.version, violations: x.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })) }; });
    axeOut.push({ surface, path, scheme, width: w, ...r });
    await ctx.close();
  }
  await writeFile(join(OUT, "axe-after.json"), JSON.stringify(axeOut, null, 1) + "\n");
  for (const a of axeOut) console.log("axe", a.version, a.path, a.scheme, a.width, a.violations.map((v) => v.id + "x" + v.nodes).join(",") || "0 violations");
}
await browser.close();
await writeFile(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 1) + "\n");
const pick = (st, su, n) => metrics.find((x) => x.state === st && x.surface === su && x.name === n && x.width === 360 && x.scheme === "light");
for (const [su, n] of [["pages", "home"], ["pages", "quem-criou"], ["pages", "lucro-e-caixa"], ["blog", "blog-vazio"], ["blog", "artigo"]]) {
  for (const st of ["before", "after"]) { const x = pick(st, su, n); console.log(st.padEnd(6), su, n.padEnd(14), x.status, `css=${x.stylesheets_loaded}/${x.stylesheet_links}`, `robots=${x.robots}`, `canonical=${x.canonical}`, `failed=${x.failed_requests.length}`, `refresh->${x.refresh_navigation_attempted_to.join(",")}`, `price=${x.price_text}`, `csp=${x.csp_violations.length}`); }
}
process.exit(0);
