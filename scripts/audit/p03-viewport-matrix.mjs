// P03 (Ordem 013 quadro F2 + Roteiro §6) — regra estrita, decisão do proprietário 22/10/2026 09:06
// ("páginas jurídicas por paginação"): NENHUMA barra de rolagem, global ou interna, em NENHUMA página
// pública de vendas (inclusive termos, privacidade, reembolso e afiliados). Sem lista de exceções.
//
// Matriz: cada sales-public/*.html x 5 viewports x 2 esquemas de cor = páginas*10 células.
// Por célula, percorrendo TODOS os blocos com PageDown (teclado real do Playwright):
//   - HTTP 200; paginação montada (main[data-pg-total]);
//   - 0 rolagem de documento (H e V), 0 contêiner de rolagem (overflow auto/scroll/overlay em qualquer
//     elemento: sem contêiner não há barra possível), 0 deslocamento de rolagem (scrollTop/Left = 0);
//   - 0 conteúdo recortado: horizontal (como antes) e vertical (linha de texto ou elemento
//     substituído parcialmente visível, medido por hit-test em 2 pontos de cada linha);
//   - 0 violação axe-core WCAG 2.x A/AA em CADA bloco;
//   - teclado: PageDown avança exatamente 1 bloco, foco vai para dentro do bloco e é visível,
//     anúncio aria-live "Bloco X de N"; no fim PageDown não passa de N; PageUp/ArrowRight/
//     ArrowLeft/Home/End e o botão "Próxima" (Enter) funcionam;
//   - alcance: TODO texto do <main> (cada linha de cada nó de texto renderizado) e todo elemento
//     substituído fica inteiramente visível em pelo menos um bloco; e o multiconjunto de textos do
//     <main> paginado é IGUAL ao da mesma página carregada sem paginacao.js (nada cortado/duplicado).
//   - o mesmo alcance/recorte com todos os <details> abertos (FAQ etc.), reflow incluído;
//   - células dark emulam prefers-reduced-motion: reduce e exigem 0 animação > 1 ms na troca de bloco
//     (product.css já reduz transições a 0,01 ms nesse modo).
// Por página (uma vez): link profundo #bloco-N, âncoras internas (#id) abrem o bloco do alvo,
// impressão mostra tudo sem paginação, e sem JavaScript o conteúdo segue legível e rolável.
// Uso: node p03-viewport-matrix.mjs <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "noop.js"));
const { chromium } = require("playwright");
const axeSrc = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const VIEWPORTS = [[1536, 730], [1280, 720], [1366, 768], [1024, 768], [390, 844]];
export const THEMES = ["light", "dark"];
const WORKERS = Math.max(1, Number(process.env.P03_WORKERS || 4));
const PAGE_CHECK_CELL = "390x844|light"; // célula onde rodam as checagens por página

const [base, dir, expectedArg, out = "p03-viewport-matrix"] = process.argv.slice(2);
if (!base || !dir || !expectedArg) { console.error("usage: <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]"); process.exit(2); }
const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
const expected = Number(expectedArg);

// ---------- medições no navegador (serializadas por page.evaluate) ----------
function measureLayout() {
  const de = document.documentElement;
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "");
  const scrollers = [], internal = [], offsets = [];
  for (const el of [de, ...document.querySelectorAll("body, body *")]) {
    if (el.scrollTop || el.scrollLeft) offsets.push({ el: sel(el), top: el.scrollTop, left: el.scrollLeft });
    if (el === de) continue;
    const s = getComputedStyle(el);
    const sy = /(auto|scroll|overlay)/.test(s.overflowY), sx = /(auto|scroll|overlay)/.test(s.overflowX);
    if (!sy && !sx) continue;
    scrollers.push(sel(el));
    const v = el.scrollHeight > el.clientHeight + 1, h = el.scrollWidth > el.clientWidth + 1;
    if ((sy && v) || (sx && h)) internal.push({ el: sel(el), v: sy && v, h: sx && h });
  }
  const sv = document.scrollingElement;
  if (sv && (sv.scrollTop || sv.scrollLeft || window.scrollY || window.scrollX)) offsets.push({ el: "viewport", top: window.scrollY, left: window.scrollX });
  // Recorte horizontal (sem barra, mas inalcançável). Itens estacionados à esquerda (skip link,
  // honeypot) são padrão intencional de ocultação.
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0) continue;
    if (r.right > de.clientWidth + 1 || r.left < -1) clipped.push(sel(el));
  }
  return { docH: de.scrollWidth > de.clientWidth + 1, docV: de.scrollHeight > de.clientHeight + 1, scrollers, internal, offsets, clipped: clipped.slice(0, 5), clippedCount: clipped.length };
}

