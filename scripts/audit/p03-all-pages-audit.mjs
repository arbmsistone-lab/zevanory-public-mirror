// P03 | Auditoria completa de TODAS as páginas HTML de sales-public/ (contrapedido do contra-auditor:
// "72ª página, auditoria de acessibilidade e navegação"). Somente leitura, sem segredos, sem rede externa.
//   1. estática (scripts/audit/p03-pages-static.mjs): inventário exato, links, títulos, h1, lang,
//      landmarks, canonical/meta, sitemap e coerência comercial (tabela C, aviso, sem fabricação);
//   2. navegador (scripts/audit/p03-pages-browser.mjs): cada página em 360 px e 1350 px, servida pelo
//      Worker real em 127.0.0.1 (scripts/audit/sales-local-server.mjs): axe WCAG 2.2 AA, teclado,
//      alvos >= 24 px, overflow horizontal, erros de console/CSP.
// Falha (exit 1) com QUALQUER achado: o orçamento é zero, então qualquer regressão derruba o gate.
// Uso: node scripts/audit/p03-all-pages-audit.mjs [--out p03.json] [--pages a,b] [--static-only]
//        [--dir sales-public] [--schemes light,dark] [--viewports 360,1350]
// Dependências do navegador: playwright e axe-core resolvidos de $QUALITY_MODULES (ou node_modules).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { auditStatic, urlFor } from "./p03-pages-static.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = opt("--out", "p03-auditoria.json");
const dir = resolve(opt("--dir", join(ROOT, "sales-public")));
const only = opt("--pages", "") ? opt("--pages").split(",") : null;
const viewports = opt("--viewports", "360,1350").split(",");
const schemes = opt("--schemes", "light").split(",");
const staticOnly = argv.includes("--static-only");
const workerModule = opt("--worker", join(ROOT, "worker/sales-public-worker.mjs"));

const st = auditStatic(ROOT, dir);
const report = {
  schema: "zevanory.p03-all-pages-audit.v1", generated_at: new Date().toISOString(), dir: dir.replace(ROOT, "") || dir,
  build_sha256: createHash("sha256").update(st.site.files.map((f) => f + ":" + createHash("sha256").update(st.site.pages[f.slice(0, -5)]).digest("hex")).join("\n")).digest("hex"),
  inventory: st.inventory, viewports, schemes, static: { problems: st.problems }, browser: { cells: 0, pages: {} }, totals: {},
};
const slugs = st.inventory.pages.map((x) => x.slug).filter((s) => !only || only.includes(s));
if (only && slugs.length !== only.length) { console.error(`::error title=P03_PAGES::página(s) desconhecida(s): ${only.filter((s) => !slugs.includes(s)).join(",")}`); process.exit(2); }

if (!staticOnly) {
  const req = createRequire(join(process.env.QUALITY_MODULES || join(ROOT, "node_modules"), "noop.js"));
  const { chromium } = req("playwright");
  const axeSource = readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
  report.axe_version = JSON.parse(readFileSync(req.resolve("axe-core/package.json"), "utf8")).version;
  report.playwright_version = JSON.parse(readFileSync(req.resolve("playwright/package.json"), "utf8")).version;
  const { auditPage } = await import("./p03-pages-browser.mjs");
  const port = 18000 + Math.floor(Math.random() * 2000);
  const srv = spawn(process.execPath, [join(ROOT, "scripts/audit/sales-local-server.mjs"), String(port), dir, workerModule], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, ko) => { const t = setTimeout(() => ko(new Error("servidor local não subiu")), 20000); srv.stdout.on("data", (b) => { if (String(b).includes("SALES_LOCAL_SERVER=")) { clearTimeout(t); ok(); } }); srv.on("exit", (c) => ko(new Error("servidor saiu " + c))); });
  const browser = await chromium.launch();
  report.chromium_version = browser.version();
  try {
    const cells = [];
    for (const slug of slugs) for (const vp of viewports) for (const sc of schemes) cells.push([slug, vp, sc]);
    const CONC = Number(process.env.P03_CONCURRENCY || 4);
    let next = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (next < cells.length) {
        const [slug, vp, sc] = cells[next++];
        const u = urlFor(slug);
        const r = await auditPage(browser, `http://127.0.0.1:${port}${u.path}`, { viewport: vp, scheme: sc, axeSource, expectStatus: u.status });
        (report.browser.pages[slug] ||= { path: u.path, cells: {} }).cells[`${vp}-${sc}`] = r;
        report.browser.cells++;
      }
    }));
  } finally { await browser.close(); srv.kill(); }
}

const browserProblems = [];
for (const [slug, pg] of Object.entries(report.browser.pages)) for (const [cell, r] of Object.entries(pg.cells)) for (const pr of r.problems) browserProblems.push({ ...pr, page: slug, cell });
const byCode = {};
for (const pr of [...st.problems, ...browserProblems]) byCode[pr.code] = (byCode[pr.code] || 0) + 1;
const axeOther = {};
for (const pg of Object.values(report.browser.pages)) for (const r of Object.values(pg.cells)) for (const v of r.info.axe || []) if (v.impact !== "serious" && v.impact !== "critical") axeOther[`${v.id}:${v.impact}`] = (axeOther[`${v.id}:${v.impact}`] || 0) + 1;
report.totals = { pages: st.inventory.count, pages_audited: slugs.length, cells: report.browser.cells, static_problems: st.problems.length,
  browser_problems: browserProblems.length, by_code: byCode, axe_moderate_minor_cells: axeOther,
  pages_with_problems: [...new Set([...st.problems, ...browserProblems].map((x) => x.page))].sort() };
report.pass = st.problems.length === 0 && browserProblems.length === 0 && (staticOnly || report.browser.cells === slugs.length * viewports.length * schemes.length);
writeFileSync(out, JSON.stringify(report, null, 1) + "\n");
for (const pr of st.problems) console.log(`::error title=P03_${pr.code} ${pr.page}::${pr.msg}`);
for (const pr of browserProblems) console.log(`::error title=P03_${pr.code} ${pr.page} [${pr.cell}]::${pr.msg}`);
console.log(`P03_ALL_PAGES_AUDIT=${report.pass ? "PASS" : "FAIL"} pages=${st.inventory.count} audited=${slugs.length} cells=${report.browser.cells} static=${st.problems.length} browser=${browserProblems.length} by_code=${JSON.stringify(byCode)}`);
process.exit(report.pass ? 0 : 1);
