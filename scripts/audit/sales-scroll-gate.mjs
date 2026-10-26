// Sol 232: the scroll-exception contract on the SALES build, served through the real Worker
// (scripts/audit/sales-local-server.mjs). Owner decision (written): "APROVO ROLAGEM VERTICAL NAS PÁGINAS
// PÚBLICAS" — vertical document scroll is allowed; horizontal scroll is forbidden at every width; no panel
// scrolls on its own; <main> is not an inner scroller; the bottom of the page is reachable by window scroll.
// Covers the 10 public pages, the /ia-por-ramo and /ferramentas hubs and the designed 404, at 5 viewports, in BOTH colour schemes.
// Usage: node sales-scroll-gate.mjs <baseUrl> <out.json>   (playwright from QUALITY_MODULES or ./node_modules)
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [base, outPath = "sales-scroll-gate.json"] = process.argv.slice(2);
const req = createRequire(join(process.env.QUALITY_MODULES || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");
export const ROUTES = [
  ["/solucoes", 200], ["/zevanory-sales", 200], ["/ia-na-pratica", 200], ["/vendas-na-pratica", 200], ["/combo-ia-vendas", 200],
  ["/lucro-e-caixa", 200], ["/negocio-completo", 200], ["/conteudo-pronto", 200], ["/quem-criou", 200], ["/termos", 200],
  // Site audit S-02 (2026-10-25): the two acquisition hubs broke at >=768 px without any gate noticing.
  ["/ia-por-ramo", 200], ["/ferramentas", 200],
  ["/pagina-inexistente", 404],
];
const VIEWS = [
  { name: "desktop", width: 1440, height: 900 }, { name: "laptop", width: 1366, height: 768 },
  { name: "tablet", width: 768, height: 1024 }, { name: "mobile", width: 390, height: 844 }, { name: "reflow320", width: 320, height: 640 },
];
const browser = await chromium.launch({ headless: true });
const rows = [];
for (const scheme of ["light", "dark"]) for (const v of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: scheme });
  for (const [route, expected] of ROUTES) {
    const page = await ctx.newPage();
    const res = await page.goto(base + route, { waitUntil: "load" });
    const m = await page.evaluate(() => {
      const root = document.documentElement, main = document.querySelector("main"), ms = main ? getComputedStyle(main) : null;
      window.scrollTo({ top: root.scrollHeight, behavior: "instant" });
      const scrollingPanels = [...document.querySelectorAll("body *")].filter((el) => { const s = getComputedStyle(el); return (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1); }).map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""));
      return {
        sw: root.scrollWidth, iw: window.innerWidth, sh: root.scrollHeight, ih: window.innerHeight,
        htmlOverflowY: getComputedStyle(root).overflowY, bodyOverflowY: getComputedStyle(document.body).overflowY,
        mainInnerScroller: !!main && /(auto|scroll|hidden)/.test(ms.overflowY) && main.scrollHeight > main.clientHeight + 1,
        scrollingPanels, bottomReachable: window.scrollY + window.innerHeight >= root.scrollHeight - 2,
        darkMatches: matchMedia("(prefers-color-scheme: dark)").matches,
        // S-02: nothing inside <main> runs past the viewport (the hubs' main was 1057 px wide at 1024 px, clipped
        // because the page itself does not scroll sideways) and no heading is cut by its own box. Full-bleed bars
        // (the legal nav) may exceed main's padding box but never the viewport.
        mainOverflow: !!main && main.scrollWidth > innerWidth + 1,
        clippedHeadings: [...document.querySelectorAll("main h1, main h2, main h3")].filter((h) => h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().right > innerWidth + 1).map((h) => h.textContent.trim().slice(0, 40)),
      };
    });
    const row = { scheme, view: v.name, route, http: res?.status() || 0, expected_http: expected, ...m,
      documentScroll: m.htmlOverflowY !== "hidden" && m.bodyOverflowY !== "hidden" && !m.mainInnerScroller && m.scrollingPanels.length === 0,
      horizontalOverflow: m.sw > m.iw + 1 };
    row.schemeOk = m.darkMatches === (scheme === "dark");
    delete row.darkMatches;
    row.pass = row.http === expected && row.documentScroll && row.bottomReachable && !row.horizontalOverflow && row.schemeOk && !m.mainOverflow && m.clippedHeadings.length === 0;
    rows.push(row);
    if (!row.pass) console.log(`::error title=SALES_SCROLL_GATE::${scheme} ${v.name} ${route} http=${row.http} sw=${m.sw}/${m.iw} panels=${m.scrollingPanels.join(",")} bottom=${m.bottomReachable} mainOverflow=${m.mainOverflow} clipped=${m.clippedHeadings.join("|")}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
const result = { schema: "zevanory.sales-scroll-gate.v1", base, routes: ROUTES.length, views: VIEWS.length, schemes: 2, checked: rows.length, pass: rows.every((r) => r.pass), rows };
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(`SALES_SCROLL_GATE=${result.pass ? "PASS" : "FAIL"} checked=${rows.length} (routes=${ROUTES.length} x views=${VIEWS.length} x schemes=2)`);
if (!result.pass) process.exitCode = 1;