// Estado de cada linha de texto / elemento substituído do <main> (fora da UI de paginação):
// "v" inteiramente visível, "h" oculto, "p" parcialmente visível (recortado). Hit-test em 2 pontos.
function measureLines(withTexts) {
  const main = document.querySelector("main");
  if (!main) return { none: true };
  const ui = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return !!(e && e.closest("[data-pg-ui]")); };
  const visCss = (e) => e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) : getComputedStyle(e).visibility !== "hidden";
  // Ponto "visível": o hit-test cai no próprio dono (ou dentro dele). Ponto "recortado": cai em nada
  // ou num ANCESTRAL do dono (o texto não foi pintado ali: clip/overflow). Cair em outro elemento do
  // conteúdo (irmão sobreposto pelo próprio design) é neutro. Parcial = visível + recortado.
  const probe = (r, owner) => {
    const x = Math.min(Math.max(r.left + r.width / 2, r.left + 0.5), r.right - 0.5);
    let vis = 0, cut = 0;
    for (const f of [0.25, 0.75]) {
      const hit = document.elementFromPoint(x, r.top + r.height * f);
      if (hit && (hit === owner || owner.contains(hit))) vis++;
      else if (!hit || hit.contains(owner) || !main.contains(hit)) cut++;
    }
    return vis && !cut ? "v" : vis ? "p" : "h";
  };
  const keys = [], states = [], texts = [], partial = [];
  const rg = document.createRange();
  const tw = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  let ni = 0;
  for (let n; (n = tw.nextNode());) {
    const t = n.textContent.replace(/\s+/g, " ").trim();
    if (!t || ui(n)) continue;
    // Conteúdo de <details> fechado não é exibido (nem sem paginação): coberto na passada com tudo aberto.
    const fechado = n.parentElement.closest("details:not([open])");
    if (fechado && !n.parentElement.closest("summary")) continue;
    rg.selectNodeContents(n);
    const rects = [...rg.getClientRects()].filter((r) => r.width > 0 && r.height > 0 && r.right > 0);
    if (!rects.length) continue;
    const idx = ni++;
    if (withTexts) texts.push(t);
    const p = n.parentElement, vis = visCss(p);
    rects.forEach((r, li) => {
      const st = vis ? probe(r, p) : "h";
      keys.push("t" + idx + ":" + li); states.push(st);
      if (st === "p") partial.push(t.slice(0, 40));
    });
  }
  let ei = 0;
  for (const el of main.querySelectorAll("img,svg,input,button,select,textarea,video,iframe")) {
    if (ui(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.right > 0)) continue;
    const idx = ei++;
    const st = visCss(el) ? probe(r, el) : "h";
    keys.push("e" + idx); states.push(st);
    if (st === "p") partial.push("<" + el.tagName.toLowerCase() + ">");
  }
  const pg = main.dataset.pgTotal ? { atual: Number(main.dataset.pgAtual), total: Number(main.dataset.pgTotal) } : null;
  return { keys, states, texts, partial: partial.slice(0, 5), partialCount: partial.length, pg };
}

