// F5 gate: every individual Lighthouse run must meet the owner's targets (no medians).
// Emits compact GitHub annotations; never prints customer data (public pages only).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const origin = process.env.ORIGIN, page = process.env.PAGE, device = process.env.DEVICE;
const runs = Number(process.env.RUNS || 5);
const url = origin + page;
const T = {
  perf: device === "desktop" ? 98 : 95, a11y: 100, bp: 100, seo: 100,
  lcp: 2500, cls: 0.1, tbt: 200,
};
const tag = `${device} ${page}`;
const note = (lvl, title, msg) => console.log(`::${lvl} title=${title}::${tag} ${msg}`.slice(0, 900));
const failures = [], lines = [], hints = new Map();

for (let i = 1; i <= runs; i++) {
  const out = `/tmp/lh-${i}.json`;
  rmSync(out, { force: true });
  const args = [url, "--output=json", `--output-path=${out}`, "--quiet",
    "--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage",
    "--only-categories=performance,accessibility,best-practices,seo", "--max-wait-for-load=45000"];
  if (device === "desktop") args.push("--preset=desktop");
  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const r = spawnSync(process.execPath, [require.resolve("lighthouse/cli/index.js"), ...args], { encoding: "utf8", timeout: 180000 });
    try { readFileSync(out); ok = true; } catch { if (attempt === 2) { failures.push(`run${i}:lighthouse_did_not_complete`); } }
  }
  if (!ok) continue;
  const lh = JSON.parse(readFileSync(out, "utf8"));
  const c = lh.categories, a = lh.audits;
  const m = {
    perf: Math.round(c.performance.score * 100), a11y: Math.round(c.accessibility.score * 100),
    bp: Math.round(c["best-practices"].score * 100), seo: Math.round(c.seo.score * 100),
    lcp: Math.round(a["largest-contentful-paint"].numericValue), cls: Number(a["cumulative-layout-shift"].numericValue.toFixed(3)),
    tbt: Math.round(a["total-blocking-time"].numericValue),
    console: a["errors-in-console"]?.details?.items?.length || 0,
    bad: (a["network-requests"]?.details?.items || []).filter(x => Number(x.statusCode) >= 400).length,
  };
  lines.push(`r${i}:P${m.perf}/A${m.a11y}/B${m.bp}/S${m.seo} LCP${m.lcp} CLS${m.cls} TBT${m.tbt} err${m.console} 4xx${m.bad}`);
  const f = [];
  if (m.perf < T.perf) f.push(`perf${m.perf}<${T.perf}`);
  for (const k of ["a11y", "bp", "seo"]) if (m[k] < T[k]) f.push(`${k}${m[k]}<100`);
  if (m.lcp >= T.lcp) f.push(`LCP${m.lcp}`);
  if (m.cls >= T.cls) f.push(`CLS${m.cls}`);
  if (m.tbt >= T.tbt) f.push(`TBT${m.tbt}`);
  if (m.console) f.push(`console_errors${m.console}`);
  if (m.bad) f.push(`http4xx5xx${m.bad}`);
  // Third-party entities and legacy JS sources (to fix the cause at the edge configuration).
  const tp = (a["third-party-summary"]?.details?.items || []).map(x => `${x.entity?.text || x.entity}:${Math.round(x.blockingTime || 0)}ms:${Math.round((x.transferSize || 0) / 1024)}KiB`);
  const legacy = (a["legacy-javascript"]?.details?.items || a["legacy-javascript-insight"]?.details?.items || []).map(x => String(x.url || "").replace(/^https?:\/\/[^/]+/, "")).slice(0, 3);
  const longCache = (a["uses-long-cache-ttl"]?.details?.items || []).map(x => String(x.url || "").replace(/^https?:\/\/[^/]+/, "") + "@" + Math.round((x.cacheLifetimeMs || 0) / 1000) + "s").slice(0, 3);
  if (i === 1 && (tp.length || legacy.length || longCache.length)) note("warning", "F5_THIRD_PARTY", `tp=[${tp.join(", ")}] legacy=[${legacy.join(", ")}] short_cache=[${longCache.join(", ")}]`);
  if (f.length) {
    failures.push(`run${i}:${f.join(",")}`);
    // Collect the failing audits to point at the cause.
    for (const [id, au] of Object.entries(a)) {
      if (au.score !== null && au.score < 0.9 && au.scoreDisplayMode !== "informative" && au.scoreDisplayMode !== "notApplicable" && au.scoreDisplayMode !== "manual")
        hints.set(id, (au.displayValue ? `${id}(${au.displayValue})` : id));
    }
  }
}
note("notice", "F5_RUNS", lines.join(" | "));

// WCAG 2 AA via axe-core injected directly (full node data: colors and ratio), after load settles.
try {
  const puppeteer = require("puppeteer-core");
  const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"], headless: "new" });
  const pg = await browser.newPage();
  await pg.setViewport(device === "desktop" ? { width: 1350, height: 940 } : { width: 412, height: 823, isMobile: true, deviceScaleFactor: 2 });
  const resp = await pg.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));
  const css = await pg.evaluate(() => [...document.styleSheets].map(s => { try { return (s.href || "inline") + ":" + s.cssRules.length; } catch { return (s.href || "inline") + ":blocked"; } }));
  await pg.evaluate(axeSource);
  const res = await pg.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }));
  await browser.close();
  const nodes = res.violations.flatMap(v => v.nodes.map(n => ({ id: v.id, sel: n.target.join(" "), d: (n.any[0] || n.all[0] || n.none[0] || {}).data || {} })));
  note(nodes.length ? "error" : "notice", "F5_AXE", `http=${resp?.status()} css=${css.join(",").slice(0, 160)} violations=${nodes.length} incomplete=${res.incomplete.length}`);
  const seen = new Set();
  for (const n of nodes) {
    const k = n.id + n.sel; if (seen.has(k)) continue; seen.add(k);
    if (seen.size > 6) break;
    note("warning", "F5_AXE_DETAIL", `${n.id} ${n.sel} fg=${n.d.fgColor} bg=${n.d.bgColor} ratio=${n.d.contrastRatio} need=${n.d.expectedContrastRatio} size=${n.d.fontSize}`);
  }
  if (nodes.length) failures.push(`axe:${nodes.length}`);
} catch (e) { failures.push("axe:did_not_run"); note("error", "F5_AXE", "did_not_run " + String(e.message).slice(0, 120)); }

if (failures.length) {
  note("error", "F5_FAIL", failures.join(" ; ") + (hints.size ? " || causes: " + [...hints.values()].slice(0, 12).join(", ") : ""));
  process.exit(1);
}
note("notice", "F5_PASS", `all ${runs} runs within targets (perf>=${T.perf}, a11y/bp/seo=100, LCP<2.5s, CLS<0.1, TBT<200ms, 0 console errors, 0 4xx) + axe 0`);
