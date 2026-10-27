// Sol 232: the scroll-exception contract on the SALES build, served through the real Worker
// (scripts/audit/sales-local-server.mjs). Owner decision (written): "APROVO ROLAGEM VERTICAL NAS PÁGINAS
// PÚBLICAS" — vertical document scroll is allowed; horizontal scroll is forbidden at every width; no panel
// scrolls on its own; <main> is not an inner scroller; the bottom of the page is reachable by window scroll.
// Covers the 10 public pages, the /ia-por-ramo and /ferramentas hubs and the designed 404, at 5 viewports, in BOTH colour schemes.
// Usage: node sales-scroll-gate.mjs <baseUrl> <out.json>   (playwright from QUALITY_MODULES or ./node_modules)
//
// N-H2 (reauditoria do PR #946): o gate mede o estado ESTÁVEL da página, de forma determinística.
//   * Prova local (CI-like: Playwright 1.55, axe 4.10.3, só DejaVu/Liberation): medindo logo após "load", o resultado
//     variava entre execuções e entre os temas claro/escuro, com a mesma geometria: target-size "partially obscured"
//     (o CTA ficava coberto pela barra fixa no meio da transição de 0,2 s disparada pelo scrollTo) e, em /ia-por-ramo
//     (sem nenhum script), o evento load chegava antes das fontes web (document.fonts.status "loading" e troca de
//     fonte durante o axe). Por isso: espera document.fonts.ready e o fim das animações/transições depois de cada
//     rolagem, antes de medir. Nada é afrouxado: os critérios de aprovação são os mesmos e a sobreposição de CTA
//     passou a ser medida e a reprovar.
//   * Cada falha agora diz o motivo exato (axe com alvo e mensagem, esquema, CTA, rótulo, rolagem interna) e o
//     relatório registra navegador, versão, viewport, fontes carregadas e o tempo de estabilização; com
//     SCROLL_GATE_SHOTS=<dir> salva a captura de cada combinação reprovada (artefato do CI).
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [base, outPath = "sales-scroll-gate.json", modulesDir, browserPath, releaseShaArg] = process.argv.slice(2);
const req = createRequire(join(process.env.QUALITY_MODULES || modulesDir || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");
const AXE = req.resolve("axe-core/axe.min.js");
export const ROUTES = [
  ["/solucoes", 200], ["/zevanory-sales", 200], ["/ia-na-pratica", 200], ["/vendas-na-pratica", 200], ["/combo-ia-vendas", 200],
  ["/lucro-e-caixa", 200], ["/negocio-completo", 200], ["/conteudo-pronto", 200], ["/quem-criou", 200], ["/termos", 200],
  // Site audit S-02 (2026-10-25): the two acquisition hubs broke at >=768 px without any gate noticing.
  ["/ia-por-ramo", 200], ["/ferramentas", 200],
  ["/reembolso", 200], ["/privacidade", 200], ["/afiliados", 200], ["/material-gratuito", 200],
  // Local evidence has no checkout bindings: fail-closed 503 is the expected route response.
  ["/comprar/ZEV-IA-011", 503],
  ["/pagina-inexistente", 404],
];
const VIEWS = [
  { name: "desktop", width: 1440, height: 900 }, { name: "tablet", width: 768, height: 1024 },
  { name: "mobile390", width: 390, height: 844 }, { name: "mobile360", width: 360, height: 800 }, { name: "reflow320", width: 320, height: 640 },
];
const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
const BROWSER_VERSION = browser.version();
const SHOTS = process.env.SCROLL_GATE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// Estável = fontes prontas + dois quadros + nenhuma animação/transição em curso (teto de 3 s; o teto estourado reprova).
const settle = (page) => page.evaluate(async () => {
  const t0 = performance.now();
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  await document.fonts.ready; await frame(); await frame();
  let timedOut = false;
  for (let i = 0; i < 5; i++) {
    const running = document.getAnimations().filter((a) => a.playState === "running");
    if (!running.length) break;
    const done = await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => null))).then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    if (!done) { timedOut = true; break; }
    await frame(); await frame();
  }
  return { ms: Math.round(performance.now() - t0), timedOut, fonts: document.fonts.status };
});
const rows = [];
for (const scheme of ["light", "dark"]) for (const v of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: scheme, bypassCSP: true });
  for (const [route, expected] of ROUTES) {
    const page = await ctx.newPage();
    const res = await page.goto(base + route, { waitUntil: "load" });
    await page.addScriptTag({ path: AXE });
    const settled = [await settle(page)];
    // Sobreposição de CTA: cada CTA visível (até 12), rolado para o início, o centro e o fim da viewport; com a página
    // estável, nenhum ponto do botão pode estar coberto por outro elemento (barra fixa, cabeçalho, chat).
    const ctaOverlap = [];
    const ctaCount = await page.evaluate(() => { window.__zevCtas = [...document.querySelectorAll('main a.button, main button, main input[type=submit], header a.nav-cta')].filter((el) => el.offsetParent && el.getClientRects().length).slice(0, 12); return window.__zevCtas.length; });
    for (let i = 0; i < ctaCount; i++) for (const block of ["start", "center", "end"]) {
      await page.evaluate(([i, block]) => window.__zevCtas[i].scrollIntoView({ block, inline: "nearest", behavior: "instant" }), [i, block]);
      settled.push(await settle(page));
      const hit = await page.evaluate((i) => {
        const el = window.__zevCtas[i]; const b = el.getBoundingClientRect();
        const pts = [[b.left + b.width / 2, b.top + b.height / 2], [b.left + 3, b.top + 3], [b.right - 3, b.top + 3], [b.left + 3, b.bottom - 3], [b.right - 3, b.bottom - 3]];
        for (const [x, y] of pts) { if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue; const t = document.elementFromPoint(x, y); if (t && t !== el && !el.contains(t) && !t.contains(el)) return `${(el.textContent || el.value || "").trim().slice(0, 30)} coberto por ${t.tagName.toLowerCase()}${t.className ? "." + String(t.className).split(" ")[0] : ""}`; }
        return null;
      }, i);
      if (hit) ctaOverlap.push(`${hit} (${block})`);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    settled.push(await settle(page));
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
        ctas: [...document.querySelectorAll('main a.button, main button, header a.nav-cta')].map((el) => ({ text: el.textContent.trim(), target: el.getAttribute("href") || el.getAttribute("type") || "" })),
        invalidCtas: [...document.querySelectorAll('main a.button, main button, header a.nav-cta')].filter((el) => !el.textContent.trim() || (el.tagName === "A" && !el.getAttribute("href"))).length,
        forms: [...document.forms].map((form) => ({ method: (form.method || "get").toLowerCase(), action: form.getAttribute("action") || "", fields: [...form.querySelectorAll("input,select,textarea")].length })),
        unlabeledFields: [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((el) => !el.labels?.length && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")).length,
      };
    });
    // O scrollTo do fim da página (dentro da medição acima) dispara as barras fixas; o axe só roda com tudo parado.
    settled.push(await settle(page));
    const env = await page.evaluate(() => ({ fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family).filter((f, i, a) => a.indexOf(f) === i), fontsStatus: document.fonts.status, viewport: [innerWidth, innerHeight, devicePixelRatio] }));
    const axe = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " :: " + String(n.any[0]?.message || n.failureSummary || "").slice(0, 160)) })));
    const axeSerious = axe.filter((v) => v.impact === "serious" || v.impact === "critical");
    const settleTimedOut = settled.some((x) => x.timedOut);
    const row = { scheme, view: v.name, route, http: res?.status() || 0, expected_http: expected, ...m,
      axe, axeSeriousCritical: axeSerious.length, ctaOverlap, settle_ms: settled.reduce((n, x) => n + x.ms, 0), settleTimedOut, ...env,
      documentScroll: m.htmlOverflowY !== "hidden" && m.bodyOverflowY !== "hidden" && !m.mainInnerScroller && m.scrollingPanels.length === 0,
      horizontalOverflow: m.sw > m.iw + 1 };
    row.schemeOk = m.darkMatches === (scheme === "dark");
    delete row.darkMatches;
    row.pass = row.http === expected && row.documentScroll && row.bottomReachable && !row.horizontalOverflow && row.schemeOk && !m.mainOverflow && m.clippedHeadings.length === 0 && m.invalidCtas === 0 && m.unlabeledFields === 0 && axeSerious.length === 0 && ctaOverlap.length === 0 && !settleTimedOut && env.fontsStatus === "loaded";
    rows.push(row);
    if (!row.pass) {
      const why = { http: `${row.http}/${expected}`, documentScroll: row.documentScroll, htmlOverflowY: m.htmlOverflowY, bodyOverflowY: m.bodyOverflowY, mainInnerScroller: m.mainInnerScroller,
        panels: m.scrollingPanels, bottom: m.bottomReachable, hscroll: `${m.sw}/${m.iw}`, mainOverflow: m.mainOverflow, clipped: m.clippedHeadings, schemeOk: row.schemeOk,
        invalidCtas: m.invalidCtas, unlabeled: m.unlabeledFields, axeSerious: axeSerious.map((a) => `${a.id}(${a.impact},${a.nodes}): ${a.targets.join(" | ")}`), ctaOverlap, settleTimedOut, fonts: env.fontsStatus, viewport: env.viewport };
      console.log(`::error title=SALES_SCROLL_GATE::${scheme} ${v.name} ${route} ${JSON.stringify(why).replace(/[\r\n]+/g, " ").slice(0, 1800)}`);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${scheme}-${v.name}${route.replace(/\//g, "_")}.png`, fullPage: true }).catch(() => null);
    }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
const releaseSha = releaseShaArg || process.env.RELEASE_SHA || null;
if (releaseSha && !/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error("release_sha must be a full Git SHA");
function pkgVersion(name) { try { return req(name + "/package.json").version; } catch { return null; } }
const environment = { browser: "chromium", browser_version: BROWSER_VERSION, playwright: pkgVersion("playwright"), axe_core: pkgVersion("axe-core"),
  node: process.version, platform: `${process.platform}-${process.arch}`, ci: Boolean(process.env.CI), runner: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion || ""}`.trim() : null };
const result = { schema: "zevanory.sales-scroll-gate.v2", release_sha: releaseSha, base, environment, routes: ROUTES.length, views: VIEWS.length, schemes: 2, checked: rows.length,
  cta_overlap_checked: true, cta_overlaps: rows.reduce((n, r) => n + r.ctaOverlap.length, 0), pass: rows.every((r) => r.pass), rows };
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(`SALES_SCROLL_GATE=${result.pass ? "PASS" : "FAIL"} checked=${rows.length} (routes=${ROUTES.length} x views=${VIEWS.length} x schemes=2)`);
if (!result.pass) process.exitCode = 1;
