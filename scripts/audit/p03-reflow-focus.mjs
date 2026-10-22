// P03 — testes pedidos pela auditoria adversarial (Sol) que bloqueou a certificação, agora EXECUTADOS e
// parte do gate (job "p03 / reflow-focus" do zevanory-p03-viewport-matrix.yml, pull_request).
//
// Suítes (todas falham o processo com código 1 se houver qualquer problema):
//  reflow  (WCAG 1.4.10) — TODAS as páginas x 320x568, 320x256 (equivalente a paisagem com zoom),
//          640x400 com deviceScaleFactor 2 (= janela 1280x800 a 200%), 256x568 e 240x568 (além do
//          mínimo do critério). Em cada bloco (avançando pelo CLIQUE real em "Próxima"): 0 rolagem de
//          documento (H/V), 0 contêiner de rolagem, 0 deslocamento de rolagem, 0 elemento recortado na
//          horizontal; controles Anterior/Bloco X de N/Próxima inteiros na tela, >= 44x44 e no topo do
//          hit-test; índice aberto: todos os itens (links e botões de janela) inteiros, >= 44x44 e no
//          topo do hit-test, e o índice alcança TODOS os blocos (percorrendo as janelas) e o clique num
//          link abre o bloco; alcance: toda linha de texto do <body> (cabeçalho, conteúdo e rodapé) e
//          todo elemento substituído fica inteiramente visível em algum bloco, 0 linha parcialmente
//          recortada, e o texto do <body> paginado é igual ao da página sem paginacao.js.
//  focus   (2.4.3, 2.4.7, 2.4.11) — página jurídica, calculadora e página de venda x 1280x720,
//          390x844 e 320x568: Tab real percorre o ciclo inteiro; cada foco tem indicador visível
//          (outline > 0 ou box-shadow), está inteiro na tela e não está encoberto (hit-test em 5
//          pontos); a ordem segue a ordem do DOM (1 única volta ao início no ciclo) e nunca cai em
//          elemento de outro bloco; os controles fazem parte do ciclo. Troca de bloco por Enter em
//          "Próxima": foco no título do bloco (visível, não encoberto), região role=status com
//          aria-live=polite muda de texto para "Bloco X de N..."; Tab seguinte vai para o novo bloco e
//          Shift+Tab volta na ordem do DOM.
//  hash    — TODAS as páginas x 390x844 e 320x568: carga com #bloco-N (meio e último) e com #id de
//          elementos na segunda metade do conteúdo: bloco certo exibido, alvo inteiro na tela, 0 rolagem.
//  details — páginas com <details> no conteúdo x 1280x720, 390x844, 320x568: abrir pelo teclado no
//          meio do bloco mantém o <summary> focado e inteiro na tela, sem rolagem, e o conteúdo aberto é
//          alcançável nos blocos seguintes.
//  aria    — PROXY de leitor de tela (NVDA/VoiceOver reais NÃO rodam no CI em nuvem): snapshot da árvore
//          de acessibilidade do Chromium (Playwright ariaSnapshot) — landmarks banner/main/contentinfo e
//          navigation "Blocos de conteúdo" presentes em qualquer modo, botões com nome, status presente,
//          texto de bloco oculto ausente da árvore e presente após "Próxima".
// Uso: node p03-reflow-focus.mjs <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]
// Ambiente: P03RF_SUITES=reflow,focus,hash,details,aria (padrão: todas), P03_WORKERS, CHROME_PATH.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "noop.js"));
const { chromium } = require("playwright");

export const REFLOW_VIEWPORTS = [[320, 568, 1], [320, 256, 1], [640, 400, 2], [256, 568, 1], [240, 568, 1]];
const FOCUS_PAGES = ["termos.html", "calculadora-cmv.html", "ia-na-pratica.html"];
const FOCUS_VIEWPORTS = [[1280, 720], [390, 844], [320, 568]];
const HASH_VIEWPORTS = [[390, 844], [320, 568]];
const DETAILS_VIEWPORTS = [[1280, 720], [390, 844], [320, 568]];
const ARIA_PAGES = ["termos.html", "calculadora-cmv.html", "ia-na-pratica.html"];
const ARIA_VIEWPORTS = [[390, 844], [320, 568]];
const WORKERS = Math.max(1, Number(process.env.P03_WORKERS || 4));
const SUITES = (process.env.P03RF_SUITES || "reflow,focus,hash,details,aria").split(",").map((s) => s.trim()).filter(Boolean);

const [base, dir, expectedArg, out = "p03-reflow-focus"] = process.argv.slice(2);
if (!base || !dir || !expectedArg) { console.error("usage: <baseUrl> <pagesDir> <expectedPageCount> [outPrefix]"); process.exit(2); }
const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
const expected = Number(expectedArg);

