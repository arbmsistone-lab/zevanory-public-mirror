#!/usr/bin/env node
// ZEVANORY | Crawl gate for the trees the canonical sites really serve (site audit C-01..C-03, item 4).
//
//   sales   vendas.zevanory.api.br = sales-public/ served IN-PROCESS by the real sales Worker
//           (worker/sales-public-worker.mjs, closed sales, no CORE) with the same static-assets stand-in as
//           scripts/audit/sales-local-server.mjs. Crawl from /solucoes, every sitemap <loc> and /404-check;
//           follows href/src in HTML and url() in CSS. Absolute links to the sales host count as internal.
//   blog    zevanory.api.br/blog = the central Worker renderers (worker/multichannel-autonomy.mjs) with empty and
//           populated KV; every same-origin ref must be one the central Worker serves (tests/blog-layout.test.mjs
//           holds the detailed contract; here it is part of the crawl report).
//   pages   GitHub Pages copy = pages-mirror/ stubs (and, with --pages-site DIR, the real Jekyll output of
//           actions/jekyll-build-pages): every page is a noindex redirect to the canonical host, nothing else.
//
// Fails on: a broken internal ref (non 2xx/304 after same-origin redirects), an internal-jargon hit not in the
// committed baseline (scripts/ci/site_crawl_baseline.json, which may only shrink: stale entries are reported),
// a blog ref the Worker does not serve, any Pages output that is not a compliant stub.
// Writes the JSON report to --out (default: stdout summary only). No network, no secrets.
//   node scripts/ci/site_crawl_gate.mjs [--out report.json] [--pages-site _site]
import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, normalize, extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = opt("--out");
const PAGES_SITE = opt("--pages-site");
const SALES_HOST = "https://vendas.zevanory.api.br";
const BASELINE_FILE = join(ROOT, "scripts/ci/site_crawl_baseline.json");

// Internal engineering / governance vocabulary that must never reach a customer-facing page (audit S-01, C-02).
// Product names that the sales build contract itself requires (scripts/build_sales_public.py: "SALES AUTOPILOT",
// "Autonomous Sales Platform") are a copy decision, not leaked jargon, and are not listed.
export const JARGON = [
  ["FAIL_CLOSED", /\bFAIL_CLOSED\b/g], ["UNCONFIGURED", /\bUNCONFIGURED\b/g], ["READY", /\bREADY\b/g],
  ["ZEES-16", /\bZEES-16\b/g], ["tenant", /\btenants?\b/gi], ["SHA", /\bSHA\b/g], ["kill-switch", /kill-switch/gi],
  ["gate global", /gate global/gi], ["gates oficiais", /gates? oficia(?:l|is)/gi], ["Gate antes da venda", /gate antes da venda/gi],
  ["zero dependência de JS", /zero depend[eê]ncia de JS/gi], ["deliberadamente bloqueada", /deliberadamente bloquead/gi],
  ["E2E", /\bE2E\b/g], ["webhook", /\bwebhooks?\b/gi], ["staging", /\bstaging\b/gi],
];

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".json": "application/json" };

