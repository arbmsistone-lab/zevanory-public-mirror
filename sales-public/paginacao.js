// ZEVANORY P03: paginação acessível do conteúdo principal em "blocos" do tamanho da tela.
// Regra estrita do proprietário (22/10/2026 09:06, "páginas jurídicas por paginação"): nenhuma
// barra de rolagem, global ou interna, em nenhuma página pública de vendas, inclusive as jurídicas.
//
// Como funciona (aprimoramento progressivo):
// - Sem JavaScript nada muda: o conteúdo continua inteiro e rolável (fallback documentado).
// - Com JavaScript o <main> vira: palco (área visível, overflow:clip, sem contêiner de rolagem) +
//   área fixa (barra de compra no celular) + controles "Anterior / Bloco X de N / Próxima".
// - O conteúdo NÃO é reescrito, recortado nem reordenado: os nós ficam no mesmo lugar do DOM. O
//   script só mede a altura disponível, divide o fluxo em blocos que cabem nela (sem cortar
//   elementos; um elemento maior que a tela é dividido entre linhas de texto) e mostra um bloco por
//   vez com translateY + clip-path. Os elementos de outros blocos ficam com visibility:hidden, fora
//   da ordem de tabulação e da árvore de acessibilidade.
// - Recalcula em redimensionamento, rotação, zoom, fontes carregadas, <details> aberto e resultado
//   de calculadora (ResizeObserver), mantendo na tela o elemento em foco.
// - Teclado: PageDown/ArrowRight avançam, PageUp/ArrowLeft voltam, Home/End vão ao primeiro/último.
//   Na troca, o foco vai ao título do bloco e um aria-live="polite" anuncia "Bloco X de N".
// - Links profundos: #bloco-3 abre o bloco 3; #qualquer-id abre o bloco que contém o alvo.
// - Reflow/zoom (WCAG 1.4.10, auditoria do Sol): em tela baixa (altura <= 600 px CSS, ex.: 320x256,
//   1280x800 a 200% = 640x400) ou quando cabeçalho + rodapé + barra de compra + controles ocupariam
//   mais da metade da altura, a paginação passa a valer para o <body> inteiro ("modo corpo"): cabeçalho,
//   <main> e rodapé entram no fluxo paginado (continuam fora do <main>, landmarks preservados) e só
//   os controles ficam fixos. Os nós são devolvidos aos seus lugares ao voltar ao modo normal.
// - Índice de blocos: grade que se ajusta à largura (auto-fill, alvos de 44 px) e nunca passa da
//   altura disponível; com mais blocos do que cabem, mostra uma janela de blocos com botões
//   "anteriores/seguintes" (sem rolagem nem recorte em 320, 256 ou 240 px de largura).
// - Impressão: paginacao.css mostra todo o conteúdo sem paginação.
(() => {
  "use strict";
  const main = document.querySelector("main");
  if (!main || main.hasAttribute("data-pg-total")) return;
  const corpo = document.body;
  const raiz = document.documentElement;
  const FOLGA = 8; // px livres acima/abaixo do bloco (contorno de foco não encosta na borda)
  const PREFIXO = "bloco-";
  const reduzir = window.matchMedia("(prefers-reduced-motion: reduce)");

  const novo = (tag, cls, attrs = {}) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // Estrutura: os nós existentes são MOVIDOS (nunca clonados) para dentro do trilho, na mesma ordem;
  // um comentário marca o lugar de origem de cada um para a desmontagem (troca de modo).
  const palco = novo("div", "pg-palco", { role: "group", "aria-label": "Conteúdo paginado" });
  const trilho = novo("div", "pg-trilho");
  const fixos = novo("div", "pg-fixos");
  palco.appendChild(trilho);

  const nav = novo("nav", "pg-controles", { "aria-label": "Blocos de conteúdo", "data-pg-ui": "" });
  const btnAnt = novo("button", "pg-botao pg-ant", { type: "button" });
  // Rótulo adaptativo (sem breakpoint): por extenso quando cabe; senão a forma curta visível ("Ant",
  // "Próx"), que é prefixo do nome acessível ("Anterior", "Próxima"; WCAG 2.5.3). Nunca só ícone.
  btnAnt.innerHTML = '<span aria-hidden="true">‹</span> <span class="pg-rot"><span class="pg-longo">Anterior</span><span class="pg-curto" aria-hidden="true">Ant</span></span>';
  const btnProx = novo("button", "pg-botao pg-prox", { type: "button" });
  btnProx.innerHTML = '<span class="pg-rot"><span class="pg-longo">Próxima</span><span class="pg-curto" aria-hidden="true">Próx</span></span> <span aria-hidden="true">›</span>';
  const indice = novo("details", "pg-indice");
  const resumo = novo("summary", "pg-resumo");
  const lista = novo("ol", "pg-lista", { "aria-label": "Ir para o bloco" });
  indice.append(resumo, lista);
  // O anúncio fica dentro do <nav> (landmark) para estar sempre numa região, em qualquer modo.
  const anuncio = novo("p", "pg-sr", { role: "status", "aria-live": "polite", "aria-atomic": "true", "data-pg-ui": "" });
  nav.append(btnAnt, indice, btnProx, anuncio);

  let atomos = []; // elementos indivisíveis (ou divididos por linhas), em ordem
  let blocosDe = new Map(); // átomo -> Set de índices de bloco (0-based)
  let blocos = []; // [{ini, fim}] em coordenadas do trilho
  let atual = 0;
  let versao = 0;
  let intencao = null; // bloco pedido por #bloco-N na carga, até o leitor navegar
  let modo = null; // "main" (cabeçalho/rodapé fixos) ou "corpo" (tudo paginado, tela baixa)
  let lugares = []; // [comentário no lugar de origem, nó movido]
  let hashPendente = false; // #bloco-N / #id da carga ainda sem blocos medidos
  let janela = null; // início da janela do índice escolhido pelos botões anteriores/seguintes

  const guardar = (n) => { const c = document.createComment("pg"); n.replaceWith(c); lugares.push([c, n]); return n; };
  function montar(m) {
    modo = m;
    const cont = m === "corpo" ? corpo : main;
    const fica = (n) => n.nodeType === 1 && (n.matches("script,style,link,template,noscript,.skip-link,[data-pg-ui]") || getComputedStyle(n).position === "fixed");
    for (const n of [...cont.childNodes]) if (!fica(n)) trilho.appendChild(guardar(n));
    // Barra de compra do celular: fixa no modo normal; no modo corpo volta ao fluxo (mais altura útil).
    if (m === "main") for (const el of [...trilho.querySelectorAll(":scope > .buy-bar")]) fixos.appendChild(guardar(el));
    const ultimo = lugares.length ? lugares[lugares.length - 1][0] : null;
    if (m === "main") main.append(palco, fixos, nav);
    else if (ultimo && ultimo.parentNode === corpo) ultimo.after(palco, fixos, nav);
    else corpo.append(palco, fixos, nav);
    raiz.classList.add("pg", "pg-montando");
    raiz.classList.toggle("pg-corpo", m === "corpo");
    main.setAttribute("data-pg-modo", m);
    requestAnimationFrame(() => requestAnimationFrame(() => raiz.classList.remove("pg-montando")));
  }
  function desmontar() {
    for (const a of atomos) a.removeAttribute("data-pg-fora");
    atomos = [];
    blocosDe = new Map();
    trilho.style.transform = "";
    trilho.style.clipPath = "";
    // Ordem inversa: um nó movido duas vezes (barra de compra) volta primeiro ao trilho e depois ao lugar.
    for (const [c, n] of lugares.reverse()) c.replaceWith(n);
    lugares = [];
    palco.remove(); fixos.remove(); nav.remove();
  }
  // Tela baixa: altura <= 600 px CSS, ou cabeçalho + rodapé + barra de compra + controles ocupando
  // mais de 50% da altura (volta ao normal só abaixo de 40%: histerese, sem alternar a cada medida).
  function querCorpo() {
    const vh = window.innerHeight;
    if (vh <= 600) return true;
    let extra = nav.offsetHeight;
    for (const e of corpo.querySelectorAll(".site-header,.site-footer,.buy-bar")) if (!e.closest("[data-pg-ui]")) extra += e.offsetHeight;
    return extra > (modo === "corpo" ? 0.4 : 0.5) * vh;
  }

  // Títulos e rótulos de campo ficam no mesmo bloco do que introduzem (nunca órfãos no fim).
  const ehTitulo = (el) => /^H[1-6]$/.test(el.tagName) || el.matches("label,.section-kicker,.eyebrow,.hero-panel-label,.section-head");
  const textoSignificativo = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  // Linhas de um elemento maior que a área útil: retângulos de texto e de elementos substituídos.
  function linhas(el, base) {
    const rs = [];
    const rg = document.createRange();
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (!n.textContent.trim()) continue;
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.height > 0) rs.push({ top: r.top - base, bot: r.bottom - base });
    }
    for (const e of el.querySelectorAll("img,svg,input,button,select,textarea,video,iframe")) {
      const r = e.getBoundingClientRect();
      if (r.height > 0) rs.push({ top: r.top - base, bot: r.bottom - base });
    }
    rs.sort((a, b) => a.top - b.top);
    const out = [];
    for (const r of rs) {
      const u = out[out.length - 1];
      // Mesma linha = sobreposição de mais da metade da menor altura. Linhas consecutivas cujos
      // retângulos de tinta se sobrepõem um pouco (line-height < 1, ex.: título do hero) continuam
      // linhas separadas; antes viravam uma unidade só, maior que a tela, e as últimas linhas nunca
      // apareciam inteiras (teste de reflow em 320x256).
      if (u && Math.min(u.bot, r.bot) - r.top > 0.5 * Math.min(u.bot - u.top, r.bot - r.top)) u.bot = Math.max(u.bot, r.bot);
      else out.push({ ...r });
    }
    return out.length ? out : [{ top: el.getBoundingClientRect().top - base, bot: el.getBoundingClientRect().bottom - base }];
  }

  function medir(H) {
    // Átomos de uma medição anterior podem virar contêineres agora: nenhum fica oculto de sobra.
    for (const a of atomos) a.removeAttribute("data-pg-fora");
    const base = trilho.getBoundingClientRect().top;
    const unidades = [];
    atomos = [];
    const percorrer = (pai) => {
      for (const c of pai.children) {
        const cs = getComputedStyle(c);
        if (cs.display === "none" || cs.position === "fixed") continue;
        if (cs.display === "contents") { percorrer(c); continue; }
        const r = c.getBoundingClientRect();
        if (r.height <= 0) continue;
        const top = r.top - base, bot = r.bottom - base;
        if (bot - top <= H) { atomos.push(c); unidades.push({ top, bot, a: c }); continue; }
        if (c.children.length && !textoSignificativo(c)) { percorrer(c); continue; }
        // Maior que a tela e com texto próprio (ex.: cláusula longa): divide entre linhas.
        atomos.push(c);
        for (const l of linhas(c, base)) unidades.push({ top: l.top, bot: l.bot, a: c });
      }
    };
    percorrer(trilho);
    unidades.sort((x, y) => x.top - y.top || x.bot - y.bot);
    // Guloso: cada bloco recebe unidades enquanto cabem em H. Um título no fim de um bloco
    // ("2. Produtos" sem o texto) passa para o bloco seguinte junto do conteúdo que ele introduz.
    const grupos = [];
    let g = null;
    for (const u of unidades) {
      if (!g || u.bot > g.ini + H) {
        // Só títulos que são os ÚLTIMOS do bloco na ordem do documento (em layout de 2 colunas,
        // um título seguido de conteúdo da outra coluna não é órfão).
        const levar = [];
        if (g) {
          const ordem = [...g.us].sort((x, y) => (x.a === y.a ? x.top - y.top : x.a.compareDocumentPosition(y.a) & 4 ? -1 : 1));
          while (ordem.length > levar.length + 1) {
            const t = ordem[ordem.length - 1 - levar.length];
            if (t.a === u.a || !ehTitulo(t.a) || u.bot > Math.min(t.top, ...levar.map((x) => x.top)) + H) break;
            levar.unshift(t);
          }
          if (levar.length) g.us = g.us.filter((x) => !levar.includes(x));
          levar.sort((x, y) => x.top - y.top);
        }
        g = { ini: levar.length ? levar[0].top : u.top, us: levar };
        grupos.push(g);
      }
      g.us.push(u);
    }
    blocos = grupos.map((x) => ({ ini: Math.min(...x.us.map((u) => u.top)), fim: Math.max(...x.us.map((u) => u.bot)) }));
    blocosDe = new Map(atomos.map((a) => [a, new Set()]));
    grupos.forEach((x, i) => { for (const u of x.us) blocosDe.get(u.a).add(i); });
    if (!blocos.length) blocos.push({ ini: 0, fim: 0 });
  }

  const atomoDe = (el) => { for (let e = el; e && e !== trilho; e = e.parentElement) if (blocosDe.has(e)) return e; return null; };
  function blocoDe(el) {
    if (!el || !trilho.contains(el)) return -1;
    const a = atomoDe(el);
    if (a) {
      const s = [...blocosDe.get(a)];
      if (s.length <= 1) return s.length ? s[0] : -1;
      // Átomo dividido: o bloco cuja janela contém o topo do alvo.
      const t = el.getBoundingClientRect().top - trilho.getBoundingClientRect().top;
      return s.find((i) => t >= blocos[i].ini - 1 && t < blocos[i].fim) ?? s[0];
    }
    // Contêiner que agrupa átomos: o primeiro átomo dentro dele.
    for (const x of atomos) if (el.contains(x)) return Math.min(...blocosDe.get(x));
    return -1;
  }

  const tituloDo = (i) => {
    for (const h of trilho.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (blocoDe(h) === i && h.getClientRects().length) return h;
    }
    return null;
  };

  function aplicar() {
    janela = null;
    const b = blocos[atual];
    const H = palco.clientHeight;
    const ini = Math.max(0, b.ini - FOLGA);
    const altura = trilho.offsetHeight;
    // A troca de bloco é instantânea: sem transições herdadas (ex.: "transition: all" do modo
    // prefers-reduced-motion do product.css), senão o foco iria para um título ainda "hidden".
    trilho.classList.add("pg-sem-transicao");
    trilho.style.transform = `translateY(${-ini}px)`;
    // Recorte nas bordas do bloco com FOLGA, mas sem mostrar pedaço de linha do bloco vizinho: um
    // elemento dividido entre linhas fica visível nos dois blocos, e a FOLGA revelaria 8 px da linha
    // anterior/seguinte (linha parcialmente recortada, achado do teste de reflow em 320x256).
    const ant = blocos[atual - 1], seg = blocos[atual + 1];
    const topo = ant ? Math.max(ini, Math.min(b.ini, ant.fim)) : ini;
    const fimVis = Math.min(seg ? Math.min(b.fim + FOLGA, Math.max(b.fim, seg.ini)) : b.fim + FOLGA, ini + H);
    const baixo = Math.max(0, altura - fimVis);
    trilho.style.clipPath = `inset(${topo}px -16px ${baixo}px -16px)`;
    for (const a of atomos) a.toggleAttribute("data-pg-fora", !blocosDe.get(a).has(atual));
    void getComputedStyle(trilho).transform; // aplica o estilo já sem transição
    for (const a of atomos) void getComputedStyle(a).visibility;
    trilho.classList.remove("pg-sem-transicao");
    const n = blocos.length;
    resumo.textContent = `Bloco ${atual + 1} de ${n}`;
    ajustarRotulos(n);
    btnAnt.setAttribute("aria-disabled", String(atual === 0));
    btnProx.setAttribute("aria-disabled", String(atual === n - 1));
    montarLista();
    main.setAttribute("data-pg-atual", String(atual + 1));
    main.setAttribute("data-pg-total", String(n));
  }

  // Mede se os controles cabem com os rótulos por extenso (pior caso do resumo: "Bloco N de N"); se
  // não cabem, usa os rótulos curtos. Decisão por medição real da fonte/largura, não por breakpoint.
  function ajustarRotulos(n) {
    const texto = resumo.textContent;
    nav.classList.remove("pg-curtos");
    resumo.textContent = `Bloco ${n} de ${n}`;
    const r = nav.getBoundingClientRect();
    const cs = getComputedStyle(nav);
    const esq = r.left + parseFloat(cs.paddingLeft) - 0.5, dir = r.right - parseFloat(cs.paddingRight) + 0.5;
    const cabe = nav.scrollWidth <= nav.clientWidth && [btnAnt, resumo, btnProx].every((e) => e.scrollWidth <= e.clientWidth) &&
      [btnAnt, resumo, btnProx].every((e) => { const b = e.getBoundingClientRect(); return b.left >= esq && b.right <= dir; });
    if (!cabe) nav.classList.add("pg-curtos");
    resumo.textContent = texto;
  }

  // Quantos alvos de 44 px cabem no índice: colunas pela largura (mesma conta do auto-fill do CSS:
  // largura min(100% - 16px, 400px), padding 8, borda 1, vão 4) e linhas pela altura acima dos controles.
  function capacidade() {
    const r = nav.getBoundingClientRect();
    const larg = Math.min(r.width - 16, 400);
    const cols = Math.max(1, Math.floor((larg - 18 + 4) / 48));
    const linhasCabem = Math.max(1, Math.floor((r.top - 6 - 8 - 18 + 4) / 48));
    return Math.max(3, cols * linhasCabem);
  }
  function montarLista() {
    const ativo = document.activeElement;
    const focoJanela = ativo && lista.contains(ativo) && ativo.matches(".pg-janela") ? ativo.dataset.pgDir : null;
    lista.textContent = "";
    const n = blocos.length, cap = capacidade();
    const vagas = n <= cap ? n : cap - 2;
    let ini = 0;
    if (n > cap) {
      ini = janela !== null ? janela : Math.floor(atual / vagas) * vagas;
      ini = Math.min(Math.max(ini, 0), Math.max(0, n - vagas));
    }
    const fim = Math.min(n, ini + vagas);
    const botaoJanela = (dir, de, ate, ativoB) => {
      const li = novo("li");
      const b = novo("button", "pg-janela", { type: "button", "data-pg-dir": dir, "aria-disabled": String(!ativoB),
        "aria-label": ativoB ? `Blocos ${de} a ${ate}` : (dir < 0 ? "Sem blocos anteriores" : "Sem blocos seguintes") });
      b.innerHTML = `<span aria-hidden="true">${dir < 0 ? "‹" : "›"}</span>`;
      li.appendChild(b);
      lista.appendChild(li);
      return b;
    };
    if (n > cap) botaoJanela("-1", Math.max(1, ini - vagas + 1), ini, ini > 0);
    for (let i = ini; i < fim; i++) {
      const li = novo("li");
      const a = novo("a", "", { href: `#${PREFIXO}${i + 1}` });
      const h = tituloDo(i);
      a.innerHTML = `<span aria-hidden="true">${i + 1}</span>`;
      const sr = novo("span", "pg-sr");
      sr.textContent = `Bloco ${i + 1}${h ? ": " + h.textContent.trim().replace(/\s+/g, " ") : ""}`;
      a.appendChild(sr);
      if (i === atual) a.setAttribute("aria-current", "true");
      li.appendChild(a);
      lista.appendChild(li);
    }
    if (n > cap) botaoJanela("1", fim + 1, Math.min(n, fim + vagas), fim < n);
    if (focoJanela) lista.querySelector(`.pg-janela[data-pg-dir="${focoJanela}"]`)?.focus({ preventScroll: true });
    lista.dataset.pgIni = String(ini + 1);
    lista.dataset.pgFim = String(fim);
  }

  // Recalcula mantendo na tela o elemento em foco (ou o primeiro átomo visível).
  function paginar() {
    const ativo = document.activeElement;
    let ancora = ativo && trilho.contains(ativo) ? ativo : atomos.find((a) => blocosDe.get(a)?.has(atual));
    const m = querCorpo() ? "corpo" : "main";
    if (m !== modo) {
      if (modo !== null) desmontar();
      montar(m);
      // Mover nós tira o foco: devolve ao mesmo elemento, sem rolar.
      if (ativo && ativo !== document.body && ativo.isConnected && document.activeElement !== ativo) ativo.focus({ preventScroll: true });
    }
    const H = palco.clientHeight - 2 * FOLGA;
    if (H <= 0) return; // sem altura ainda: o ResizeObserver chama de novo quando houver
    main.style.setProperty("--pg-util", H + "px");
    medir(H);
    versao++;
    // Link profundo #bloco-N ainda não "consumido" pelo leitor: continua valendo após o reflow.
    const i = intencao !== null ? intencao : blocoDe(ancora);
    atual = Math.min(Math.max(i >= 0 ? i : atual, 0), blocos.length - 1);
    aplicar();
    main.setAttribute("data-pg-versao", String(versao));
    // Link profundo da carga que chegou antes da primeira medição válida: aplica agora.
    if (hashPendente) { hashPendente = false; irParaHash(false); }
  }

  function focar(el) {
    if (!el) return;
    if (!el.matches("a[href],button,input,select,textarea,summary,[tabindex]")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }

  function ir(i, { foco = true, hash = true, alvo = null } = {}) {
    intencao = null;
    if (!blocos.length) return;
    const n = blocos.length;
    i = Math.min(Math.max(i, 0), n - 1);
    const mudou = i !== atual;
    atual = i;
    aplicar();
    // Transição curta só por opacidade (sem deslocamento) e nenhuma com prefers-reduced-motion.
    if (mudou && !reduzir.matches && palco.animate) palco.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    if (hash) history.replaceState(null, "", `#${PREFIXO}${i + 1}`);
    const h = tituloDo(i);
    if (foco) {
      if (alvo) focar(alvo);
      else if (h) focar(h);
      else { palco.setAttribute("tabindex", "-1"); palco.focus({ preventScroll: true }); }
    }
    if (mudou || foco) anuncio.textContent = `Bloco ${i + 1} de ${n}${h ? ": " + h.textContent.trim().replace(/\s+/g, " ") : ""}`;
  }

  function irParaHash(foco) {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return false;
    if (!blocos.length) { hashPendente = true; return false; }
    const m = id.match(/^bloco-(\d+)$/);
    if (m) { ir(Number(m[1]) - 1, { foco, hash: false }); if (!foco) intencao = Number(m[1]) - 1; return true; }
    const alvo = document.getElementById(id);
    if (!alvo || !trilho.contains(alvo)) return false;
    const i = blocoDe(alvo);
    if (i < 0) return false;
    ir(i, { foco, hash: false, alvo });
    return true;
  }

  btnAnt.addEventListener("click", () => { if (atual > 0) ir(atual - 1); });
  btnProx.addEventListener("click", () => { if (atual < blocos.length - 1) ir(atual + 1); });
  lista.addEventListener("click", (e) => {
    const b = e.target.closest(".pg-janela");
    if (b) {
      if (b.getAttribute("aria-disabled") === "true") return;
      const n = blocos.length, vagas = capacidade() - 2;
      const ini = Number(lista.dataset.pgIni) - 1;
      janela = Math.min(Math.max(ini + Number(b.dataset.pgDir) * vagas, 0), Math.max(0, n - vagas));
      montarLista();
      return;
    }
    const a = e.target.closest("a[href^='#']");
    if (!a) return;
    e.preventDefault();
    indice.open = false;
    ir(Number(a.getAttribute("href").slice(1 + PREFIXO.length)) - 1);
  });
  indice.addEventListener("toggle", () => { if (indice.open) { janela = null; montarLista(); } });
  indice.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && indice.open) { indice.open = false; resumo.focus(); e.stopPropagation(); }
  });
  // Âncoras internas (#como-funciona, sumário etc.) abrem o bloco que contém o alvo.
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href^='#']");
    if (!a || nav.contains(a) || e.defaultPrevented) return;
    const id = decodeURIComponent(a.getAttribute("href").slice(1));
    const alvo = id && document.getElementById(id);
    if (!alvo || !trilho.contains(alvo)) return;
    e.preventDefault();
    const i = blocoDe(alvo);
    if (i >= 0) { ir(i, { hash: false, alvo }); history.replaceState(null, "", "#" + id); }
  });
  window.addEventListener("hashchange", () => irParaHash(true));
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && t.closest && t.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")) return;
    let i = null;
    if (e.key === "PageDown" || e.key === "ArrowRight") i = atual + 1;
    else if (e.key === "PageUp" || e.key === "ArrowLeft") i = atual - 1;
    else if (e.key === "Home" && !e.shiftKey) i = 0;
    else if (e.key === "End" && !e.shiftKey) i = blocos.length - 1;
    if (i === null) return;
    e.preventDefault();
    if (i >= 0 && i < blocos.length && i !== atual) ir(i);
  });

  let pendente = 0;
  const agendar = () => { if (!pendente) pendente = requestAnimationFrame(() => { pendente = 0; paginar(); }); };
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(agendar);
    ro.observe(palco);
    ro.observe(trilho);
  }
  window.addEventListener("resize", agendar);
  document.addEventListener("toggle", (e) => { if (trilho.contains(e.target)) agendar(); }, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(agendar);

  paginar();
  if (location.hash) irParaHash(false);
  main.setAttribute("data-pg-pronto", "");
})();