// ---------------- medições no navegador ----------------
function measureLayout() {
  const de = document.documentElement;
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "");
  const scrollers = [], offsets = [], clipped = [];
  for (const el of [de, ...document.querySelectorAll("body, body *")]) {
    if (el.scrollTop || el.scrollLeft) offsets.push(sel(el));
    if (el === de) continue;
    const s = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(s.overflowY + " " + s.overflowX)) scrollers.push(sel(el));
  }
  if (window.scrollY || window.scrollX) offsets.push("viewport");
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0) continue; // estacionado à esquerda (skip link) = ocultação intencional
    if (r.right > de.clientWidth + 1 || r.left < -1) clipped.push(sel(el));
  }
  return { docH: de.scrollWidth > de.clientWidth + 1, docV: de.scrollHeight > de.clientHeight + 1, scrollers: scrollers.slice(0, 3), nScrollers: scrollers.length, offsets: offsets.slice(0, 3), clipped: clipped.slice(0, 3), nClipped: clipped.length };
}

// Alvos (controles e itens do índice): inteiros na tela, >= 44x44, no topo do hit-test.
function measureTargets(selector) {
  const de = document.documentElement, vw = de.clientWidth, vh = de.clientHeight;
  const bad = [];
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!el.getClientRects().length) continue;
    n++;
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
    const why = [];
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) why.push(`fora(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`);
    if (r.width < 43.5 || r.height < 43.5) why.push(`pequeno(${Math.round(r.width)}x${Math.round(r.height)})`);
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) why.push("encoberto");
    if (why.length) bad.push(name + ":" + why.join("+"));
  }
  return { n, bad };
}

// Estado de cada linha de texto / elemento substituído do <body> fora da UI de paginação:
// "v" inteira visível, "h" oculta, "p" parcialmente visível (recortada). Hit-test em 2 pontos por linha.
function measureLines(withTexts) {
  const root = document.body;
  const skip = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return !!(e && e.closest("[data-pg-ui],.skip-link,script,style,noscript,template")); };
  const visCss = (e) => e.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
  const probe = (r, owner) => {
    const x = Math.min(Math.max(r.left + r.width / 2, r.left + 0.5), r.right - 0.5);
    let vis = 0, cut = 0;
    for (const f of [0.25, 0.75]) {
      const hit = document.elementFromPoint(x, r.top + r.height * f);
      if (hit && (hit === owner || owner.contains(hit))) vis++;
      else if (!hit || hit.contains(owner)) cut++;
    }
    return vis && !cut ? "v" : vis ? "p" : "h";
  };
  const keys = [], states = [], texts = [], partial = [];
  const rg = document.createRange();
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let ni = 0;
  for (let n; (n = tw.nextNode());) {
    const t = n.textContent.replace(/\s+/g, " ").trim();
    if (!t || skip(n)) continue;
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
  for (const el of root.querySelectorAll("img,svg,input,button,select,textarea,video,iframe")) {
    if (skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.right > 0)) continue;
    const idx = ei++;
    const st = visCss(el) ? probe(r, el) : "h";
    keys.push("e" + idx); states.push(st);
    if (st === "p") partial.push("<" + el.tagName.toLowerCase() + ">");
  }
  const main = document.querySelector("main");
  const pg = main?.dataset.pgTotal ? { atual: Number(main.dataset.pgAtual), total: Number(main.dataset.pgTotal), modo: main.dataset.pgModo || "" } : null;
  return { keys, states, texts, partial: partial.slice(0, 3), partialCount: partial.length, pg };
}

// Descrição do elemento em foco para 2.4.3 / 2.4.7 / 2.4.11.
function focusInfo() {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { none: true };
  const all = [...document.querySelectorAll("*")];
  const de = document.documentElement, vw = de.clientWidth, vh = de.clientHeight;
  const r = a.getBoundingClientRect();
  const cs = getComputedStyle(a);
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== "none";
  const inside = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
  // Encoberto: 5 pontos (centro e a 20%/80% em cada eixo, fora dos cantos arredondados); cada ponto
  // deve cair no próprio elemento (ou dentro dele): nada fixo/sobreposto por cima do foco.
  const pts = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]].map(([fx, fy]) => {
    const x = Math.min(Math.max(r.left + r.width * fx, 0), vw - 1), y = Math.min(Math.max(r.top + r.height * fy, 0), vh - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === a || a.contains(hit));
  });
  const region = a.closest("[data-pg-ui]") ? "controls" : a.closest(".pg-trilho") ? (a.closest("header") ? "header" : a.closest("footer") ? "footer" : "content") : a.closest("header") ? "header" : a.closest("footer") ? "footer" : a.closest(".skip-link") || a.matches(".skip-link") ? "skip" : "other";
  const main = document.querySelector("main");
  return {
    desc: a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.className && typeof a.className === "string" ? "." + a.className.trim().split(/\s+/).slice(0, 2).join(".") : "") + ":" + (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20),
    order: all.indexOf(a), heading: /^H[1-6]$/.test(a.tagName), region, outline, shadow, ow: cs.outlineWidth, inside, covered: pts.filter((x) => !x).length, centerOk: pts[0],
    visible: a.checkVisibility({ visibilityProperty: true }), fora: !!a.closest("[data-pg-fora]"), skip: a.matches(".skip-link"),
    atual: Number(main?.dataset.pgAtual || 0), total: Number(main?.dataset.pgTotal || 0),
  };
}
function liveInfo() {
  const st = document.querySelector("[data-pg-ui][role=status]") || document.querySelector("[role=status]");
  return st ? { text: st.textContent, live: st.getAttribute("aria-live"), role: st.getAttribute("role") } : null;
}

