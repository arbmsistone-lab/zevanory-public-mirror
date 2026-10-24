// E2 (2026-10-24): stale banned contact through caching. The old /whatsapp-contact.js was served
// "public, max-age=86400, stale-while-revalidate=604800", so returning visitors kept running an OLD
// cached copy that injected wa.me links to the permanently banned number. Contract:
//   (a) published sales pages load only content-hashed CSS/JS (/assets/<name>.<sha256[:10]>.<ext>),
//       the file exists and its content matches the hash; no external script/style host;
//   (b) nothing published, no sales source and no build input references the retired script; the
//       only repo references left are listed below with a reason (apex surfaces, the Worker tombstone);
//   (c) the Worker serves hashed assets immutable, unhashed CSS/JS with revalidation, pages with a
//       short max-age and no stale-while-revalidate, and the old path as a no-store, inert no-op.
// Mutants (unhashed script/stylesheet, retired script tag or name, stale hash, external CDN) are all
// killed; the no-store oracle of the old path is asserted directly in (c).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readTextNormalized } from "./helpers/text.mjs";
import worker, { RETIRED_CONTACT_BODY, assetCacheControl, PAGE_CACHE_CONTROL } from "../worker/sales-public-worker.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUB = join(ROOT, "sales-public");
const RETIRED = "whatsapp-contact";
const HASHED = /^\/assets\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.([0-9a-f]{10})\.(?:css|js|woff2)$/;
const pages = readdirSync(PUB).filter((f) => f.endsWith(".html"));

function assetViolations(name, html, exists = (p) => existsSync(join(PUB, p)), read = (p) => readFileSync(join(PUB, p))) {
  const out = [];
  const refs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g), ...html.matchAll(/<link\b[^>]*\brel="(?:stylesheet|preload|modulepreload)"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:)?\/\//.test(ref)) { out.push(`${name}: external ${ref}`); continue; }
    const m = ref.match(HASHED);
    if (!m) { out.push(`${name}: unhashed ${ref}`); continue; }
    const rel = ref.slice(1);
    if (!exists(rel)) { out.push(`${name}: missing ${ref}`); continue; }
    if (createHash("sha256").update(read(rel)).digest("hex").slice(0, 10) !== m[1]) out.push(`${name}: stale hash ${ref}`);
  }
  if (html.includes(RETIRED)) out.push(`${name}: retired contact script referenced`);
  return out;
}

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? walk(p, acc) : acc.push(p); }
  return acc;
}

test("(a) every published page loads only content-hashed CSS/JS that exists and matches its hash", () => {
  assert.ok(pages.length > 60, "full surface");
  let refs = 0;
  for (const f of pages) {
    const html = readTextNormalized(join(PUB, f));
    refs += (html.match(/<link rel="stylesheet"|<script\b[^>]*\bsrc=/g) || []).length;
    assert.deepEqual(assetViolations(f, html), [], f);
  }
  assert.ok(refs >= pages.length, "every page has at least its stylesheet");
});

test("(b) nothing published or built references the retired contact script", () => {
  for (const p of walk(PUB)) {
    if (!/\.(html|js|css|txt|xml|json)$/.test(p)) continue;
    assert.ok(!readTextNormalized(p).includes(RETIRED), p);
  }
  assert.ok(!existsSync(join(PUB, RETIRED + ".js")), "no published copy");
  assert.ok(!existsSync(join(ROOT, "sales-overlay", RETIRED + ".js")), "no overlay source");
  for (const p of walk(join(ROOT, "sales-overlay"))) if (/\.(html|js|txt|json)$/.test(p)) assert.ok(!readTextNormalized(p).includes(RETIRED), p);
  for (const f of pages) {
    const src = join(ROOT, f.replace(/\.html$/, ""), "index.html");
    if (existsSync(src)) assert.ok(!readTextNormalized(src).includes(RETIRED), src);
  }
});

// Every other repo file that still names the old path, and why it is not a sales surface.
const ALLOWLIST = new Map(Object.entries({
  "worker/sales-public-worker.mjs": "the tombstone route itself (no-store no-op for the old path)",
  "scripts/build_sales_public.py": "build gate that fails if a page references the retired script",
  ".github/workflows/zevanory-sales-public-release.yml": "release grep gate that fails if the build references it",
  "public/arbm-contador-saloes.html": "apex (zevanory.api.br) frozen snapshot, central deploy; not the sales site",
  "scripts/deploy/prepare-central-candidate.py": "apex central generator: overwrites the apex copy with an inert script",
  "worker/cloudflare-worker.recovered.mjs": "apex central worker bundle (readback of the apex copy)",
  "scripts/ci/mutants_whatsapp_retirement.expected.json": "apex mutant manifest (#896)",
  "docs/evidence/whatsapp-retirement-mutant-causality.md": "historical evidence (not published)",
}));

