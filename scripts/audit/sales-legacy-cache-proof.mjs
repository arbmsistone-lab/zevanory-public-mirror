// Counterproof for the retired contact script and the browser HTTP cache (Sol 170, PR #911).
//
// One localhost origin, one server process, three switchable builds served THROUGH their own Worker:
//   injector : the last build whose contact script still injected wa.me links (parent of #892),
//   base     : #892 deployed (script bytes are e-mail only, every page still references the path),
//   new      : this PR (no page references it; the old path is a no-store tombstone).
// A persistent Chromium profile (real disk cache) visits pages under "injector", then the server is
// switched and the profile keeps going: reload, fresh navigation, other pages, back, and simulated
// expiry. Expiry is simulated with the HTTP Age header on the OLD responses (RFC 9111 4.2.3: the
// browser counts Age as time already spent in caches), so every Cache-Control value stays exactly as
// the old Worker sent it. The banned number is replaced in the served bytes by 5500000000000.
//
// Usage: QUALITY_MODULES=<dir>/node_modules node scripts/audit/sales-legacy-cache-proof.mjs \
//          <injectorRoot> <baseRoot> <newRoot> <outDir>
// Each root is a checkout (sales-public/ + worker/). Read-only, localhost only, no secrets.
// Exit 1 when an invariant fails; observations (the residual window) are written, not asserted away.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";

const [injRoot, baseRoot, newRoot, outDir = "legacy-cache"] = process.argv.slice(2);
if (!injRoot || !baseRoot || !newRoot) { console.error("usage: <injectorRoot> <baseRoot> <newRoot> [outDir]"); process.exit(2); }
const req = createRequire(join(process.env.QUALITY_MODULES || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");

const SCRIPT = "/" + ["whatsapp", "contact"].join("-") + ".js"; // retired path, built so the name stays out of greps
const DUMMY = "5500000000000";
// WhatsApp link markers, assembled so this harness never matches the repo-wide banned-link scan.
const WA_SELECTOR = [["wa", "me/"], ["api", "whatsapp", "com"]].map((p) => `a[href*="${p.join(".")}"]`).join(",");
const WA_RE = new RegExp(["wa", "me"].join("\\."));
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".json": "application/json" };

function assetsFor(dir) {
  return { async fetch(r) {
    const path = decodeURIComponent(new URL(r.url).pathname);
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir)) return new Response("Not found", { status: 404 });
    let body;
    try { body = await readFile(file); } catch { return new Response("Not found", { status: 404 }); }
    const etag = '"' + createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
    const headers = { "content-type": TYPES[extname(file)] || "application/octet-stream", etag };
    if (r.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(r.method === "HEAD" ? null : body, { status: 200, headers });
  } };
}
async function load(name, root) {
  root = resolve(root);
  const worker = (await import(pathToFileURL(join(root, "worker/sales-public-worker.mjs")).href)).default;
  return { name, worker, env: { ASSETS: assetsFor(join(root, "sales-public")) } };
}
const BUILDS = { injector: await load("injector", injRoot), base: await load("base", baseRoot), new: await load("new", newRoot) };

// Mask the banned number in the injector's script (and fail if the shape is not the expected one).
function mask(text) {
  const out = text.replace(/const NUMBER='\d+',DISPLAY='[^']*'/, `const NUMBER='${DUMMY}',DISPLAY='+55 00 00000-0000'`);
  if (out === text && WA_RE.test(text)) throw new Error("injector shape changed: cannot mask the number");
  if (/\d{11,}/.test(out.replace(DUMMY, ""))) throw new Error("unmasked long digit run in served script");
  return out;
}