async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming?.().endTime)).map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, 2000)),
  ]));
}
async function open(browser, url, { w, h, dsf = 1, js = true, blockPg = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, javaScriptEnabled: js, reducedMotion: "reduce" });
  if (blockPg) await ctx.route("**/paginacao.js", (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto(url, { waitUntil: "load" });
  if (!blockPg) await page.waitForSelector("main[data-pg-pronto]", { timeout: 5000 }).catch(() => {});
  await settle(page);
  return { ctx, page, errors, http: res?.status() ?? 0 };
}
const atual = (page) => page.evaluate(() => Number(document.querySelector("main")?.dataset.pgAtual || 0));
function multiset(arr) { const m = new Map(); for (const t of arr) m.set(t, (m.get(t) || 0) + 1); return m; }
function msDiff(a, b) {
  const A = multiset(a), B = multiset(b), miss = [], extra = [];
  for (const [t, c] of A) if ((B.get(t) || 0) < c) miss.push(t.slice(0, 40));
  for (const [t, c] of B) if ((A.get(t) || 0) < c) extra.push(t.slice(0, 40));
  return { miss, extra };
}
const CONTROLS = "[data-pg-ui] .pg-ant, [data-pg-ui] .pg-prox, [data-pg-ui] .pg-resumo";
const INDEX_ITEMS = "[data-pg-ui] .pg-lista a, [data-pg-ui] .pg-lista button";

// ---------------- suíte reflow ----------------
async function indexCheck(page, N, problems, tag) {
  await page.locator("[data-pg-ui] .pg-resumo").click({ timeout: 3000 });
  await settle(page);
  const seen = new Set();
  let windows = 0, items = 0;
  // volta à primeira janela do índice
  for (let g = 0; g < 400; g++) {
    const prev = page.locator('[data-pg-ui] .pg-janela[data-pg-dir="-1"]:not([aria-disabled="true"])');
    if (!(await prev.count())) break;
    await prev.click({ timeout: 3000 });
    await settle(page);
  }
  for (let guard = 0; guard < 400; guard++) {
    const t = await page.evaluate(measureTargets, INDEX_ITEMS);
    const lay = await page.evaluate(measureLayout);
    windows++; items += t.n;
    if (!t.n) { problems.push(`${tag}index_empty`); break; }
    if (t.bad.length) problems.push(`${tag}index_target:${t.bad.length}:${t.bad.slice(0, 2).join("|")}`);
    // recorte de conteúdo já é medido por bloco; aqui só rolagem causada pelo índice aberto
    if (lay.docH || lay.docV || lay.nScrollers || lay.offsets.length) problems.push(`${tag}index_overflow:${JSON.stringify(lay).slice(0, 160)}`);
    for (const n of await page.evaluate(() => [...document.querySelectorAll("[data-pg-ui] .pg-lista a")].map((a) => Number(a.getAttribute("href").replace(/^#bloco-/, ""))))) seen.add(n);
    const next = page.locator('[data-pg-ui] .pg-janela[data-pg-dir="1"]:not([aria-disabled="true"])');
    if (!(await next.count())) break;
    await next.click({ timeout: 3000 });
    await settle(page);
    if (t.bad.length) break;
  }
  const missing = [];
  for (let i = 1; i <= N; i++) if (!seen.has(i)) missing.push(i);
  if (missing.length) problems.push(`${tag}index_missing_blocks:${missing.length}/${N}:${missing.slice(0, 5).join(",")}`);
  // Clique no link do último bloco visível na janela atual: deve abrir esse bloco.
  const lastHref = await page.evaluate(() => { const l = [...document.querySelectorAll("[data-pg-ui] .pg-lista a")].pop(); return l ? l.getAttribute("href") : null; });
  if (lastHref) {
    await page.locator(`[data-pg-ui] .pg-lista a[href="${lastHref}"]`).click({ timeout: 3000 }).catch((e) => problems.push(`${tag}index_click:${String(e.message).split("\n")[0].slice(0, 60)}`));
    await settle(page);
    const got = await atual(page);
    if (got !== Number(lastHref.replace("#bloco-", ""))) problems.push(`${tag}index_link_${lastHref}->${got}`);
  }
  return { windows, items };
}

async function reflowTask(browser, file, [w, h, dsf]) {
  const problems = [];
  const url = `${base}/${file}`;
  const ref = await open(browser, url, { w, h, dsf, blockPg: true });
  const refTexts = (await ref.page.evaluate(measureLines, true)).texts;
  await ref.ctx.close();
  const { ctx, page, errors, http } = await open(browser, url, { w, h, dsf });
  if (http !== 200) problems.push("http_" + http);
  const st0 = await page.evaluate(measureLines, true);
  if (!st0.pg) { problems.push("no_pagination"); await ctx.close(); return { problems, blocks: 0 }; }
  const N = st0.pg.total;
  const d = msDiff(refTexts, st0.texts);
  if (d.miss.length || d.extra.length) problems.push(`text_mismatch:miss=${d.miss.length}:extra=${d.extra.length}:${[...d.miss, ...d.extra].slice(0, 2).join("|")}`);
  const seen = new Map(st0.keys.map((k) => [k, false]));
  let partialAll = 0, partialEx = [], clicks = 0, minPalco = Infinity;
  for (let k = 1; k <= N; k++) {
    const st = k === 1 ? st0 : await page.evaluate(measureLines, false);
    if (st.keys.length !== st0.keys.length) problems.push(`layout_changed_b${k}`);
    st.keys.forEach((key, i) => { if (st.states[i] === "v") seen.set(key, true); });
    if (st.partialCount) { partialAll += st.partialCount; partialEx.push(...st.partial.map((p) => `b${k}:${p}`)); }
    const m = await page.evaluate(measureLayout);
    if (m.docH) problems.push(`doc_scroll_h_b${k}`);
    if (m.docV) problems.push(`doc_scroll_v_b${k}`);
    if (m.nScrollers) problems.push(`scroll_container_b${k}:${m.scrollers.join("+")}`);
    if (m.offsets.length) problems.push(`scroll_offset_b${k}:${m.offsets.join("+")}`);
    if (m.nClipped) problems.push(`clipped_x_b${k}:${m.nClipped}:${m.clipped.join("+")}`);
    const t = await page.evaluate(measureTargets, CONTROLS);
    if (t.n !== 3) problems.push(`controls_count_b${k}:${t.n}`);
    if (t.bad.length) problems.push(`controls_b${k}:${t.bad.join("|")}`);
    minPalco = Math.min(minPalco, await page.evaluate(() => document.querySelector(".pg-palco")?.clientHeight ?? 0));
    if (k < N) {
      // Clique real (Playwright verifica visível, estável e que o ponto recebe o evento).
      try { await page.locator("[data-pg-ui] .pg-prox").click({ timeout: 3000 }); } catch (e) { problems.push(`click_next_b${k}:${String(e.message).split("\n")[0].slice(0, 60)}`); break; }
      await settle(page);
      clicks++;
      const got = await atual(page);
      if (got !== k + 1) { problems.push(`click_next_b${k}->${got}`); break; }
    }
  }
  if (partialAll) problems.push(`clipped_y:${partialAll}:${partialEx.slice(0, 3).join("|")}`);
  const unreachedKeys = [...seen].filter(([, v]) => !v).map(([k]) => k);
  const unreached = unreachedKeys.length;
  if (unreached) problems.push(`unreachable:${unreached}/${seen.size}:${unreachedKeys.slice(0, 3).map((k) => k[0] === "t" ? (st0.texts[Number(k.slice(1).split(":")[0])] || "").slice(0, 30) + "#" + k.split(":")[1] : k).join("|")}`);
  // Anterior também precisa ser clicável (no último bloco).
  if (N > 1) {
    try { await page.locator("[data-pg-ui] .pg-ant").click({ timeout: 3000 }); await settle(page); if ((await atual(page)) !== N - 1) problems.push("click_prev"); } catch (e) { problems.push("click_prev:" + String(e.message).split("\n")[0].slice(0, 60)); }
  }
  if (minPalco < 120) problems.push(`stage_too_small:${minPalco}px`);
  const idx = await indexCheck(page, N, problems, "");
  for (const e of errors) problems.push("pageerror:" + e.slice(0, 80));
  await ctx.close();
  return { problems, blocks: N, modo: st0.pg.modo, clicks, lines: seen.size, unreached, palco: minPalco, index_windows: idx.windows, index_items: idx.items };
}

// ---------------- suíte focus ----------------
async function focusTask(browser, file, [w, h]) {
  const problems = [];
  const { ctx, page, errors } = await open(browser, `${base}/${file}`, { w, h });
  const N = await page.evaluate(() => Number(document.querySelector("main")?.dataset.pgTotal || 0));
  const modo = await page.evaluate(() => document.querySelector("main")?.dataset.pgModo || "");
  if (!N) { problems.push("no_pagination"); await ctx.close(); return { problems }; }
  const posTab = await page.evaluate(() => [...document.querySelectorAll("[tabindex]")].filter((e) => Number(e.getAttribute("tabindex")) > 0).length);
  if (posTab) problems.push(`positive_tabindex:${posTab}`);
  const checkFocus = (f, tag) => {
    if (f.none) { problems.push(`${tag}no_focus`); return; }
    if (f.skip) return; // skip link: aparece ao receber foco (fixed), coberto pela checagem de visibilidade abaixo
    if (!f.visible || f.fora) problems.push(`${tag}focus_hidden_element:${f.desc}`);
    if (!f.outline && !f.shadow) problems.push(`${tag}no_focus_indicator:${f.desc}`);
    if (!f.inside) problems.push(`${tag}focus_outside_viewport:${f.desc}`);
    if (f.covered) problems.push(`${tag}focus_obscured:${f.covered}/5:${f.desc}`);
  };
  // 1) ciclo completo de Tab no bloco 1
  const seq = [];
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    await settle(page); // transições (inclusive "transition: all .01ms" do modo reduced-motion) concluídas
    const f = await page.evaluate(focusInfo);
    if (f.none) { if (seq.length) break; continue; }
    if (seq.length && f.order === seq[0].order) break; // voltou ao início
    checkFocus(f, "tab:");
    if (f.skip) { const v = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0; }); if (!v) problems.push("tab:skip_link_not_visible"); }
    seq.push(f);
  }
  let drops = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i].order < seq[i - 1].order) drops++;
  if (drops > 0) problems.push(`tab_order_not_dom:${drops}:${seq.map((s) => s.region[0]).join("")}`);
  const regions = [...new Set(seq.map((s) => s.region))];
  if (!seq.some((s) => s.region === "controls")) problems.push("tab_controls_unreachable");
  if (seq.length < 3) problems.push(`tab_cycle_short:${seq.length}`);
  // 2) troca de bloco: Tab até "Próxima", Enter
  await page.evaluate(() => document.activeElement?.blur());
  let reached = false;
  for (let i = 0; i < 120 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.matches?.("[data-pg-ui] .pg-prox"));
  }
  let blockChange = null;
  if (!reached) problems.push("tab_next_button_unreachable");
  else if (N > 1) {
    const before = await page.evaluate(liveInfo);
    await page.keyboard.press("Enter");
    await settle(page);
    const f = await page.evaluate(focusInfo);
    const after = await page.evaluate(liveInfo);
    blockChange = { atual: f.atual, focus: f.desc, heading: f.heading, stage_fallback: false, live_before: before?.text, live_after: after?.text, aria_live: after?.live };
    if (f.atual !== 2) problems.push(`enter_next->${f.atual}`);
    // Bloco sem título (ex.: só o formulário da calculadora): o foco vai ao palco (role=group
    // "Conteúdo paginado"), fallback documentado em paginacao.js. Qualquer outro destino falha.
    const onStage = await page.evaluate(() => document.activeElement?.matches(".pg-palco") && ![...document.querySelectorAll(".pg-trilho h1,.pg-trilho h2,.pg-trilho h3,.pg-trilho h4,.pg-trilho h5,.pg-trilho h6")].some((h) => h.checkVisibility({ visibilityProperty: true }) && !h.closest("[data-pg-fora]")));
    blockChange.stage_fallback = onStage;
    if (!f.heading && !onStage) problems.push(`focus_not_on_heading:${f.desc}`);
    if (f.region !== "content" && !onStage) problems.push(`focus_not_in_block:${f.region}`);
    if (!f.inside || f.covered || !f.visible) problems.push(`heading_focus_not_visible:${JSON.stringify({ inside: f.inside, covered: f.covered, visible: f.visible })}`);
    if (!after || after.role !== "status" || after.live !== "polite") problems.push(`live_region_missing:${JSON.stringify(after)}`);
    else if (after.text === (before?.text ?? "") || !after.text.startsWith(`Bloco 2 de ${N}`)) problems.push(`live_text_not_changed:${JSON.stringify([before?.text, after.text])}`);
    // Tab seguinte: avança no DOM, dentro do novo bloco (ou controles se o bloco não tem focável).
    await page.keyboard.press("Tab");
    await settle(page);
    const g = await page.evaluate(focusInfo);
    checkFocus(g, "after:");
    if (g.order <= f.order) problems.push(`tab_after_heading_backwards:${g.desc}`);
    if (g.atual !== 2) problems.push(`tab_after_heading_changed_block:${g.atual}`);
    // Tabuláveis visíveis antes de g no DOM: se houver, Shift+Tab tem de ir para um deles.
    const prevCount = await page.evaluate(() => {
      const a = document.activeElement;
      return [...document.querySelectorAll("a[href],button,input,select,textarea,summary,[tabindex]")].filter((e) => e !== a && e.tabIndex >= 0 && !e.disabled && e.checkVisibility({ visibilityProperty: true }) && (e.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)).length;
    });
    await page.keyboard.press("Shift+Tab");
    await settle(page);
    const b = await page.evaluate(focusInfo);
    if (b.none ? prevCount > 0 : !(b.order < g.order)) problems.push(`shift_tab_not_backwards:${b.desc || "fora_da_pagina"}:${prevCount}`);
    blockChange.next_tab = g.desc;
    blockChange.shift_tab = b.desc;
  }
  for (const e of errors) problems.push("pageerror:" + e.slice(0, 80));
  await ctx.close();
  return { problems, modo, blocks: N, tab_stops: seq.length, regions: regions.join(">"), order_drops: drops, sequence: seq.slice(0, 40).map((s) => `${s.region}:${s.desc}:${s.ow}`), block_change: blockChange };
}