export function visibleText(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/i, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
export function jargonHits(text) {
  const out = {};
  for (const [name, re] of JARGON) { const n = (text.match(re) || []).length; if (n) out[name] = n; }
  return out;
}
const refsOf = (body, css) => [...body.matchAll(css ? /url\(\s*["']?([^"')]+)/g : /(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

async function salesCrawl() {
  const dir = join(ROOT, "sales-public");
  const worker = (await import(pathToFileURL(join(ROOT, "worker/sales-public-worker.mjs")).href)).default;
  const ASSETS = { async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return new Response("Not found", { status: 404 });
    let body; try { body = await readFile(file); } catch { return new Response("Not found", { status: 404 }); }
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
    return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": TYPES[extname(file)] || "application/octet-stream", etag } });
  } };
  const env = { ASSETS }, ctx = { waitUntil() {} };
  const get = async (path) => worker.fetch(new Request(SALES_HOST + path, { headers: { "user-agent": "Mozilla/5.0 (ZEVANORY site crawl gate)" } }), env, ctx);
  const sitemap = await (await get("/sitemap.xml")).text();
  const starts = ["/solucoes", ...[...sitemap.matchAll(/<loc>https:\/\/vendas\.zevanory\.api\.br([^<]*)<\/loc>/g)].map((m) => m[1] || "/")];
  const seen = new Map(), referrers = new Map(), jargon = {}, apexRefs = new Set(), queue = [...new Set(starts)];
  const note = (u, from) => { if (!referrers.has(u)) referrers.set(u, new Set()); referrers.get(u).add(from); };
  starts.forEach((s) => note(s, "sitemap"));
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    let res = await get(p), hops = 0, final = p;
    while ([301, 302, 307, 308].includes(res.status) && hops++ < 5) {
      const loc = new URL(res.headers.get("location"), SALES_HOST + final);
      if (loc.origin !== SALES_HOST) break;
      final = loc.pathname + loc.search; res = await get(final);
    }
    seen.set(p, { status: res.status, final: final !== p ? final : undefined });
    const ct = res.headers.get("content-type") || "";
    if (res.status !== 200 || !(ct.includes("html") || ct.includes("css"))) continue;
    const body = await res.text();
    if (ct.includes("html")) { const hits = jargonHits(visibleText(body)); if (Object.keys(hits).length) jargon[new URL(final, SALES_HOST).pathname] = hits; }
    for (const raw of refsOf(body, ct.includes("css"))) {
      if (/^(mailto:|tel:|data:|javascript:|#)/.test(raw)) continue;
      let u; try { u = new URL(raw, SALES_HOST + final); } catch { continue; }
      if (u.origin === "https://zevanory.api.br") { apexRefs.add(u.pathname); continue; }
      if (u.origin !== SALES_HOST) continue;
      const key = u.pathname + (u.pathname.startsWith("/assets/") ? "" : u.search);
      note(key, new URL(final, SALES_HOST).pathname);
      if (!seen.has(key)) queue.push(key);
    }
  }
  const notFound = await get("/pagina-que-nao-existe-crawl-gate");
  const broken = [...seen].filter(([, v]) => !(v.status === 200 || v.status === 304)).map(([url, v]) => ({ url, ...v, referrers: [...(referrers.get(url) || [])].slice(0, 5) }));
  Object.defineProperty(salesCrawl, "get", { value: get, configurable: true });
  return { surface: "vendas.zevanory.api.br (sales-public via worker/sales-public-worker.mjs)", crawled: seen.size, broken_count: broken.length, broken,
    not_found_status: notFound.status, jargon, apex_refs_not_crawled: [...apexRefs].sort() };
}

async function blogCheck() {
  const { renderBlogIndex, renderBlogArticle, BLOG_INDEX_KEY } = await import(pathToFileURL(join(ROOT, "worker/multichannel-autonomy.mjs")).href);
  const { BLOG_CSS_PATH, BLOG_LOGO_PATH } = await import(pathToFileURL(join(ROOT, "worker/blog-layout.mjs")).href);
  const { BRAND_SIZES } = await import(pathToFileURL(join(ROOT, "worker/brand-kit.mjs")).href);
  const kv = (e) => ({ get: async (k) => e[k] ?? null, put: async () => {} });
  const a = { slug: "exemplo-2026-10-20", title: "Exemplo", description: "d", publishedAt: "2026-10-20T12:00:00Z", url: "https://zevanory.api.br/blog/exemplo-2026-10-20", day: "2026-10-20", body: "Texto.", faq: [] };
  const pages = {
    "/blog (KV vazio)": await renderBlogIndex({ ZEVANORY_PRIVATE_ARTIFACTS: kv({}) }),
    "/blog (com artigo)": await renderBlogIndex({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ [BLOG_INDEX_KEY]: JSON.stringify({ articles: [a] }) }) }),
    "/blog/<slug>": await renderBlogArticle({ ZEVANORY_PRIVATE_ARTIFACTS: kv({ ["zpc:blog:article:" + a.slug]: JSON.stringify(a) }) }, a.slug, { salesOpen: false }),
  };
  const report = {};
  for (const [name, html] of Object.entries(pages)) {
    const bad = [];
    for (const r of refsOf(html, false)) {
      if (/^(https?:|mailto:)/.test(r)) continue;
      if (r.startsWith("#")) { if (!html.includes(` id="${r.slice(1)}"`)) bad.push(r); continue; }
      const ok = r === "/blog" || r === "/blog/" + a.slug || r === BLOG_CSS_PATH || (r.startsWith("/brand/export/") && Object.hasOwn(BRAND_SIZES, r.slice(14)))
        || (r === BLOG_LOGO_PATH && existsSync(join(ROOT, "sales-public", r)));
      if (!ok) bad.push(r);
    }
    report[name] = { stylesheets: (html.match(/<link rel="stylesheet"/g) || []).length, header: html.includes('<header class="site-header">'), footer: html.includes('<footer class="site-footer">'),
      noindex: html.includes('<meta name="robots" content="noindex">'), broken_refs: bad, jargon: jargonHits(visibleText(html)) };
  }
  return { surface: "zevanory.api.br/blog (central Worker renderers)", pages: report };
}

const STUB_RE = {
  robots: /<meta name="robots" content="noindex">/, canonical: /<link rel="canonical" href="(https:\/\/vendas\.zevanory\.api\.br\/[^"]*)">/,
  refresh: /<meta http-equiv="refresh" content="0; url=(https:\/\/vendas\.zevanory\.api\.br\/[^"]*)">/, link: /<a href="(https:\/\/vendas\.zevanory\.api\.br\/[^"]*)">/,
};
export function stubProblems(html) {
  const p = [];
  const c = html.match(STUB_RE.canonical)?.[1], r = html.match(STUB_RE.refresh)?.[1], l = html.match(STUB_RE.link)?.[1];
  if (!STUB_RE.robots.test(html)) p.push("no noindex");
  if (!c) p.push("no canonical to the sales host");
  if (!r) p.push("no 0 s meta refresh to the sales host");
  if (!l) p.push("no visible link to the sales host");
  if (c && (r !== c || l !== c)) p.push("canonical, refresh and link disagree");
  if (/<link rel="stylesheet"|<img\b|<script\b/i.test(html)) p.push("loads assets (stylesheet/img/script)");
  if (/R\$\s?\d|\bpreço|checkout|comprar|contato@/i.test(html)) p.push("price/offer/legacy contact text");
  return p;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

async function pagesCheck() {
  const report = { surface: "arbmsistone-lab.github.io/zevanory-public-mirror (GitHub Pages copy)", stubs: 0, problems: [] };
  const stubDir = join(ROOT, "pages-mirror");
  if (!existsSync(stubDir)) { report.problems.push({ file: "pages-mirror/", problem: "missing (run scripts/build_pages_mirror.py)" }); return report; }
  for (const f of await walk(stubDir)) {
    const rel = relative(ROOT, f);
    const text = readFileSync(f, "utf8");
    if (f.endsWith(".html")) {
      report.stubs++;
      for (const problem of stubProblems(text)) report.problems.push({ file: rel, problem });
      const target = text.match(STUB_RE.canonical)?.[1];
      if (target) {
        // Every redirect target must be a page the sales Worker serves with 200 (no redirect chain, no 404).
        const res = await salesCrawl.get(new URL(target).pathname);
        if (res.status !== 200) report.problems.push({ file: rel, problem: `target ${target} answers ${res.status}` });
        (report.targets ||= {})[target] = res.status;
      }
    }
    else if (!f.endsWith("robots.txt")) report.problems.push({ file: rel, problem: "unexpected non-HTML file" });
    else if (/sitemap/i.test(text)) report.problems.push({ file: rel, problem: "robots.txt advertises a sitemap" });
  }
  if (PAGES_SITE) {
    // The real output of GitHub's Pages build (actions/jekyll-build-pages): only stubs and robots.txt may exist.
    const files = (await walk(PAGES_SITE)).map((f) => relative(PAGES_SITE, f).split("\\").join("/"));
    report.site_files = files.length;
    const expectedPaths = [...readFileSync(join(ROOT, "_config.yml"), "utf8").matchAll(/^ {2}- (.+)$/gm)].length;
    report.config_excludes = expectedPaths;
    for (const rel of files) {
      if (rel === "robots.txt") { const t = readFileSync(join(PAGES_SITE, rel), "utf8"); if (!/^User-agent: \*$/m.test(t) || /sitemap/i.test(t)) report.problems.push({ file: "_site/" + rel, problem: "robots.txt content" }); continue; }
      if (!rel.endsWith(".html")) { report.problems.push({ file: "_site/" + rel, problem: "published non-HTML file (source tree leaked)" }); continue; }
      for (const problem of stubProblems(readFileSync(join(PAGES_SITE, rel), "utf8"))) report.problems.push({ file: "_site/" + rel, problem });
    }
    for (const must of ["index.html", "404.html", "quem-criou/index.html", "lucro-e-caixa/index.html", "robots.txt"]) {
      if (!files.includes(must)) report.problems.push({ file: "_site/" + must, problem: "expected redirect stub missing" });
    }
    report.site_html = files.filter((f) => f.endsWith(".html")).length;
  }
  return report;
}

function compareBaseline(jargon) {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")).sales_jargon || {};
  const fresh = [], stale = [];
  for (const [page, hits] of Object.entries(jargon)) for (const [term, n] of Object.entries(hits)) {
    const allowed = baseline[page]?.[term] || 0;
    if (n > allowed) fresh.push({ page, term, count: n, baseline: allowed });
  }
  for (const [page, hits] of Object.entries(baseline)) for (const [term, n] of Object.entries(hits)) {
    if ((jargon[page]?.[term] || 0) < n) stale.push({ page, term, baseline: n, now: jargon[page]?.[term] || 0 });
  }
  return { fresh, stale };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const sales = await salesCrawl();
  const blog = await blogCheck();
  const pages = await pagesCheck();
  const { fresh, stale } = compareBaseline(sales.jargon);
  const blogBad = Object.entries(blog.pages).filter(([, v]) => v.broken_refs.length || Object.keys(v.jargon).length || v.stylesheets !== 1 || !v.header || !v.footer);
  const report = { generated_by: "scripts/ci/site_crawl_gate.mjs", sales, blog, pages, jargon_new_vs_baseline: fresh, jargon_baseline_stale: stale };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  for (const b of sales.broken) console.log(`::error title=SITE_CRAWL_BROKEN_REF::${b.url} -> ${b.status} (from ${b.referrers.join(", ")})`);
  if (sales.not_found_status !== 404) console.log(`::error title=SITE_CRAWL_404::unknown path answered ${sales.not_found_status}`);
  for (const f of fresh) console.log(`::error title=SITE_CRAWL_JARGON::${f.page}: "${f.term}" x${f.count} (baseline ${f.baseline})`);
  for (const s of stale) console.log(`::notice title=SITE_CRAWL_BASELINE_SHRINK::${s.page}: "${s.term}" now ${s.now} < baseline ${s.baseline}; lower scripts/ci/site_crawl_baseline.json`);
  for (const [name, v] of blogBad) console.log(`::error title=SITE_CRAWL_BLOG::${name} ${JSON.stringify(v)}`);
  for (const p of pages.problems) console.log(`::error title=SITE_CRAWL_PAGES_MIRROR::${p.file}: ${p.problem}`);
  const fail = sales.broken.length || sales.not_found_status !== 404 || fresh.length || blogBad.length || pages.problems.length;
  console.log(`SITE_CRAWL sales_crawled=${sales.crawled} sales_broken=${sales.broken.length} jargon_new=${fresh.length} jargon_baseline_stale=${stale.length} blog_bad=${blogBad.length} pages_stubs=${pages.stubs}${PAGES_SITE ? ` pages_site_html=${pages.site_html}` : ""} pages_problems=${pages.problems.length}`);
  console.log(fail ? "SITE_CRAWL_GATE=FAIL" : "SITE_CRAWL_GATE=PASS");
  process.exit(fail ? 1 : 0);
}
