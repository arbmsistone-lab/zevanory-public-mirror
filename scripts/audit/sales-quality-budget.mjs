// E3: Lighthouse + axe + WCAG 2.2 AA budget for the sales site, measured on a LOCAL build served
// through the real Worker (scripts/audit/sales-local-server.mjs). Read-only, no secrets, no network
// beyond localhost. Budgets (every page, mobile AND desktop):
//   Lighthouse 13: performance >= 95 (median of RUNS scored runs, one unscored warm-up),
//                  accessibility = best-practices = SEO = 100 in EVERY scored run;
//   axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice): zero serious/critical;
//   internal standard: every visible interactive target >= 44x44 CSS px (whole document);
//   WCAG 2.4.7/2.4.11/2.4.13: keyboard focus visible (>= 2px outline or ring) and never hidden
//   scroll exception: vertical document scroll only, no horizontal scroll, no scrolling panels;
//   under sticky UI; WCAG 2.3.3 / prefers-reduced-motion: no animation, transition or smooth scroll.
// Usage: QUALITY_MODULES=/path/node_modules node sales-quality-budget.mjs <baseUrl> <outDir> [--report-only]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [base, outDir = "sales-quality", ...flags] = process.argv.slice(2);
const reportOnly = flags.includes("--report-only");
const RUNS = Number(process.env.RUNS || 3);
// Both themes: COLOR_SCHEME=light|dark emulates prefers-color-scheme (Lighthouse via --force-dark-mode,
// Playwright via colorScheme) and every browser check asserts the emulation actually took effect.
const SCHEME = process.env.COLOR_SCHEME === "dark" ? "dark" : "light";
const req = createRequire(join(process.env.QUALITY_MODULES || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");
const AXE = readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
const LH = req.resolve("lighthouse/cli/index.js");
export const PAGES = (process.env.PAGES || "/solucoes,/zevanory-sales,/ia-na-pratica,/termos").split(",");
const BUDGET = { performance: 95, accessibility: 100, "best-practices": 100, seo: 100 };
mkdirSync(outDir, { recursive: true });
const chromePath = chromium.executablePath();
const result = { schema: "zevanory.sales-quality-budget.v1", base, scheme: SCHEME, budget: BUDGET, runs: RUNS, pages: {}, failures: [] };
const fail = (page, device, msg) => result.failures.push(`${page} [${device}] ${msg}`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- Lighthouse ---------------------------------------------------------------------------
function lighthouse(url, device, i) {
  const out = join(outDir, `lh-${SCHEME}-${device}-${url.replace(/\W+/g, "_")}-${i}.json`);
  rmSync(out, { force: true });
  const args = [LH, url, "--output=json", `--output-path=${out}`, "--quiet",
    `--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage${SCHEME === "dark" ? " --force-dark-mode" : ""}`,
    "--only-categories=performance,accessibility,best-practices,seo", "--max-wait-for-load=45000"];
  if (device === "desktop") args.push("--preset=desktop");
  for (let attempt = 0; attempt < 2; attempt++) {
    spawnSync(process.execPath, args, { encoding: "utf8", timeout: 240000, env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH || chromePath } });
    try {
      const lh = JSON.parse(readFileSync(out, "utf8"));
      const score = Object.fromEntries(Object.entries(lh.categories).map(([k, v]) => [k, Math.round((v.score ?? 0) * 100)]));
      const failing = Object.values(lh.audits).filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "notApplicable" && a.scoreDisplayMode !== "manual")
        .filter((a) => ["accessibility", "best-practices", "seo"].some((c) => lh.categories[c].auditRefs.some((r) => r.id === a.id && r.weight > 0)))
        .map((a) => a.id);
      const m = { score, lcp: Math.round(lh.audits["largest-contentful-paint"].numericValue), cls: +lh.audits["cumulative-layout-shift"].numericValue.toFixed(3), tbt: Math.round(lh.audits["total-blocking-time"].numericValue), failing };
      if (i > 0) rmSync(out, { force: true });  // keep only the first scored report per page/device
      return m;
    } catch { /* retry once */ }
  }
  return null;
}

// ---- Browser checks (axe, targets, focus, reduced motion) ---------------------------------
async function browserChecks(browser, url, device) {
  const vp = device === "mobile" ? { width: 360, height: 800 } : { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport: vp, bypassCSP: true, reducedMotion: "no-preference", colorScheme: SCHEME, isMobile: device === "mobile", hasTouch: device === "mobile" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
  await page.goto(url, { waitUntil: "load" });
  const schemeOk = await page.evaluate((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, SCHEME);
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") }));
  });
  const targets = await page.evaluate(() => {
    const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!r.width || !r.height || s.visibility === "hidden" || s.display === "none") return false;
      if (r.bottom + window.scrollY <= 0) return false;  // off-screen until focused (skip link)
      if (el.closest("[hidden],[aria-hidden=true]")) return false;
      return r.width < 44 || r.height < 44;
    }).slice(0, 12).map((el) => { const r = el.getBoundingClientRect(); return `${el.tagName.toLowerCase()}"${(el.textContent || el.value || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`; });
  });
  // Keyboard: Tab through up to 40 stops; each must show >= 2px outline/ring and not be covered.
  const focus = [];
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    // Wait for the focus scroll (smooth when motion is allowed) to settle before measuring.
    await page.evaluate(() => new Promise((res) => { let last = -1, still = 0; const t0 = performance.now();
      const tick = () => { if (scrollY === last) still++; else { last = scrollY; still = 0; } if (still > 4 || performance.now() - t0 > 1500) res(); else requestAnimationFrame(tick); }; tick(); }));
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { done: true };
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) || (s.boxShadow && s.boxShadow !== "none");
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 0), innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
      return { label: `${el.tagName.toLowerCase()}"${(el.textContent || "").trim().slice(0, 30)}"`, ring, covered };
    });
    if (f.done) break;
    if (!f.ring) focus.push(`no visible focus: ${f.label}`);
    if (f.covered) focus.push(`focus hidden under other content: ${f.label}`);
  }
  // Scroll exception (owner, in writing: "APROVO ROLAGEM VERTICAL NAS PÁGINAS PÚBLICAS"): vertical document
  // scroll only; no horizontal scroll anywhere; no element (panel) scrolls on its own.
  const scroll = await page.evaluate(() => {
    const de = document.documentElement, bad = [];
    if (de.scrollWidth > de.clientWidth + 1) bad.push(`horizontal page scroll ${de.scrollWidth}>${de.clientWidth}`);
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      const sy = /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const sx = /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (sy || sx) bad.push(`panel scroll ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`);
    }
    return bad.slice(0, 6);
  });
  await ctx.close();
  // Reduced motion: emulate the preference and require no motion at all.
  const rctx = await browser.newContext({ viewport: vp, reducedMotion: "reduce", colorScheme: SCHEME });
  const rp = await rctx.newPage();
  await rp.goto(url, { waitUntil: "load" });
  const motion = await rp.evaluate(() => {
    const secs = (v) => Math.max(...v.split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) / 1000 : parseFloat(x)) || 0));
    const bad = [];
    for (const el of [document.documentElement, ...document.querySelectorAll("body *")]) {
      for (const pseudo of [null, "::before", "::after"]) {
        const s = getComputedStyle(el, pseudo);
        if (s.animationName !== "none" && secs(s.animationDuration) > 0.01) bad.push(`animation ${el.tagName}${pseudo || ""}`);
        if (secs(s.transitionDuration) > 0.01) bad.push(`transition ${el.tagName}${pseudo || ""}`);
      }
    }
    if (getComputedStyle(document.documentElement).scrollBehavior === "smooth") bad.push("smooth scroll");
    return [...new Set(bad)].slice(0, 8);
  });
  await rctx.close();
  return { axe, targets, focus: [...new Set(focus)].slice(0, 8), motion, consoleErrors, scroll, schemeOk };
}