// ---------------- suíte hash ----------------
function targetShown(id) {
  const t = document.getElementById(id);
  if (!t) return { ok: false, why: "missing" };
  const tw = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); const rg = document.createRange();
  let owner = t, r = t.getBoundingClientRect();
  for (let n; (n = tw.nextNode());) { if (!n.textContent.trim()) continue; rg.selectNodeContents(n); const rs = [...rg.getClientRects()].filter((x) => x.width && x.height); if (rs.length) { owner = n.parentElement; r = rs[0]; break; } }
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const inside = r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5;
  const x = r.left + r.width / 2;
  const pts = [0.25, 0.75].map((f) => document.elementFromPoint(x, r.top + r.height * f));
  const hits = pts.every((hit) => hit && (hit === owner || owner.contains(hit)));
  return { ok: owner.checkVisibility({ visibilityProperty: true }) && inside && hits, inside, hits };
}
async function hashTask(browser, file, [w, h]) {
  const problems = [];
  const first = await open(browser, `${base}/${file}`, { w, h });
  const N = await first.page.evaluate(() => Number(document.querySelector("main")?.dataset.pgTotal || 0));
  // ids na segunda metade do conteúdo paginado, renderizados, fora de <details> fechado e da UI
  const ids = await first.page.evaluate(() => {
    const tr = document.querySelector(".pg-trilho");
    if (!tr) return [];
    const els = [...tr.querySelectorAll("[id]")].filter((e) => e.getClientRects().length && !e.closest("details:not([open])") && e.textContent.trim() && /^[A-Za-z][\w-]*$/.test(e.id) && e.tagName !== "MAIN");
    const half = els.slice(Math.floor(els.length / 2));
    const pick = [];
    for (const f of [0, 0.5, 0.99]) { const e = half[Math.floor(f * (half.length - 1))]; if (e && !pick.includes(e.id)) pick.push(e.id); }
    return pick;
  });
  await first.ctx.close();
  const results = [];
  const targets = [...new Set([Math.ceil(N / 2), N])].filter((n) => n >= 1).map((n) => ({ hash: `bloco-${n}`, block: n })).concat(ids.map((id) => ({ hash: id })));
  for (const t of targets) {
    const { ctx, page, errors } = await open(browser, `${base}/${file}#${t.hash}`, { w, h });
    await page.waitForTimeout(150); await settle(page);
    const got = await atual(page);
    const lay = await page.evaluate(measureLayout);
    let shown;
    if (t.block) {
      // bloco certo e o título (ou primeira linha) desse bloco visível
      shown = got === t.block ? { ok: true } : { ok: false, why: `bloco ${got}` };
      if (got !== t.block) problems.push(`deeplink_${t.hash}->${got}`);
    } else {
      shown = await page.evaluate(targetShown, t.hash);
      if (!shown.ok) problems.push(`hash_target_not_shown:#${t.hash}:${JSON.stringify(shown)}:bloco${got}`);
    }
    if (lay.offsets.length || lay.docV || lay.docH || lay.nScrollers) problems.push(`hash_scrolled:#${t.hash}:${JSON.stringify({ o: lay.offsets, v: lay.docV, s: lay.scrollers })}`);
    for (const e of errors) problems.push("pageerror:" + e.slice(0, 80));
    results.push(`#${t.hash}=>b${got}${shown.ok ? "" : "!"}`);
    await ctx.close();
  }
  return { problems, blocks: N, targets: results };
}

