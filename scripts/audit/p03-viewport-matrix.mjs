// P03 (Ordem 013 quadro F2 + Roteiro §6): viewport matrix gate for the in-repo public pages.
// Serves nothing itself: pass the base URL of a localhost server rooted at sales-public/.
// Matrix: every sales-public/*.html x 5 viewports x 2 color schemes (light/dark) = pages*10 cells.
// Per cell: HTTP 200, no document-level scroll (scrollWidth/scrollHeight > client), no element with
// overflow auto/scroll/overlay that actually overflows (internal scrollbar), no content clipped
// horizontally outside the viewport, axe-core WCAG 2.x A/AA = 0.
// Known gaps are listed EXACTLY below: a new failure fails, and a gap that disappears also fails
// (so the list can only shrink deliberately). Usage:
//   node p03-viewport-matrix.mjs <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "noop.js"));
const { chromium } = require("playwright");
const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const VIEWPORTS = [[1536, 730], [1280, 720], [1366, 768], [1024, 768], [390, 844]];
export const THEMES = ["light", "dark"];
// Product pages follow the product.css "viewport contract": no global scroll, content scrolls inside
// <main id="conteudo">. That internal scroller is a known P03 gap pending a product decision.
const SANCTIONED_MAIN = "main#conteudo";
// Legal pages (legal.css) still scroll at document level in every cell. Known P03 gap.
const KNOWN_DOC_V = new Set(["afiliados.html", "privacidade.html", "reembolso.html", "termos.html"]);

const [base, dir, expectedArg, out = "p03-viewport-matrix"] = process.argv.slice(2);
if (!base || !dir || !expectedArg) { console.error("usage: <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]"); process.exit(2); }
const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
const expected = Number(expectedArg);