function focusState() {
  const main = document.querySelector("main");
  const a = document.activeElement;
  const st = document.querySelector("main [role=status]");
  let visible = false;
  if (a && main && main.contains(a)) {
    const r = a.getBoundingClientRect();
    const hit = r.width && r.height ? document.elementFromPoint(r.left + Math.min(8, r.width / 2), r.top + Math.min(8, r.height / 2)) : null;
    visible = !!hit && (hit === a || a.contains(hit));
  }
  return { inMain: !!(a && main && main.contains(a)), tag: a ? a.tagName : "", heading: !!(a && /^H[1-6]$/.test(a.tagName)), visible,
    status: st ? st.textContent : "", atual: main ? Number(main.dataset.pgAtual) : 0, total: main ? Number(main.dataset.pgTotal) : 0 };
}

async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Só animações finitas (a página pode ter animação infinita decorativa); teto de 2 s.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, 2000)),
  ]));
}
async function axeRun(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axeSrc });
  return page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }))
    .violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, target: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })));
}
function multiset(arr) { const m = new Map(); for (const t of arr) m.set(t, (m.get(t) || 0) + 1); return m; }
function msDiff(a, b) {
  const A = multiset(a), B = multiset(b), miss = [], extra = [];
  for (const [t, c] of A) if ((B.get(t) || 0) < c) miss.push(t.slice(0, 50));
  for (const [t, c] of B) if ((A.get(t) || 0) < c) extra.push(t.slice(0, 50));
  return { miss, extra };
}
const openAllDetails = (page) => page.evaluate(() => { let n = 0; for (const d of document.querySelectorAll("main details")) { if (d.closest("[data-pg-ui]")) continue; if (!d.open) { d.open = true; n++; } } return n; });

// Percorre todos os blocos com PageDown. Retorna problemas e cobertura.
async function walkBlocks(page, { axe, problems, tag, reduce = false }) {
  const st0 = await page.evaluate(measureLines, true);
  if (st0.none || !st0.pg) { problems.push(tag + "no_pagination"); return { st0, n: 0, steps: 0 }; }
  const N = st0.pg.total;
  if (st0.pg.atual !== 1) problems.push(`${tag}start_block_${st0.pg.atual}`);
  const seen = new Map(st0.keys.map((k) => [k, false]));
  let steps = 0, axeViolations = [], partialAll = 0, partialEx = [];
  for (let k = 1; k <= N; k++) {
    const st = k === 1 ? st0 : await page.evaluate(measureLines, false);
    if (st.keys.length !== st0.keys.length) problems.push(`${tag}layout_changed_b${k}`);
    st.keys.forEach((key, i) => { if (st.states[i] === "v") seen.set(key, true); });
    if (st.partialCount) { partialAll += st.partialCount; partialEx.push(...st.partial.map((p) => `b${k}:${p}`)); }
    const m = await page.evaluate(measureLayout);
    if (m.docH) problems.push(`${tag}doc_scroll_h_b${k}`);
    if (m.docV) problems.push(`${tag}doc_scroll_v_b${k}`);
    if (m.scrollers.length) problems.push(`${tag}scroll_container_b${k}:${m.scrollers.slice(0, 3).join("+")}`);
    if (m.internal.length) problems.push(`${tag}internal_scroll_b${k}:${m.internal.map((i) => i.el).slice(0, 3).join("+")}`);
    if (m.offsets.length) problems.push(`${tag}scroll_offset_b${k}:${m.offsets.map((o) => o.el).slice(0, 3).join("+")}`);
    if (m.clippedCount) problems.push(`${tag}clipped_x_b${k}:${m.clippedCount}:${m.clipped.slice(0, 3).join("+")}`);
    if (axe) for (const v of await axeRun(page)) axeViolations.push(`b${k}:${v.id}(${v.impact})`);
    if (k < N) {
      await page.keyboard.press("PageDown");
      if (reduce && (await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.("main") && a.effect.getComputedTiming().endTime > 1).length))) problems.push(`${tag}motion_with_reduced_motion_b${k + 1}`);
      await settle(page);
      const f = await page.evaluate(focusState);
      steps++;
      if (f.atual !== k + 1) problems.push(`${tag}kbd_pagedown_b${k}->${f.atual}`);
      if (!f.inMain || !f.visible) problems.push(`${tag}kbd_focus_b${k + 1}:${f.tag}:${f.inMain}:${f.visible}`);
      if (!f.status.startsWith(`Bloco ${k + 1} de ${N}`)) problems.push(`${tag}kbd_live_b${k + 1}`);
    }
  }
  if (partialAll) problems.push(`${tag}clipped_y:${partialAll}:${partialEx.slice(0, 3).join("|")}`);
  const unreached = [...seen].filter(([, v]) => !v).map(([k]) => k);
  if (unreached.length) problems.push(`${tag}unreachable:${unreached.length}/${seen.size}`);
  for (const v of axeViolations) problems.push(`${tag}axe:${v}`);
  return { st0, n: N, steps, lines: seen.size, unreached: unreached.length };
}