// ---------------- suíte details ----------------
async function detailsTask(browser, file, [w, h]) {
  const problems = [];
  const { ctx, page, errors } = await open(browser, `${base}/${file}`, { w, h });
  const nd = await page.evaluate(() => [...document.querySelectorAll("main details")].filter((d) => !d.closest("[data-pg-ui]")).length);
  const res = [];
  for (let di = 0; di < Math.min(nd, 3); di++) {
    const idx = di === 0 ? 0 : di === 1 ? Math.floor(nd / 2) : nd - 1;
    await page.keyboard.press("Home"); await settle(page);
    const N = await page.evaluate(() => Number(document.querySelector("main").dataset.pgTotal));
    let vis = false;
    for (let k = 0; k < N && !vis; k++) {
      vis = await page.evaluate((i) => { const s = [...document.querySelectorAll("main details")].filter((d) => !d.closest("[data-pg-ui]"))[i].querySelector("summary"); const r = s.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + r.height / 2); return s.checkVisibility({ visibilityProperty: true }) && !!hit && (hit === s || s.contains(hit)); }, idx);
      if (!vis) { await page.keyboard.press("PageDown"); await settle(page); }
    }
    if (!vis) { problems.push(`details${idx}_summary_unreachable`); continue; }
    const b0 = await atual(page);
    await page.evaluate((i) => [...document.querySelectorAll("main details")].filter((d) => !d.closest("[data-pg-ui]"))[i].querySelector("summary").focus(), idx);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80); await settle(page); await page.waitForTimeout(80); await settle(page);
    const st = await page.evaluate((i) => {
      const d = [...document.querySelectorAll("main details")].filter((x) => !x.closest("[data-pg-ui]"))[i], s = d.querySelector("summary");
      const r = s.getBoundingClientRect(), vh = document.documentElement.clientHeight;
      const hit = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + r.height / 2);
      return { open: d.open, focused: document.activeElement === s, inside: r.top >= -0.5 && r.bottom <= vh + 0.5, hit: !!hit && (hit === s || s.contains(hit)) };
    }, idx);
    const lay = await page.evaluate(measureLayout);
    const b1 = await atual(page);
    if (!st.open) problems.push(`details${idx}_not_opened`);
    if (!st.focused) problems.push(`details${idx}_focus_lost`);
    if (!st.inside || !st.hit) problems.push(`details${idx}_summary_not_in_view:${JSON.stringify(st)}`);
    if (lay.offsets.length || lay.docV || lay.docH || lay.nScrollers) problems.push(`details${idx}_scrolled:${JSON.stringify({ o: lay.offsets, v: lay.docV, s: lay.scrollers })}`);
    // conteúdo aberto alcançável: primeira linha fora do summary visível neste bloco ou nos 3 seguintes
    let found = false, k2 = 0;
    for (; k2 < 4 && !found; k2++) {
      found = await page.evaluate((i) => {
        const d = [...document.querySelectorAll("main details")].filter((x) => !x.closest("[data-pg-ui]"))[i];
        const tw = document.createTreeWalker(d, NodeFilter.SHOW_TEXT); const rg = document.createRange();
        for (let n; (n = tw.nextNode());) {
          if (!n.textContent.trim() || n.parentElement.closest("summary")) continue;
          rg.selectNodeContents(n); const r = [...rg.getClientRects()].find((x) => x.width && x.height); if (!r) continue;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return n.parentElement.checkVisibility({ visibilityProperty: true }) && !!hit && (hit === n.parentElement || n.parentElement.contains(hit));
        }
        return true; // sem texto além do summary
      }, idx);
      if (!found) { await page.keyboard.press("PageDown"); await settle(page); }
    }
    if (!found) problems.push(`details${idx}_content_unreachable`);
    res.push(`d${idx}:b${b0}->${b1}${found ? "" : "!"}`);
    // fecha de novo (estado limpo)
    await page.evaluate((i) => { [...document.querySelectorAll("main details")].filter((x) => !x.closest("[data-pg-ui]"))[i].open = false; }, idx);
    await settle(page);
  }
  for (const e of errors) problems.push("pageerror:" + e.slice(0, 80));
  await ctx.close();
  return { problems, details: nd, opened: res };
}

