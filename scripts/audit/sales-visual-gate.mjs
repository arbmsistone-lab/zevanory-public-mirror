// Pre-merge visual gate for the sales site, run on the CANDIDATE build served from localhost
// (the apex gate measures the live site, so it can only catch a regression after publication).
// Same assertions as apex for <main>: every visible link/button >= 44x44 px, nothing clipped,
// no horizontal overflow, lang set. Usage: node sales-visual-gate.mjs <baseUrl> <playwrightModule> [page...]
const [base, pwModule = "playwright", ...pagesArg] = process.argv.slice(2);
const pages = pagesArg.length ? pagesArg : ["solucoes.html"];
export const VIEWPORTS = [[390, 844], [768, 1024], [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1536, 730], [1920, 1080]];
const pw = await import(pwModule); const { chromium } = pw.default || pw;
const browser = await chromium.launch({ headless: true });
const failures = [], evidence = [];
for (const file of pages) for (const [w, h] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const res = await page.goto(`${base}/${file}`, { waitUntil: "load" });
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const visible = [...document.querySelectorAll("main a,main button")].filter((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; });
    const tiny = visible.filter((el) => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((el) => ({ t: (el.textContent || "").trim().slice(0, 40), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
    const clipped = [...document.querySelectorAll("main *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.right > de.clientWidth + 1 || r.left < -1); }).length;
    return { overflowX: de.scrollWidth > de.clientWidth + 1, clipped, tiny: tiny.slice(0, 10), lang: de.lang };
  });
  const row = { page: file, vp: `${w}x${h}`, http: res?.status() ?? 0, ...m };
  evidence.push(row);
  if (row.http !== 200 || m.overflowX || m.clipped || m.tiny.length || !m.lang) failures.push(row);
  await page.close();
}
await browser.close();
console.log("::notice title=SALES_VISUAL_GATE::" + JSON.stringify({ pages, viewports: VIEWPORTS.length, failures: failures.length }));
for (const f of failures) console.log("::error title=SALES_VISUAL_FAIL::" + JSON.stringify(f));
if (failures.length) process.exit(1);
