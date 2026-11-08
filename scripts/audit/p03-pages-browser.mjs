// P03 | Checagens de navegador para UMA página (Playwright + axe-core), sem rede externa: a página vem
// do servidor local (scripts/audit/sales-local-server.mjs, através do Worker real) e qualquer pedido
// fora de 127.0.0.1 é abortado e registrado. Sem bypassCSP: o axe entra por page.evaluate (CDP), então a
// CSP de produção continua valendo e um erro de CSP aparece como erro de console.
// Códigos (B01...B09) estáveis, usados pelo relatório, pelos testes e pelos mutantes.
export const VIEWPORTS = Object.freeze({ "360": { width: 360, height: 740 }, "1350": { width: 1350, height: 900 } });
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
export const MIN_TARGET = 24;   // WCAG 2.2 AA 2.5.8 (o padrão interno de 44 px é medido à parte e só reportado)
export const MAX_TABS = 400;

export async function auditPage(browser, url, { viewport = "360", scheme = "light", axeSource, expectStatus = 200 } = {}) {
  const vp = VIEWPORTS[viewport];
  const mobile = viewport === "360";
  const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce", isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const problems = [], info = {};
  const p = (code, msg) => problems.push({ code, msg });
  const external = [], consoleErrors = [];
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
    external.push(u.origin + u.pathname); return route.abort();
  });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e.message).slice(0, 200)));
  // Sub-recurso com erro HTTP (o próprio documento já é conferido em B01).
  const badResponses = [];
  page.on("response", (r) => { if (r.status() >= 400 && r.request().resourceType() !== "document") badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 45000 });
    const status = res ? res.status() : 0;
    info.status = status;
    if (status !== expectStatus) p("B01", `HTTP ${status} (esperado ${expectStatus})`);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    // B02: axe-core WCAG 2.0/2.1/2.2 A+AA + best-practice; serious/critical = falha, o resto é registrado.
    await page.evaluate(axeSource);
    const axe = await page.evaluate(async (tags) => {
      const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
    }, AXE_TAGS);
    info.axe = axe;
    for (const v of axe) if (v.impact === "serious" || v.impact === "critical") p("B02", `axe ${v.impact} ${v.id} (${v.nodes}): ${v.targets.join(" | ")}`);
    // B03: overflow horizontal (a página nunca rola na horizontal; em 360 px é o critério 1.4.10).
    const ov = await page.evaluate(() => {
      const de = document.documentElement, vw = de.clientWidth, wide = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (!r.width || s.visibility === "hidden" || s.position === "fixed") continue;
        if (r.right > vw + 1 && !el.closest(".skip-link")) {
          let clipped = false;
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible") { clipped = true; break; } }
          if (!clipped) wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(r.right)}`);
        }
      }
      return { scrollWidth: de.scrollWidth, clientWidth: vw, wide: wide.slice(0, 5) };
    });
    info.overflow = ov;
    if (ov.scrollWidth > ov.clientWidth + 1) p("B03", `rolagem horizontal ${ov.scrollWidth}>${ov.clientWidth}: ${ov.wide.join(", ")}`);
    // B04: alvos de toque >= 24 px (2.5.8). Exceção da própria norma: link dentro de frase (inline).
    const tg = await page.evaluate((min) => {
      const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[tabindex]:not([tabindex="-1"])';
      const small = [], under44 = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (!r.width || !r.height || s.visibility === "hidden" || s.display === "none" || el.closest("[hidden],[aria-hidden=true],.skip-link")) continue;
        if (el.matches(".skip-link")) continue;
        const inline = s.display === "inline" && el.tagName === "A" && el.parentElement && (el.parentElement.textContent || "").trim().length > (el.textContent || "").trim().length + 1;
        const label = `${el.tagName.toLowerCase()}"${(el.textContent || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`;
        if (!inline && (r.width < min - 0.5 || r.height < min - 0.5)) small.push(label);
        else if (!inline && (r.width < 43.5 || r.height < 43.5)) under44.push(label);
      }
      return { small: small.slice(0, 8), smallCount: small.length, under44: under44.slice(0, 5), under44Count: under44.length };
    }, MIN_TARGET);
    info.targets = { under24: tg.smallCount, under44: tg.under44Count, sample44: tg.under44 };
    if (tg.smallCount) p("B04", `${tg.smallCount} alvo(s) < ${MIN_TARGET} px: ${tg.small.join(", ")}`);
    // B05..B08: teclado. 1º Tab = skip-link visível; Enter leva o foco ao <main>; depois cada parada
    // tem foco visível e não encoberto, segue a ordem do DOM e o ciclo inteiro é percorrido (sem armadilha).
    const kb = await keyboard(page);
    info.keyboard = { stops: kb.stops, expected: kb.expected };
    for (const [code, msg] of kb.problems) p(code, msg);
    if (external.length) info.externalBlocked = [...new Set(external)].slice(0, 5);
    // "Failed to load resource" duplica o evento de resposta (documento 404 esperado ou sub-recurso, este em badResponses).
    const ce = consoleErrors.filter((e) => !/^Failed to load resource:/.test(e));
    if (ce.length) p("B09", `erro de console/CSP: ${ce.slice(0, 3).join(" | ")}`);
    if (badResponses.length) p("B09", `sub-recurso com erro: ${[...new Set(badResponses)].slice(0, 3).join(" | ")}`);
  } catch (e) {
    p("B00", `erro inesperado (fail-closed): ${String(e && e.message || e).slice(0, 200)}`);
  } finally { await ctx.close(); }
  return { problems, info };
}