// ---------------- suíte aria (PROXY de leitor de tela) ----------------
async function ariaTask(browser, file, [w, h]) {
  const problems = [];
  const { ctx, page } = await open(browser, `${base}/${file}`, { w, h });
  const info = await page.evaluate(() => ({ header: !!document.querySelector("body header.site-header, body > header"), footer: !!document.querySelector("footer"), modo: document.querySelector("main")?.dataset.pgModo, N: Number(document.querySelector("main")?.dataset.pgTotal || 0) }));
  const snap1 = await page.locator("body").ariaSnapshot();
  const need = ["- main", 'navigation "Blocos de conteúdo"', 'button "Anterior"', 'button "Próxima"', "- status"];
  // No modo corpo o cabeçalho é parte do 1º bloco e o rodapé do último (fora deles ficam ocultos como
  // qualquer conteúdo de outro bloco); no modo normal ambos estão sempre presentes.
  if (info.header) need.push("- banner");
  for (const n of need) if (!snap1.includes(n)) problems.push(`aria_missing:${n}`);
  if (info.footer) {
    if (info.modo === "corpo") { await page.keyboard.press("End"); await settle(page); }
    const snapEnd = await page.locator("body").ariaSnapshot();
    if (!snapEnd.includes("- contentinfo")) problems.push("aria_missing:- contentinfo");
    if (info.modo === "corpo") { await page.keyboard.press("Home"); await settle(page); }
  }
  // texto de um título que está no bloco 2 (oculto no bloco 1): ausente da árvore agora, presente depois.
  const h2 = await page.evaluate(() => {
    for (const h of document.querySelectorAll(".pg-trilho h1,.pg-trilho h2,.pg-trilho h3")) {
      const a = h.closest("[data-pg-fora]");
      if (a && h.textContent.trim().length > 6) return h.textContent.replace(/\s+/g, " ").trim();
    }
    return null;
  });
  let hiddenOk = null;
  if (h2 && info.N > 1) {
    const inTree = snap1.includes(h2.slice(0, 30));
    if (inTree) problems.push(`aria_hidden_block_exposed:${h2.slice(0, 30)}`);
    // avança até o bloco que contém o título
    let shown = false;
    for (let k = 1; k < info.N && !shown; k++) {
      await page.locator("[data-pg-ui] .pg-prox").click({ timeout: 3000 }); await settle(page);
      shown = (await page.locator("body").ariaSnapshot()).includes(h2.slice(0, 30));
    }
    if (!shown) problems.push(`aria_block_text_never_exposed:${h2.slice(0, 30)}`);
    const snap2 = await page.locator("body").ariaSnapshot();
    const live = await page.evaluate(liveInfo);
    if (!live || !snap2.includes(live.text.slice(0, 12))) problems.push("aria_status_text_not_in_tree");
    hiddenOk = !inTree && shown;
  }
  await ctx.close();
  return { problems, modo: info.modo, blocks: info.N, proxy: "playwright-ariaSnapshot (Chromium a11y tree), NOT a real screen reader", hidden_block_check: hiddenOk, snapshot_lines: snap1.split("\n").length };
}