const browser = await chromium.launch();
for (const path of PAGES) {
  const url = base + path;
  result.pages[path] = {};
  for (const device of ["mobile", "desktop"]) {
    const runs = [];
    for (let i = 0; i <= RUNS; i++) { const m = lighthouse(url, device, i); if (i > 0) runs.push(m); }
    const ok = runs.filter(Boolean);
    const row = { lighthouse: null, browser: null };
    if (ok.length < RUNS) fail(path, device, `lighthouse completed ${ok.length}/${RUNS}`);
    if (ok.length) {
      const med = Object.fromEntries(Object.keys(BUDGET).map((k) => [k, median(ok.map((r) => r.score[k]))]));
      const min = Object.fromEntries(Object.keys(BUDGET).map((k) => [k, Math.min(...ok.map((r) => r.score[k]))]));
      row.lighthouse = { median: med, min, lcp: median(ok.map((r) => r.lcp)), cls: Math.max(...ok.map((r) => r.cls)), tbt: median(ok.map((r) => r.tbt)), failingAudits: [...new Set(ok.flatMap((r) => r.failing))] };
      if (med.performance < BUDGET.performance) fail(path, device, `performance ${med.performance} < ${BUDGET.performance}`);
      for (const k of ["accessibility", "best-practices", "seo"]) if (min[k] < 100) fail(path, device, `${k} ${min[k]} < 100 (${row.lighthouse.failingAudits.join(",")})`);
    }
    const b = await browserChecks(browser, url, device);
    row.browser = b;
    const serious = b.axe.filter((v) => v.impact === "serious" || v.impact === "critical");
    if (serious.length) fail(path, device, `axe serious/critical: ${serious.map((v) => `${v.id}(${v.nodes}) ${v.sample}`).join("; ")}`);
    if (b.targets.length) fail(path, device, `targets < 44px: ${b.targets.join("; ")}`);
    if (b.focus.length) fail(path, device, `focus: ${b.focus.join("; ")}`);
    if (b.motion.length) fail(path, device, `reduced motion ignored: ${b.motion.join("; ")}`);
    if (b.consoleErrors.length) fail(path, device, `console errors: ${b.consoleErrors.join("; ")}`);
    if (b.scroll.length) fail(path, device, `scroll exception violated: ${b.scroll.join("; ")}`);
    if (!b.schemeOk) fail(path, device, `prefers-color-scheme: ${SCHEME} emulation did not take effect`);
    result.pages[path][device] = row;
    const lh = row.lighthouse ? `P${row.lighthouse.median.performance}/A${row.lighthouse.min.accessibility}/BP${row.lighthouse.min["best-practices"]}/SEO${row.lighthouse.min.seo} LCP${row.lighthouse.lcp}` : "LH n/a";
    console.log(`::notice title=SALES_QUALITY ${SCHEME} ${device} ${path}::${lh} axe_serious=${serious.length} axe_other=${b.axe.length - serious.length} small_targets=${b.targets.length} focus=${b.focus.length} motion=${b.motion.length}`);
  }
}
await browser.close();
writeFileSync(join(outDir, "sales-quality-budget.json"), JSON.stringify(result, null, 2));
for (const f of result.failures) console.log(`::${reportOnly ? "warning" : "error"} title=SALES_QUALITY_BUDGET::${f}`.slice(0, 1000));
console.log(`SALES_QUALITY_BUDGET=${result.failures.length ? "FAIL" : "PASS"} failures=${result.failures.length}${reportOnly ? " (report-only)" : ""}`);
if (result.failures.length && !reportOnly) process.exitCode = 1;