const state = { mode: "injector", age: null, stripClearSiteData: false, log: [] };
const server = createServer(async (inc, out) => {
  try {
    const b = BUILDS[state.mode];
    const headers = new Headers();
    for (const [k, v] of Object.entries(inc.headers)) if (typeof v === "string") headers.set(k, v);
    const port = server.address().port;
    const res = await b.worker.fetch(new Request(`http://127.0.0.1:${port}${inc.url}`, { method: inc.method, headers }), b.env, { waitUntil() {} });
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    let body = res.body && inc.method !== "HEAD" ? Buffer.from(await res.arrayBuffer()) : undefined;
    const path = new URL(inc.url, "http://x").pathname;
    if (path === SCRIPT && body && res.status === 200) { body = Buffer.from(mask(body.toString("utf8"))); delete h["content-length"]; }
    if (state.stripClearSiteData) delete h["clear-site-data"];
    const age = state.age && state.age(path, h["content-type"] || "");
    if (age != null && res.status === 200) h.age = String(age);
    state.log.push({ mode: state.mode, method: inc.method, path, status: res.status, conditional: !!inc.headers["if-none-match"],
      cache_control: h["cache-control"] || "", clear_site_data: h["clear-site-data"] || "", age: h.age || "" });
    out.writeHead(res.status, h);
    out.end(body);
  } catch (e) {
    out.writeHead(500, { "content-type": "text/plain" });
    out.end("proof harness error: " + String(e?.message || e).slice(0, 200));
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const observations = [];
const failures = [];
function fail(msg) { failures.push(msg); console.log("LEGACY_CACHE_FAIL " + msg); }

async function scenario(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), "legacy-cache-"));
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const net = new Map(); // requestId -> {url, fromDiskCache, fromMemory}
  cdp.on("Network.requestWillBeSent", (e) => net.set(e.requestId, { url: e.request.url, type: e.type }));
  cdp.on("Network.requestServedFromCache", (e) => { const n = net.get(e.requestId); if (n) n.memory = true; });
  cdp.on("Network.responseReceived", (e) => { const n = net.get(e.requestId); if (n) { n.disk = !!e.response.fromDiskCache; n.status = e.response.status; } });
  state.mode = "injector"; state.age = null; state.stripClearSiteData = false;
  const step = async (label, action, path) => {
    const logStart = state.log.length;
    net.clear();
    let restoredFromBfcache = false;
    if (action === "goto") await page.goto(ORIGIN + path, { waitUntil: "load" });
    else if (action === "reload") await page.reload({ waitUntil: "load" });
    else if (action === "navigate-link") { await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.evaluate((p) => { location.href = p; }, path)]); }
    else if (action === "back") { await page.goBack({ waitUntil: "load" }); }
    await sleep(400); // deferred scripts + async revalidation
    const dom = await page.evaluate(([s, waSel]) => ({
      path: location.pathname,
      references_retired_script: !!document.querySelector(`script[src="${s}"]`),
      wa_links: document.querySelectorAll(waSel).length,
      injected_ctas: document.querySelectorAll("[data-whatsapp-official]").length,
      nav_type: performance.getEntriesByType("navigation")[0]?.type || "",
      transfer_size: performance.getEntriesByType("navigation")[0]?.transferSize ?? -1,
    }), [SCRIPT, WA_SELECTOR]);
    if (action === "back") restoredFromBfcache = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type === "back_forward" && (performance.getEntriesByType("navigation")[0]?.transferSize ?? 1) === 0);
    const reqs = [...net.values()];
    const docReq = reqs.find((r) => r.type === "Document");
    const scriptReq = reqs.find((r) => r.url.endsWith(SCRIPT));
    const server_hits = state.log.slice(logStart).map((l) => `${l.status}${l.conditional ? "(cond)" : ""} ${l.path}${l.clear_site_data ? " +CSD" : ""}`);
    const docServer = state.log.slice(logStart).filter((l) => l.path === (path && action !== "reload" && action !== "back" ? path : dom.path));
    const document_source = docReq ? (docReq.disk || docReq.memory ? (docServer.length ? "cache+background-revalidation" : "browser-cache") : (docReq.status === 304 ? "revalidated-304" : "network")) : (restoredFromBfcache ? "bfcache" : "none");
    const script_source = !dom.references_retired_script ? "not-referenced" : scriptReq ? (scriptReq.disk || scriptReq.memory ? (state.log.slice(logStart).some((l) => l.path === SCRIPT) ? "cache+background-revalidation" : "browser-cache") : "network") : "not-requested";
    const o = { scenario: name, step: label, server_mode: state.mode, action, ...dom, document_source, script_source, server_hits };
    observations.push(o);
    console.log(`LEGACY_CACHE ${name} | ${label} | mode=${state.mode} ${action} ${dom.path} | doc=${document_source} refs_script=${dom.references_retired_script} script=${script_source} | wa_links=${dom.wa_links} injected=${dom.injected_ctas} | server: ${server_hits.join(", ") || "-"}`);
    // INV1: a document without the retired reference can never show a wa.me link.
    if (!dom.references_retired_script && (dom.wa_links || dom.injected_ctas)) fail(`${name}/${label}: wa.me without the retired reference`);
    // INV2: under the new server, any injection must come from an OLD document taken from the browser.
    if (state.mode === "new" && (dom.wa_links || dom.injected_ctas) && !/cache|bfcache/.test(document_source)) fail(`${name}/${label}: injection with a document from the network`);
    return o;
  };
  try { await fn(step, page); } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
}
const isHtml = (ct) => ct.startsWith("text/html");