// ---------------- execução ----------------
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const tasks = [];
const have = (f) => pages.includes(f);
if (SUITES.includes("reflow")) for (const f of pages) for (const v of REFLOW_VIEWPORTS) tasks.push({ suite: "reflow", file: f, vp: v, run: reflowTask });
if (SUITES.includes("focus")) for (const f of FOCUS_PAGES.filter(have)) for (const v of FOCUS_VIEWPORTS) tasks.push({ suite: "focus", file: f, vp: v, run: focusTask });
if (SUITES.includes("hash")) for (const f of pages) for (const v of HASH_VIEWPORTS) tasks.push({ suite: "hash", file: f, vp: v, run: hashTask });
if (SUITES.includes("details")) {
  for (const f of pages) {
    const html = fs.readFileSync(path.join(dir, f), "utf8");
    if (/<details/i.test(html) || !fs.statSync(path.join(dir, f)).size) for (const v of DETAILS_VIEWPORTS) tasks.push({ suite: "details", file: f, vp: v, run: detailsTask });
  }
}
if (SUITES.includes("aria")) for (const f of ARIA_PAGES.filter(have)) for (const v of ARIA_VIEWPORTS) tasks.push({ suite: "aria", file: f, vp: v, run: ariaTask });
// tarefas longas primeiro (melhor balanceamento)
tasks.sort((a, b) => (a.suite === "reflow" ? 0 : 1) - (b.suite === "reflow" ? 0 : 1));
const rows = [];
let next = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < tasks.length) {
    const t = tasks[next++];
    const vp = t.vp.slice(0, 2).join("x") + (t.vp[2] && t.vp[2] !== 1 ? "@" + t.vp[2] : "");
    let timer;
    try {
      const r = await Promise.race([t.run(browser, t.file, t.vp), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("task_timeout_300s")), 300000); })]);
      rows.push({ suite: t.suite, page: t.file, viewport: vp, ...r });
    } catch (e) {
      rows.push({ suite: t.suite, page: t.file, viewport: vp, problems: ["error:" + String(e.message || e).split("\n")[0].slice(0, 140)] });
    } finally { clearTimeout(timer); }
    if (process.env.P03_TRACE) console.error("TASK_END", t.suite, t.file, vp, rows[rows.length - 1].problems.length);
  }
}));
await browser.close();
rows.sort((x, y) => (x.suite + x.page + x.viewport).localeCompare(y.suite + y.page + y.viewport));
const by = (s) => rows.filter((r) => r.suite === s);
const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const failures = rows.filter((r) => r.problems.length);
const summary = {
  schema: "zevanory.p03.reflow-focus.v1", pages: pages.length, expected_pages: expected, suites: SUITES, tasks: rows.length, tasks_pass: rows.length - failures.length, failures: failures.length,
  reflow: { viewports: REFLOW_VIEWPORTS.map((v) => `${v[0]}x${v[1]}${v[2] !== 1 ? "@" + v[2] : ""}`), cells: by("reflow").length, pass: by("reflow").filter((r) => !r.problems.length).length, blocks: sum(by("reflow"), "blocks"), next_clicks: sum(by("reflow"), "clicks"), lines: sum(by("reflow"), "lines"), index_items_checked: sum(by("reflow"), "index_items"), min_stage_px: Math.min(...by("reflow").map((r) => r.palco ?? Infinity)), modes: [...new Set(by("reflow").map((r) => r.modo))] },
  focus: { cells: by("focus").length, pass: by("focus").filter((r) => !r.problems.length).length, tab_stops: sum(by("focus"), "tab_stops"), order_drops: sum(by("focus"), "order_drops") },
  hash: { cells: by("hash").length, pass: by("hash").filter((r) => !r.problems.length).length, targets: by("hash").reduce((a, r) => a + (r.targets?.length || 0), 0) },
  details: { cells: by("details").length, pass: by("details").filter((r) => !r.problems.length).length, opened: by("details").reduce((a, r) => a + (r.opened?.length || 0), 0) },
  aria_proxy: { cells: by("aria").length, pass: by("aria").filter((r) => !r.problems.length).length, note: "Playwright ariaSnapshot proxy; NVDA/VoiceOver not available in cloud CI" },
};
fs.writeFileSync(out + ".json", JSON.stringify({ ...summary, rows }, null, 1));
fs.writeFileSync(out + ".csv", ["suite,page,viewport,problems", ...rows.map((r) => [r.suite, r.page, r.viewport, `"${r.problems.join(" ").replace(/"/g, "'")}"`].join(","))].join("\n"));
console.log("::notice title=P03_REFLOW_FOCUS::" + JSON.stringify(summary));
let bad = false;
if (pages.length !== expected) { console.log(`::error title=P03RF_PAGE_COUNT::expected ${expected} pages, found ${pages.length}`); bad = true; }
for (const f of failures.slice(0, 40)) console.log("::error title=P03RF_FAIL::" + JSON.stringify({ suite: f.suite, page: f.page, viewport: f.viewport, problems: f.problems.slice(0, 6) }));
if (failures.length) bad = true;
console.log(bad ? "P03_REFLOW_FOCUS=FAIL" : "P03_REFLOW_FOCUS=PASS");
if (bad) process.exit(1);