test("(b) repo-wide: the old path survives only in the explicit, non-sales allowlist", () => {
  const r = spawnSync("git", ["grep", "-l", RETIRED], { cwd: ROOT, encoding: "utf8" });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  const files = r.stdout.split("\n").filter(Boolean).filter((f) => !f.startsWith("tests/"));
  assert.deepEqual(files.filter((f) => !ALLOWLIST.has(f)), [], "outside the allowlist");
  assert.deepEqual([...ALLOWLIST.keys()].filter((f) => !files.includes(f)), [], "obsolete allowlist entry (the list only shrinks)");
});

const ctx = { waitUntil() {} };
const TYPES = { css: "text/css", js: "text/javascript", html: "text/html; charset=utf-8", svg: "image/svg+xml", webp: "image/webp" };
const env = { ASSETS: { fetch: async (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname).slice(1);
  const f = join(PUB, p);
  if (!p || !existsSync(f) || statSync(f).isDirectory()) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(f), { status: 200, headers: { "content-type": TYPES[p.split(".").pop()] || "application/octet-stream" } });
} } };
const get = (path, method = "GET") => worker.fetch(new Request("https://vendas.zevanory.api.br" + path, { method, headers: { "user-agent": "Mozilla/5.0" } }), env, ctx);

test("(c) Worker: old contact path is a no-store inert no-op (GET and HEAD)", async () => {
  for (const method of ["GET", "HEAD"]) {
    const res = await get("/" + RETIRED + ".js", method);
    assert.equal(res.status, 200, method);
    assert.equal(res.headers.get("cache-control"), "no-store", method);
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const body = await res.text();
    assert.equal(body, method === "HEAD" ? "" : RETIRED_CONTACT_BODY);
  }
  assert.doesNotMatch(RETIRED_CONTACT_BODY, /wa\.me|whatsapp\.com|\d{8,}|document|location|fetch|import/i, "no behaviour at all");
});

test("(c) Worker: hashed assets immutable, unhashed CSS/JS revalidate, pages without stale-while-revalidate", async () => {
  const css = readdirSync(join(PUB, "assets")).find((f) => /^product\.[0-9a-f]{10}\.css$/.test(f));
  const js = readdirSync(join(PUB, "assets")).find((f) => /^ferramentas\.[0-9a-f]{10}\.js$/.test(f));
  for (const f of [css, js]) {
    const res = await get("/assets/" + f);
    assert.equal(res.status, 200, f);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", f);
  }
  const plain = await get("/product.css");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get("cache-control"), "no-cache", "unhashed stylesheet revalidates");
  const page = await get("/calculadora-cmv");
  assert.equal(page.headers.get("cache-control"), PAGE_CACHE_CONTROL);
  assert.doesNotMatch(PAGE_CACHE_CONTROL, /stale-while-revalidate|immutable/);
  assert.match(PAGE_CACHE_CONTROL, /max-age=(\d{1,3})\b/);
  assert.ok(Number(PAGE_CACHE_CONTROL.match(/max-age=(\d+)/)[1]) <= 300);
  const img = await get("/assets/renan-bitu.webp");
  assert.equal(img.headers.get("cache-control"), "public, max-age=86400", "unhashed image: a day, never immutable");
  // A 404 under /assets/ must not be cached as immutable.
  const missing = await get("/assets/product.0000000000.css");
  assert.equal(missing.status, 404);
  assert.notEqual(missing.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(assetCacheControl("/assets/app.js"), "no-cache", "a .js without hash is never immutable");
  assert.equal(assetCacheControl("/ferramentas.js"), "no-cache");
  assert.equal(assetCacheControl("/assets/fonts/archivo.0123456789.woff2"), "public, max-age=31536000, immutable");
});

test("mutants: unhashed script/stylesheet, retired script tag, stale hash, external CDN — all killed", async () => {
  const page = readTextNormalized(join(PUB, "calculadora-cmv.html"));
  const js = page.match(/src="(\/assets\/ferramentas\.[0-9a-f]{10}\.js)"/)[1];
  const mutants = {
    "A1 unhashed script": page.replace(js, "/ferramentas.js"),
    "A2 retired contact script back": page.replace("</body>", `<script src="/${RETIRED}.js" defer></script></body>`),
    "A3 stale hash": page.replace(js, js.replace(/\.[0-9a-f]{10}\./, ".0123456789.")),
    "A4 external CDN": page.replace("</body>", '<script src="https://cdn.jsdelivr.net/npm/x@1/x.js"></script></body>'),
    "A5 unhashed stylesheet": page.replace(/href="\/assets\/product\.[0-9a-f]{10}\.css"/, 'href="/product.css"'),
    "A6 retired name in inline text": page.replace("</main>", `<p>${RETIRED}</p></main>`),
  };
  const report = [];
  assert.deepEqual(assetViolations("x", page), [], "original clean");
  for (const [name, html] of Object.entries(mutants)) {
    assert.notEqual(html, page, "mutation not applied: " + name);
    const v = assetViolations("x", html);
    report.push(`${name}: ${v.length ? "KILLED" : "SURVIVED"}`);
    assert.ok(v.length, name + " survived");
  }
  console.log("SALES_ASSET_CACHE_MUTANTS " + report.join(" | "));
});