async function keyboardExtras(page, N, problems) {
  const at = () => page.evaluate(() => Number(document.querySelector("main").dataset.pgAtual));
  const press = async (key) => { await page.keyboard.press(key); await settle(page); return at(); };
  if ((await press("PageDown")) !== N) problems.push("kbd_pagedown_past_end");
  if (N > 1) {
    if ((await press("PageUp")) !== N - 1) problems.push("kbd_pageup");
    if ((await press("ArrowRight")) !== N) problems.push("kbd_arrowright");
    if ((await press("ArrowLeft")) !== N - 1) problems.push("kbd_arrowleft");
    if ((await press("Home")) !== 1) problems.push("kbd_home");
    if ((await press("End")) !== N) problems.push("kbd_end");
    await press("Home");
    const ok = await page.evaluate(() => { const b = document.querySelector("main .pg-prox, main [data-pg-ui] button:last-of-type"); if (!b) return false; b.focus(); return document.activeElement === b; });
    if (!ok) problems.push("kbd_button_not_focusable");
    else if ((await press("Enter")) !== 2) problems.push("kbd_button_enter");
  } else {
    await press("Home");
  }
}

async function pageChecks(browser, file, w, h, theme, N) {
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  const page = await ctx.newPage();
  // 1) link profundo para o último bloco
  await page.goto(`${base}/${file}#bloco-${N}`, { waitUntil: "load" });
  await page.waitForSelector("main[data-pg-pronto]", { timeout: 5000 }).catch(() => {});
  await settle(page);
  const dl = await page.evaluate(() => Number(document.querySelector("main")?.dataset.pgAtual));
  if (dl !== N) problems.push(`deeplink_bloco_${N}->${dl}`);
  // 2) âncoras internas: abre o bloco que contém o alvo, alvo visível
  await page.goto(`${base}/${file}`, { waitUntil: "load" });
  await page.waitForSelector("main[data-pg-pronto]", { timeout: 5000 }).catch(() => {});
  const anchors = await page.evaluate(() => [...document.querySelectorAll("main a[href^='#']")].filter((a) => !a.closest("[data-pg-ui]")).map((a) => a.getAttribute("href")).filter((h) => h.length > 1 && document.getElementById(decodeURIComponent(h.slice(1))) && document.querySelector("main").contains(document.getElementById(decodeURIComponent(h.slice(1))))));
  for (const [ai, href] of anchors.entries()) {
    await page.keyboard.press("Home"); await settle(page);
    let found = false;
    for (let k = 0; k < N && !found; k++) {
      found = await page.evaluate((i) => { const a = [...document.querySelectorAll("main a[href^='#']")].filter((x) => !x.closest("[data-pg-ui]") && x.getAttribute("href").length > 1)[i]; return !!a && a.checkVisibility({ visibilityProperty: true }); }, ai);
      if (!found) { await page.keyboard.press("PageDown"); await settle(page); }
    }
    if (!found) { problems.push(`anchor_link_unreachable:${href}`); continue; }
    await page.evaluate((i) => [...document.querySelectorAll("main a[href^='#']")].filter((x) => !x.closest("[data-pg-ui]") && x.getAttribute("href").length > 1)[i].click(), ai);
    await settle(page);
    // Alvo exibido = a primeira linha de texto dentro dele está inteiramente visível, e o foco foi
    // para o alvo (ou para dentro dele).
    const ok = await page.evaluate((id) => {
      const t = document.getElementById(id);
      const tw = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); const rg = document.createRange();
      let owner = t, r = t.getBoundingClientRect();
      for (let n; (n = tw.nextNode());) { if (!n.textContent.trim()) continue; rg.selectNodeContents(n); const rs = [...rg.getClientRects()].filter((x) => x.width && x.height); if (rs.length) { owner = n.parentElement; r = rs[0]; break; } }
      const x = r.left + r.width / 2;
      const pts = [0.25, 0.75].map((f) => document.elementFromPoint(x, r.top + r.height * f));
      return owner.checkVisibility({ visibilityProperty: true }) && pts.every((hit) => hit && (hit === owner || owner.contains(hit))) && t.contains(document.activeElement);
    }, decodeURIComponent(href.slice(1)));
    if (!ok) problems.push(`anchor_target_not_shown:${href}`);
  }
  // 3) impressão: todo o conteúdo visível, sem paginação
  await page.emulateMedia({ media: "print" });
  await settle(page);
  const pr = await page.evaluate(() => {
    const main = document.querySelector("main"); let hidden = 0, total = 0;
    const tw = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (!n.textContent.trim() || n.parentElement.closest("[data-pg-ui]")) continue;
      const fechado = n.parentElement.closest("details:not([open])");
      if (fechado && !n.parentElement.closest("summary")) continue;
      if (!n.parentElement.getClientRects().length) continue;
      total++;
      if (!n.parentElement.checkVisibility({ visibilityProperty: true })) hidden++;
    }
    const ov = [document.documentElement, document.body, main].map((e) => getComputedStyle(e).overflowY);
    const tr = [...main.querySelectorAll("*")].some((e) => { const s = getComputedStyle(e); return s.transform !== "none" && e.children.length > 3 || (s.clipPath && s.clipPath !== "none"); });
    return { hidden, total, ov, tr };
  });
  if (pr.hidden || pr.ov.some((o) => o !== "visible") || pr.tr) problems.push(`print_not_full:${JSON.stringify(pr)}`);
  await ctx.close();
  // 4) sem JavaScript: conteúdo inteiro presente e rolável (fallback documentado)
  const nctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, javaScriptEnabled: false });
  const np = await nctx.newPage();
  await np.goto(`${base}/${file}`, { waitUntil: "load" });
  const js = await np.evaluate(() => {
    const de = document.documentElement, main = document.querySelector("main");
    const docScroll = de.scrollHeight > de.clientHeight + 1 && getComputedStyle(de).overflowY !== "hidden";
    const ms = main && getComputedStyle(main).overflowY;
    const mainFits = main && main.scrollHeight <= main.clientHeight + 1;
    return { pg: de.classList.contains("pg"), text: main ? main.textContent.trim().length : 0, reachable: !!main && (mainFits && !docScroll ? de.scrollHeight <= de.clientHeight + 1 : docScroll || /(auto|scroll)/.test(ms)) };
  });
  if (js.pg || !js.text || !js.reachable) problems.push(`nojs_fallback:${JSON.stringify(js)}`);
  await nctx.close();
  return { problems, anchors: anchors.length };
}