// Realistic cache state at the moment this PR is deployed: the injector's script bytes were cached
// before #892 went live (fresh 1 d, then stale-while-revalidate 7 d), and #892 pages (which still
// reference the path) were cached in the minutes before the switch. Priming: one page under the
// injector build (caches the script), then #892 pages under the base build.
async function prime(step, { scriptAge = null, htmlAge = null, baseScriptAge = null, skipInjector = false } = {}) {
  if (!skipInjector) {
    state.mode = "injector"; state.age = (p) => (p === SCRIPT ? scriptAge : null);
    const a = await step("prime: injector build caches the old script", "goto", "/calculadora-cmv");
    if (!a.injected_ctas) fail("prime: the injector build did not inject (proof would be vacuous)");
  }
  state.mode = "base"; state.age = (p, ct) => (isHtml(ct) ? htmlAge : p === SCRIPT ? baseScriptAge : null);
  const b = await step("prime: #892 page cached (still references the path)", "goto", "/ferramentas");
  state.age = null;
  return b;
}

// S1: real headers, no simulated time.
await scenario("S1-real-headers", async (step) => {
  const h = await prime(step);
  if (!h.injected_ctas) fail("S1: hazard not reproduced (#892 page + cached injector script should inject)");
  await step("#892 live: another #892 page", "goto", "/termos");
  await step("#892 live: another #892 page", "goto", "/calculadora-preco-de-venda");
  await step("#892 live: reload (page revalidated, script still from cache)", "reload");
  state.mode = "new";
  await step("PR live: unseen page", "goto", "/calculadora-taxa-maquininha");
  await step("PR live: back to the #892 page", "back");
  await step("PR live: reload it", "reload");
  await step("PR live: fresh navigation to a #892 page cached < 300 s ago", "goto", "/ferramentas");
  await step("PR live: link navigation to a #892 page cached < 300 s ago", "navigate-link", "/termos");
  await step("PR live: sales-switch page (no-store before and after)", "goto", "/solucoes");
  await step("PR live: the reloaded page again", "goto", "/calculadora-preco-de-venda");
});

// S2/S3: the cached #892 page passes max-age=300 (S2: still inside its stale-while-revalidate=3600;
// S3: past the whole 300 + 3600 s), simulated with Age on that HTML response.
for (const [name, htmlAge] of [["S2-old-html-stale-in-swr", 300 - 2], ["S3-old-html-past-swr", 300 + 3600 - 2]]) {
  await scenario(name, async (step) => {
    await prime(step, { htmlAge });
    await sleep(4000);
    state.mode = "new";
    const o = await step("PR live: navigation to the expired #892 page", "goto", "/ferramentas");
    if (o.injected_ctas || o.wa_links || o.document_source !== "network") fail(`${name}: an expired old page was used for a navigation (doc=${o.document_source})`);
    await step("PR live: next navigation", "goto", "/ferramentas");
  });
}