function measure() {
  const de = document.documentElement;
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
  const internal = [];
  for (const el of document.querySelectorAll("body, body *")) {
    const s = getComputedStyle(el);
    const sy = /(auto|scroll|overlay)/.test(s.overflowY), sx = /(auto|scroll|overlay)/.test(s.overflowX);
    if (!sy && !sx) continue;
    const v = sy && el.scrollHeight > el.clientHeight + 1, h = sx && el.scrollWidth > el.clientWidth + 1;
    if (v || h) internal.push({ el: sel(el), v, h, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth });
  }
  // Content clipped by overflow:hidden (html/body/main) has no scrollbar but is unreachable: count it.
  // Elements fully parked off-screen to the left (skip links, honeypots) are an intentional hide pattern.
  const inHScroller = (el) => { for (let a = el.parentElement; a && a !== de; a = a.parentElement) { if (/(auto|scroll|overlay)/.test(getComputedStyle(a).overflowX)) return true; } return false; };
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0) continue;
    if ((r.right > de.clientWidth + 1 || r.left < -1) && !inHScroller(el)) clipped.push({ el: sel(el), left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { docH: de.scrollWidth > de.clientWidth + 1, docV: de.scrollHeight > de.clientHeight + 1, internal, clipped: clipped.slice(0, 10), clippedCount: clipped.length };
}
async function axeRun(page) {
  await page.addScriptTag({ content: axeSrc });
  return page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }))
    .violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })));
}
function verdict(file, m, ax, http) {
  const problems = [], gaps = [];
  if (http !== 200) problems.push("http_" + http);
  if (m.docH) problems.push("doc_scroll_h");
  if (m.clippedCount) problems.push(`clipped_x:${m.clippedCount}:${m.clipped.map((c) => c.el).slice(0, 3).join("+")}`);
  if (m.docV) (KNOWN_DOC_V.has(file) ? gaps : problems).push("doc_scroll_v");
  for (const i of m.internal) {
    if (i.el === SANCTIONED_MAIN && i.v && !i.h) gaps.push("internal_v:" + i.el);
    else problems.push(`internal_${i.v ? "v" : ""}${i.h ? "h" : ""}:${i.el}`);
  }
  for (const v of ax) problems.push(`axe:${v.id}(${v.impact})`);
  return { problems, gaps };
}

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
// Self-test: the detector must flag a horizontal document overflow and an overflowing inner scroller.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.setContent('<main><div style="width:2000px;height:10px"></div><div id="box" style="height:50px;overflow:auto"><div style="height:500px"></div></div></main>');
  const m = await p.evaluate(measure);
  await ctx.close();
  if (!m.docH || !m.clippedCount || !m.internal.some((i) => i.el === "div#box" && i.v)) { console.log("::error title=P03_SELFTEST::detector did not flag synthetic overflow " + JSON.stringify(m)); process.exit(1); }
  console.log("P03_SELFTEST=PASS");
}
const rows = [], failures = [], seenGaps = new Set();
for (const file of pages) for (const [w, h] of VIEWPORTS) for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  const page = await ctx.newPage();
  const res = await page.goto(`${base}/${file}`, { waitUntil: "load" });
  const m = await page.evaluate(measure);
  const ax = await axeRun(page);
  const { problems, gaps } = verdict(file, m, ax, res?.status() ?? 0);
  gaps.forEach((g) => seenGaps.add(file + "|" + g));
  const row = { page: file, viewport: `${w}x${h}`, theme, http: res?.status() ?? 0, scroll_doc_h: m.docH, scroll_doc_v: m.docV, scroll_internal: m.internal, clipped_x: m.clippedCount, axe: ax, problems, known_gaps: gaps };
  rows.push(row);
  if (problems.length) failures.push(row);
  await ctx.close();
}
await browser.close();
// Stale known gaps fail too, so the exception list only shrinks on purpose.
const stale = [...KNOWN_DOC_V].filter((f) => !seenGaps.has(f + "|doc_scroll_v"));
const summary = { schema: "zevanory.p03.viewport-matrix.v1", pages: pages.length, expected_pages: expected, viewports: VIEWPORTS.map((v) => v.join("x")), themes: THEMES,
  cells: rows.length, failures: failures.length, known_gap_cells: rows.filter((r) => r.known_gaps.length).length, stale_known_gaps: stale };
fs.writeFileSync(out + ".json", JSON.stringify({ ...summary, rows }, null, 1));
fs.writeFileSync(out + ".csv", ["page,viewport,theme,http,scroll_doc_h,scroll_doc_v,scroll_internal,axe_violations,problems,known_gaps",
  ...rows.map((r) => [r.page, r.viewport, r.theme, r.http, r.scroll_doc_h, r.scroll_doc_v, `"${r.scroll_internal.map((i) => i.el + (i.v ? "[V]" : "") + (i.h ? "[H]" : "")).join(" ")}"`, r.axe.length, `"${r.problems.join(" ")}"`, `"${r.known_gaps.join(" ")}"`].join(","))].join("\n"));
console.log("::notice title=P03_VIEWPORT_MATRIX::" + JSON.stringify(summary));
let bad = false;
if (pages.length !== expected) { console.log(`::error title=P03_PAGE_COUNT::expected ${expected} pages, found ${pages.length}`); bad = true; }
if (rows.length !== expected * VIEWPORTS.length * THEMES.length) { console.log("::error title=P03_CELL_COUNT::" + rows.length); bad = true; }
for (const f of failures.slice(0, 40)) console.log("::error title=P03_CELL_FAIL::" + JSON.stringify({ page: f.page, viewport: f.viewport, theme: f.theme, problems: f.problems }));
if (failures.length) bad = true;
if (stale.length) { console.log("::error title=P03_STALE_KNOWN_GAP::remove from KNOWN_DOC_V: " + stale.join(",")); bad = true; }
console.log(bad ? "P03_VIEWPORT_MATRIX=FAIL" : "P03_VIEWPORT_MATRIX=PASS");
if (bad) process.exit(1);