// ---------- autoteste do detector ----------
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.setContent('<main><div style="width:2000px;height:10px"></div><div id="box" style="height:50px;overflow:auto"><div style="height:500px"></div></div><div style="height:100px;overflow:clip"><p style="margin:0;line-height:40px;font-size:28px">aaa<br>bbb<br>ccc</p></div></main>');
  const m = await p.evaluate(measureLayout);
  const l = await p.evaluate(measureLines, true);
  await ctx.close();
  if (!m.docH || !m.clippedCount || !m.internal.some((i) => i.el === "div#box" && i.v) || !m.scrollers.length || l.partialCount !== 1 || l.states.filter((s) => s === "v").length !== 2) {
    console.log("::error title=P03_SELFTEST::detector did not flag synthetic overflow/clipping " + JSON.stringify({ m, l: { states: l.states, partial: l.partial } })); process.exit(1);
  }
  console.log("P03_SELFTEST=PASS");
}

const tasks = [];
for (const file of pages) for (const [w, h] of VIEWPORTS) tasks.push({ file, w, h });
const rows = [], pageRows = [];
async function runTask({ file, w, h }) {
  // Referência: mesma página e viewport SEM paginacao.js (os demais scripts rodam normalmente).
  const rctx = await browser.newContext({ viewport: { width: w, height: h } });
  await rctx.route("**/paginacao.js", (r) => r.abort());
  const rp = await rctx.newPage();
  await rp.goto(`${base}/${file}`, { waitUntil: "load" });
  const refClosed = (await rp.evaluate(measureLines, true)).texts || [];
  const nDetails = await openAllDetails(rp);
  await settle(rp);
  const refOpen = (await rp.evaluate(measureLines, true)).texts || [];
  await rctx.close();
  for (const theme of THEMES) {
    const problems = [];
    // Células "dark" também emulam prefers-reduced-motion: reduce (e exigem 0 animação); "light"
    // usam no-preference (a transição curta de opacidade roda e é aguardada antes de medir).
    const reduce = theme === "dark";
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: reduce ? "reduce" : "no-preference" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(`${base}/${file}`, { waitUntil: "load" });
    const http = res?.status() ?? 0;
    if (http !== 200) problems.push("http_" + http);
    await page.waitForSelector("main[data-pg-pronto]", { timeout: 5000 }).catch(() => {});
    await settle(page);
    const a = await walkBlocks(page, { axe: true, problems, tag: "", reduce });
    if (a.st0.texts) { const d = msDiff(refClosed, a.st0.texts); if (d.miss.length || d.extra.length) problems.push(`text_mismatch:miss=${d.miss.length}:extra=${d.extra.length}:${[...d.miss, ...d.extra].slice(0, 2).join("|")}`); }
    if (a.n) await keyboardExtras(page, a.n, problems);
    let b = { n: 0, steps: 0, lines: 0 };
    if (nDetails) {
      await openAllDetails(page);
      await page.waitForTimeout(50);
      await settle(page);
      await page.keyboard.press("Home");
      await settle(page);
      b = await walkBlocks(page, { axe: false, problems, tag: "open:" });
      if (b.st0.texts) { const d = msDiff(refOpen, b.st0.texts); if (d.miss.length || d.extra.length) problems.push(`open:text_mismatch:miss=${d.miss.length}:extra=${d.extra.length}`); }
    }
    for (const e of errors) problems.push("pageerror:" + e.slice(0, 80));
    await ctx.close();
    let pc = null;
    if (`${w}x${h}|${theme}` === PAGE_CHECK_CELL) {
      pc = await pageChecks(browser, file, w, h, theme, a.n || 1);
      pageRows.push({ page: file, cell: PAGE_CHECK_CELL, ...pc });
    }
    rows.push({ page: file, viewport: `${w}x${h}`, theme, http, blocks: a.n, kbd_steps: a.steps, lines: a.lines || 0, unreached: a.unreached ?? null,
      details_opened: nDetails, blocks_open: b.n, kbd_steps_open: b.steps, problems });
  }
}
let next = 0;
// Fail-closed: erro inesperado numa tarefa vira problema nas 2 células dela (nunca some da contagem).
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < tasks.length) {
    const t = tasks[next++];
    if (process.env.P03_TRACE) console.error("TASK_START", t.file, t.w + "x" + t.h, new Date().toISOString());
    let timer;
    try {
      await Promise.race([runTask(t), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("task_timeout_300s")), 300000); })]);
    } catch (e) {
      for (const theme of THEMES) if (!rows.some((r) => r.page === t.file && r.viewport === `${t.w}x${t.h}` && r.theme === theme))
        rows.push({ page: t.file, viewport: `${t.w}x${t.h}`, theme, http: 0, blocks: 0, kbd_steps: 0, lines: 0, unreached: null, details_opened: 0, blocks_open: 0, kbd_steps_open: 0, problems: ["error:" + String(e.message || e).split("\n")[0].slice(0, 120)] });
    } finally { clearTimeout(timer); }
    if (process.env.P03_TRACE) console.error("TASK_END", t.file, t.w + "x" + t.h, new Date().toISOString());
  }
}));
await browser.close();
rows.sort((x, y) => (x.page + x.viewport + x.theme).localeCompare(y.page + y.viewport + y.theme));
pageRows.sort((x, y) => x.page.localeCompare(y.page));

