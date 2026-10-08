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

// WCAG 2 AA via axe (pa11y runner).
try {
  const pa11y = require("pa11y");
  const res = await pa11y(url, { runners: ["axe"], standard: "WCAG2AA", timeout: 60000,
    viewport: device === "desktop" ? { width: 1350, height: 940 } : { width: 412, height: 823, isMobile: true },
    chromeLaunchConfig: { executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } });
  const errs = res.issues.filter(x => x.type === "error");
  note(errs.length ? "error" : "notice", "F5_AXE", `violations=${errs.length}${errs.length ? " " + [...new Set(errs.map(e => e.code))].slice(0, 6).join(",") : ""}`);
  // Distinct offending (selector | message) pairs, so the cause can be fixed at the source CSS.
  const seen = new Set(), detail = [];
  for (const e of errs) {
    const msg = String(e.message || "").replace(/\s+/g, " ").slice(0, 200);
    const k = e.selector + "|" + msg;
    if (!seen.has(k)) { seen.add(k); detail.push(`${e.selector} :: ${msg}`.slice(0, 300)); }
  }
  for (const d of detail.slice(0, 7)) note("warning", "F5_AXE_DETAIL", d);
  if (errs.length) failures.push(`axe:${errs.length}`);
} catch (e) { failures.push("axe:did_not_run"); note("error", "F5_AXE", "did_not_run " + String(e.message).slice(0, 80)); }

if (failures.length) {
  note("error", "F5_FAIL", failures.join(" ; ") + (hints.size ? " || causes: " + [...hints.values()].slice(0, 12).join(", ") : ""));
  process.exit(1);
}
note("notice", "F5_PASS", `all ${runs} runs within targets (perf>=${T.perf}, a11y/bp/seo=100, LCP<2.5s, CLS<0.1, TBT<200ms, 0 console errors, 0 4xx) + axe 0`);
