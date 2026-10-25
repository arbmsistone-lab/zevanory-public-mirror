// Sol 232: merges the per-theme budget reports (sales-quality-budget.json, light and dark) into one
// per-page summary: Lighthouse (median/min scores, LCP, CLS, TBT), axe (serious/critical and other),
// 44 px targets, focus, reduced motion, scroll exception and the colour-scheme emulation check.
// Usage: node sales-budget-summary.mjs <light.json> <dark.json> <out.json> [--commit <sha>]
import { readFileSync, writeFileSync } from "node:fs";

const [lightPath, darkPath, outPath, ...rest] = process.argv.slice(2);
const commit = rest[rest.indexOf("--commit") + 1] && rest.includes("--commit") ? rest[rest.indexOf("--commit") + 1] : null;
const themes = { light: JSON.parse(readFileSync(lightPath, "utf8")), dark: JSON.parse(readFileSync(darkPath, "utf8")) };
const out = { schema: "zevanory.sales-budget-results.v1", commit, generated_by: "scripts/audit/sales-quality-budget.mjs + sales-budget-summary.mjs", budget: themes.light.budget, runs: themes.light.runs, themes: {}, pass: true };
for (const [theme, r] of Object.entries(themes)) {
  if (r.scheme !== theme) throw new Error(`${theme} report has scheme ${r.scheme}`);
  const pages = {};
  for (const [path, devices] of Object.entries(r.pages)) {
    pages[path] = {};
    for (const [device, row] of Object.entries(devices)) {
      const b = row.browser || {}, lh = row.lighthouse;
      const axeSerious = (b.axe || []).filter((v) => v.impact === "serious" || v.impact === "critical");
      pages[path][device] = {
        lighthouse: lh && { median: lh.median, min: lh.min, lcp_ms: lh.lcp, cls: lh.cls, tbt_ms: lh.tbt, failing_audits: lh.failingAudits },
        axe: { serious_critical: axeSerious.length, other: (b.axe || []).length - axeSerious.length, ids: (b.axe || []).map((v) => `${v.id}:${v.impact}`) },
        targets_under_44px: (b.targets || []).length,
        focus_issues: (b.focus || []).length,
        reduced_motion_issues: (b.motion || []).length,
        scroll_exception_issues: (b.scroll || []).length,
        console_errors: (b.consoleErrors || []).length,
        color_scheme_emulated: !!b.schemeOk,
      };
    }
  }
  out.themes[theme] = { base: r.base, pages, failures: r.failures, pass: r.failures.length === 0 };
  out.pass &&= r.failures.length === 0;
}
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`SALES_BUDGET_RESULTS=${out.pass ? "PASS" : "FAIL"} pages=${Object.keys(out.themes.light.pages).length} themes=2 -> ${outPath}`);