const failures = rows.filter((r) => r.problems.length);
const pageFailures = pageRows.filter((r) => r.problems.length);
const summary = { schema: "zevanory.p03.viewport-matrix.v2", rule: "strict-no-scroll-paginated", pages: pages.length, expected_pages: expected,
  viewports: VIEWPORTS.map((v) => v.join("x")), themes: THEMES, cells: rows.length, cells_pass: rows.length - failures.length, failures: failures.length,
  known_gaps: 0, blocks_checked: rows.reduce((s, r) => s + r.blocks + r.blocks_open, 0), kbd_pagedown_steps: rows.reduce((s, r) => s + r.kbd_steps + r.kbd_steps_open, 0),
  lines_checked: rows.reduce((s, r) => s + r.lines, 0), page_checks: pageRows.length, page_checks_pass: pageRows.length - pageFailures.length,
  anchors_checked: pageRows.reduce((s, r) => s + r.anchors, 0) };
fs.writeFileSync(out + ".json", JSON.stringify({ ...summary, rows, page_rows: pageRows }, null, 1));
fs.writeFileSync(out + ".csv", ["page,viewport,theme,http,blocks,kbd_steps,lines,blocks_details_open,problems",
  ...rows.map((r) => [r.page, r.viewport, r.theme, r.http, r.blocks, r.kbd_steps, r.lines, r.blocks_open, `"${r.problems.join(" ").replace(/"/g, "'")}"`].join(","))].join("\n"));
console.log("::notice title=P03_VIEWPORT_MATRIX::" + JSON.stringify(summary));
let bad = false;
if (pages.length !== expected) { console.log(`::error title=P03_PAGE_COUNT::expected ${expected} pages, found ${pages.length}`); bad = true; }
if (rows.length !== expected * VIEWPORTS.length * THEMES.length) { console.log("::error title=P03_CELL_COUNT::" + rows.length); bad = true; }
if (pageRows.length !== expected) { console.log("::error title=P03_PAGE_CHECK_COUNT::" + pageRows.length); bad = true; }
for (const f of failures.slice(0, 40)) console.log("::error title=P03_CELL_FAIL::" + JSON.stringify({ page: f.page, viewport: f.viewport, theme: f.theme, problems: f.problems.slice(0, 8) }));
for (const f of pageFailures.slice(0, 20)) console.log("::error title=P03_PAGE_FAIL::" + JSON.stringify(f));
if (failures.length || pageFailures.length) bad = true;
console.log(bad ? "P03_VIEWPORT_MATRIX=FAIL" : "P03_VIEWPORT_MATRIX=PASS");
if (bad) process.exit(1);