async function keyboard(page) {
  const problems = [];
  const expected = await page.evaluate(() => {
    const sel = 'a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]';
    const list = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.tabIndex < 0) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      if (s.visibility === "hidden" || s.display === "none" || el.closest("[inert],details:not([open]) > :not(summary)")) return false;
      return !!(r.width || r.height) || el.matches(".skip-link");
    });
    list.forEach((el, i) => el.setAttribute("data-p03-tab", String(i)));
    return { count: list.length, positive: [...document.querySelectorAll("[tabindex]")].filter((e) => e.tabIndex > 0).length };
  });
  if (expected.positive) problems.push(["B07", `${expected.positive} elemento(s) com tabindex positivo (ordem fora do DOM)`]);
  // Uma medição só vale depois que transições (o skip-link saindo da tela) terminaram: se a 1ª leitura
  // acusa foco invisível/encoberto, espera 200 ms e mede de novo; a 2ª leitura é a que conta.
  const probe = async () => { const a = await probe1(); if (a.body || (a.ring && a.inView && !a.covered)) return a; await page.waitForTimeout(200); return probe1(); };
  const probe1 = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { body: true };
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1) || (s.boxShadow && s.boxShadow !== "none");
    const cx = Math.min(Math.max(r.left + Math.min(r.width / 2, 20), 0), innerWidth - 1), cy = Math.min(Math.max(r.top + Math.min(r.height / 2, 12), 0), innerHeight - 1);
    const top = document.elementFromPoint(cx, cy);
    const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    const covered = inView && !!top && top !== el && !el.contains(top) && !top.contains(el);
    return { idx: el.getAttribute("data-p03-tab"), skip: el.matches(".skip-link"), ring, inView, covered, inMain: !!el.closest("main"),
      label: `${el.tagName.toLowerCase()}"${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"` };
  });
  await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press("Tab");
  await settle();
  const first = await probe();
  const hasSkip = await page.evaluate(() => !!document.querySelector(".skip-link"));
  if (hasSkip && !first.skip) problems.push(["B05", `1º Tab não foca o skip-link (foi ${first.label || "body"})`]);
  else if (hasSkip && (!first.inView || !first.ring)) problems.push(["B05", "skip-link focado mas invisível ou sem indicador de foco"]);
  // Ciclo completo a partir do 1º Tab, até o foco sair do documento (body) ou voltar ao início.
  const seen = new Set(), noRing = [], covered = [], order = [];
  let last = -1, stops = 0, repeats = 0, cur = first;
  for (let i = 0; i < Math.min(expected.count + 5, MAX_TABS); i++) {
    if (cur.body) break;
    stops++;
    if (cur.idx !== null) {
      const n = +cur.idx;
      if (seen.has(n)) { if (n === last) repeats++; else break; }  // voltou ao início do ciclo
      else { if (n < last) order.push(`${cur.label} (#${n} depois de #${last})`); seen.add(n); }
      last = n;
    }
    if (!cur.ring) noRing.push(cur.label);
    if (!cur.inView) noRing.push(cur.label + " fora da tela");
    if (cur.covered) covered.push(cur.label);
    if (repeats >= 2) break;
    await page.keyboard.press("Tab");
    await settle();
    cur = await probe();
  }
  // Skip-link de fato: do início, Tab (skip-link) + Enter + Tab precisa cair dentro do <main>.
  if (hasSkip && first.skip) {
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.focus(".skip-link");
    await page.keyboard.press("Enter");
    await settle();
    const tgt = await page.evaluate(() => { const a = document.activeElement; return !!(a && (a.tagName === "MAIN" || a.closest("main"))); });
    await page.keyboard.press("Tab");
    await settle();
    const next = await probe();
    if (!(tgt || next.inMain)) problems.push(["B05", `Enter no skip-link não leva ao <main> (foco seguinte: ${next.label || "body"})`]);
  }
  if (noRing.length) problems.push(["B06", `${noRing.length} parada(s) sem foco visível: ${[...new Set(noRing)].slice(0, 4).join(", ")}`]);
  if (covered.length) problems.push(["B06", `${covered.length} parada(s) com foco encoberto: ${[...new Set(covered)].slice(0, 4).join(", ")}`]);
  if (order.length) problems.push(["B07", `ordem de foco fora da ordem do DOM: ${order.slice(0, 3).join(", ")}`]);
  if (repeats >= 2) problems.push(["B08", "armadilha de teclado: o foco não sai do mesmo elemento"]);
  else if (expected.count && seen.size < expected.count) problems.push(["B08", `ciclo de Tab alcançou ${seen.size} de ${expected.count} elementos focáveis`]);
  return { problems, stops, expected: expected.count };
}