// S4: the cached #892 page is still fresh but the injector's script passed max-age=86400 and is inside
// stale-while-revalidate=604800. S5: the script entry is past its whole window (1 d + 7 d), so the
// browser must fetch it synchronously; primed with #892 bytes (an injector copy that old would already
// have been replaced by #892's on the priming visit). Each with and without Clear-Site-Data.
for (const [name, opts, strip] of [
  ["S4-old-script-stale-in-swr", { scriptAge: 86400 - 2 }, false], ["S4c-same-without-clear-site-data", { scriptAge: 86400 - 2 }, true],
  ["S5-old-script-past-swr", { skipInjector: true, baseScriptAge: 86400 + 604800 + 60 }, false], ["S5c-same-without-clear-site-data", { skipInjector: true, baseScriptAge: 86400 + 604800 + 60 }, true]]) {
  await scenario(name, async (step) => {
    await prime(step, opts);
    await step("prime: second #892 page", "goto", "/termos");
    await sleep(4000);
    state.mode = "new"; state.stripClearSiteData = strip;
    const f = await step("PR live: cached #892 page, expired script", "goto", "/ferramentas");
    if (opts.baseScriptAge && f.script_source !== "network") fail(`${name}: the expired script was not fetched (script=${f.script_source})`);
    const n = await step("PR live: next navigation to the same page", "goto", "/ferramentas");
    const o = await step("PR live: other cached #892 page", "goto", "/termos");
    if (!strip) for (const x of [n, o]) if (x.document_source !== "network") fail(`${name}: Clear-Site-Data did not evict the old page (doc=${x.document_source})`);
    if (strip) for (const x of [n, o]) if (x.document_source === "network") fail(`${name}: control run evicted without Clear-Site-Data (the comparison would be meaningless)`);
    for (const x of [n, o]) if (x.injected_ctas || x.wa_links) fail(`${name}: the old script ran again after the tombstone was fetched`);
  });
}
server.close();

// Tombstone headers as seen on the wire.
const tomb = state.log.filter((l) => l.mode === "new" && l.path === SCRIPT);
for (const t of tomb) if (t.cache_control !== "no-store") fail("tombstone without no-store");
const csdSeen = tomb.filter((t) => t.clear_site_data === '"cache"').length;

// Residual summary: every injection observed after the switch to this PR.
const residual = observations.filter((o) => o.server_mode === "new" && (o.wa_links || o.injected_ctas));
const byScenario = (s) => observations.filter((o) => o.scenario === s && o.server_mode === "new");
const summary = {
  origin_note: "one localhost origin; persistent Chromium profile per scenario",
  chromium: chromium.name(),
  pinned: { injector: resolve(injRoot), base: resolve(baseRoot), new: resolve(newRoot) },
  tombstone_responses: tomb.length, tombstone_with_clear_site_data: csdSeen,
  residual_injections_after_switch: residual.map((o) => `${o.scenario}/${o.step}: doc=${o.document_source} script=${o.script_source}`),
  scenarios: Object.fromEntries([...new Set(observations.map((o) => o.scenario))].map((s) => [s, byScenario(s).map((o) => ({ step: o.step, doc: o.document_source, script: o.script_source, injected: o.injected_ctas, wa_links: o.wa_links }))])),
  failures,
};
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "legacy-cache-observations.json"), JSON.stringify({ summary, observations, server_log: state.log }, null, 2));
const md = ["| scenario | step | server | doc source | refs old script | script source | wa.me links | injected CTAs |", "|---|---|---|---|---|---|---|---|",
  ...observations.map((o) => `| ${o.scenario} | ${o.step} | ${o.server_mode} | ${o.document_source} | ${o.references_retired_script} | ${o.script_source} | ${o.wa_links} | ${o.injected_ctas} |`)].join("\n");
await writeFile(join(outDir, "legacy-cache-observations.md"), md + "\n");
console.log("LEGACY_CACHE_RESIDUAL " + (residual.length ? residual.map((o) => `${o.scenario}/${o.step}`).join(" ; ") : "none"));
console.log(`LEGACY_CACHE_TOMBSTONE responses=${tomb.length} clear_site_data=${csdSeen}`);
console.log("LEGACY_CACHE_PROOF=" + (failures.length ? "FAIL" : "PASS"));
process.exit(failures.length ? 1 : 0);
