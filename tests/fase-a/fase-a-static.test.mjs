// P01 Fase A: auditoria estática das 3 páginas de lista de espera (geradas em pasta temporária com
// --preview --no-audit, para que as asserções DESTE teste, e não a do gerador, matem os mutantes).
// ZEVANORY_FASE_A_TPL (mutantes) troca o modelo usado pelo gerador.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pythonOk, runPython } from "../../scripts/fase_a/tools.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAITLIST_NICHES, CONSENT_VERSION, RETENTION, AVISO_VERSION } from "../../worker/waitlist.mjs";
import { WAITLIST_PAGES } from "../../worker/waitlist-public.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fase-a-nichos.json"), "utf8"));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-static-"));
const build = pythonOk([path.join(ROOT, "scripts", "fase_a", "build_fase_a.py"), "--out", OUT, "--preview", "--no-audit"]);
const PAGES = Object.fromEntries(DATA.nichos.map((n) => [n.slug, fs.readFileSync(path.join(OUT, n.page + ".html"), "utf8")]));
const mainText = (html) => (html.match(/<main[\s\S]*<\/main>/) || [""])[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const skeleton = (html, slug) => (html.split("/" + slug + ".css").join("/{nicho}.css").match(/<[^>]+>/g) || []).map((t) => t.replace(/\s(content|value|data-fase-a-nicho|data-consent-version)="[^"]*"/g, ' $1=""')).join("");

test("gera exatamente as 3 páginas dos nichos aprovados, com os mesmos slugs no backend e nas rotas", () => {
  assert.match(build, /FASE_A_PAGES=PREVIEW/);
  assert.deepEqual(DATA.nichos.map((n) => n.slug), [...WAITLIST_NICHES]);
  assert.deepEqual(Object.keys(WAITLIST_PAGES), [...WAITLIST_NICHES]);
  for (const n of DATA.nichos) assert.equal(WAITLIST_PAGES[n.slug], n.page);
  assert.deepEqual(fs.readdirSync(OUT).filter((f) => f.endsWith(".html")).sort(), DATA.nichos.map((n) => n.page + ".html").sort());
});

test("NO-GO (P13): nenhum link /comprar/ e nenhum schema.org InStock/Offer", () => {
  for (const [slug, html] of Object.entries(PAGES)) {
    assert.doesNotMatch(html, /\/comprar\//i, slug);
    assert.doesNotMatch(html, /schema\.org\/InStock/i, slug);
    assert.doesNotMatch(html, /"offers"|application\/ld\+json/i, slug);
    assert.doesNotMatch(html, /mercadopago|hotmart|pay\.|checkout/i, slug);
  }
});

test("consentimento LGPD: caixa da lista obrigatória e DESMARCADA; convite para entrevista separado, OPCIONAL e desmarcado", () => {
  for (const [slug, html] of Object.entries(PAGES)) {
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) || [];
    assert.equal(boxes.length, 2, slug);
    const [consentBox] = boxes.filter((b) => /name="consentimento"/.test(b));
    const [interviewBox] = boxes.filter((b) => /name="entrevista"/.test(b));
    assert.ok(consentBox && interviewBox, slug);
    assert.match(consentBox, /\brequired\b/);
    assert.doesNotMatch(interviewBox, /\brequired\b/, slug + ": entrevista não pode ser obrigatória");
    for (const b of boxes) assert.doesNotMatch(b, /\bchecked\b/, slug + ": caixa pré-marcada");
    assert.doesNotMatch(html, /<input[^>]*\bchecked\b/, slug + ": algum campo pré-marcado");
    const labels = html.match(/<label class="lead-consent[^"]*"[\s\S]*?<\/label>/g) || [];
    assert.equal(labels.length, 2);
    const [consent, interview] = labels;
    for (const must of ["A. Renan Alves Moreira Bitu Ltda", "CNPJ 69.077.233/0001-99", "avisado(a) se as vendas deste kit abrirem", "só para esse aviso", "30 dias após a decisão deste teste", "no máximo 12 meses", "8 dias", 'href="/lista-de-espera/sair"', 'href="/privacidade"'])
      assert.ok(consent.includes(must), `${slug}: consentimento sem "${must}"`);
    assert.doesNotMatch(consent, /conversa|entrevista/, slug + ": a finalidade da lista não pode incluir a entrevista");
    assert.ok(interview.includes("Opcional") && interview.includes("não depende disso"), slug);
    assert.ok(consent.includes(`data-consent-version="${CONSENT_VERSION}"`), slug + ": versão do texto diferente da gravada pelo backend");
  }
});

test("aviso de medição ANTES da coleta (AVAL 101): bloco no topo com controlador, finalidade, dados, duração, operadores, política e botão de não participação; único gatilho de medição no FIM do aviso", () => {
  for (const [slug, html] of Object.entries(PAGES)) {
    const block = (html.match(/<section class="container wl-medicao"[\s\S]*?<\/section>/) || [""])[0];
    assert.ok(block, slug + ": bloco do aviso");
    assert.ok(html.indexOf("wl-medicao") < html.indexOf("catalog-hero") && html.indexOf("wl-medicao") < html.indexOf("wl-form"), slug + ": aviso antes do conteúdo e do formulário");
    const aviso = (block.match(/<p class="lead-note wl-aviso">[\s\S]*?<\/p>/) || [""])[0];
    for (const must of ["A. Renan Alves Moreira Bitu Ltda (CNPJ 69.077.233/0001-99), controladora", "navegadores/dispositivos", "A medição começa só depois que este aviso é exibido", "identificador aleatório", "cookie próprio",
      "expira no fim do período de teste", "código pseudônimo", "conta navegadores, não pessoas", "Seu IP e os dados do navegador são usados só na hora, para afastar robôs, e não são guardados",
      "Cloudflare e Neon", "legítimo interesse (LGPD, art. 7º, IX)", "seu pedido, fim do teste sem continuidade, 30 dias após a decisão ou 60 dias após o fim do teste", "suporte@zevanory.api.br", 'href="/privacidade"'])
      assert.ok(aviso.includes(must), `${slug}: aviso sem "${must}"`);
    assert.doesNotMatch(aviso, /180 dias|pessoa uma vez|código pseudônimo diário|guardados em claro|encarregad/i, slug + ": texto antigo");
    assert.ok(block.includes('<form class="wl-nao-participar" method="post" action="/lista-de-espera/nao-participar"><button class="button" type="submit">Não participar da medição</button></form>'), slug + ": botão de não participação no aviso");
    assert.ok(block.includes('href="/lista-de-espera/meus-dados"'), slug + ": ação local do titular");
    assert.ok(block.endsWith(`<link rel="stylesheet" href="/lista-de-espera/a/${slug}.css?aviso=${AVISO_VERSION}"></section>`), slug + ": gatilho no fim do aviso, com a versão do backend");
    assert.ok(block.includes(`data-aviso-version="${AVISO_VERSION}"`));
    assert.equal(html.split("/lista-de-espera/a/").length - 1, 1, slug + ": um único gatilho");
    assert.ok(!html.includes("/lista-de-espera/c/"), slug + ": confirmação só via @import da folha do aviso");
    assert.doesNotMatch(html.match(/<head>[\s\S]*<\/head>/)[0], /lista-de-espera/, slug + ": nada de medição no <head>");
  }
  assert.deepEqual({ ...RETENTION }, { afterDecisionDays: 30, afterWindowCloseDays: 60, signupMaxMonths: 12, cookieMaxDays: 60 }, "texto e código com os mesmos prazos");
});

test("formulário: só lista de espera (contato obrigatório, nome opcional, nicho fixo, 2 perguntas sim/não, honeypot)", () => {
  for (const n of DATA.nichos) {
    const html = PAGES[n.slug];
    assert.equal((html.match(/<form\b/g) || []).length, 2, "lista de espera + não participar da medição");
    assert.equal((html.match(/<form class="wl-nao-participar"[^>]*>[\s\S]*?<\/form>/)[0].match(/<input\b/g) || []).length, 0, "não participar não coleta nada");
    assert.match(html, /<form class="lead-form wl-form" method="post" action="\/lista-de-espera\/inscrever">/);
    assert.ok(html.includes(`<input type="hidden" name="nicho" value="${n.slug}">`));
    assert.match(html, /<input id="wl-contato" name="contato" type="text" required/);
    assert.match(html, /<input id="wl-nome" name="nome" type="text" autocomplete="given-name" maxlength="60">/);
    assert.equal((html.match(/type="radio" name="q1"/g) || []).length, 2);
    assert.equal((html.match(/type="radio" name="q2"/g) || []).length, 2);
    assert.ok(html.includes(`<legend>${n.q_recurring}</legend>`) && html.includes(`<legend>${DATA.q_digital}</legend>`));
    assert.match(html, /name="website" type="text" tabindex="-1"/);
    assert.doesNotMatch(html, /type="(password|tel|number)"|name="(cpf|cartao|card)/i);
  }
});

test("mesmo modelo nos 3 nichos: estrutura idêntica, mesmas contagens e textos de tamanho equivalente (±10%)", () => {
  const sk = Object.entries(PAGES).map(([slug, h]) => skeleton(h, slug));
  assert.equal(new Set(sk).size, 1, "estrutura HTML diferente entre nichos");
  for (const n of DATA.nichos) assert.equal(n.items.length, 4, n.slug);
  const own = DATA.nichos.map((n) => [n.product, n.h1, n.intro, n.q_recurring, ...n.items].join(" ").length);
  const total = Object.values(PAGES).map((h) => mainText(h).length);
  for (const arr of [own, total]) assert.ok(Math.max(...arr) / Math.min(...arr) <= 1.10, "tamanhos: " + arr.join(","));
});

test("preço indicativo e sem promessas: R$ 37 pré-lançamento, sem faturamento/resultado, urgência, escassez ou alegação regulada", () => {
  const banned = [/garant/i, /fatur(e|ar|amento) (mais|em dobro)/i, /aumente (suas|as) vendas/i, /lucr(e|o) (mais|garantido)/i, /resultado(s)? (garantido|em \d)/i, /em \d+ dias você/i,
    /últimas vagas|vagas limitadas|só hoje|corra|imperdível|acaba (hoje|em)|oferta por tempo|restam \d/i, /desconto/i, /cura|emagrec|tratamento (capilar|de pele)|terapêut|anvisa|médic/i];
  for (const [slug, html] of Object.entries(PAGES)) {
    assert.ok(html.includes(DATA.price_label), slug);
    assert.equal(DATA.price_label, "R$ 37 (pré-lançamento — vendas ainda fechadas)");
    const text = mainText(html).replace("Não prometemos aumento de vendas nem de faturamento.", "");
    for (const re of banned) assert.doesNotMatch(text, re, `${slug}: ${re}`);
    assert.ok(text.includes("Não pedimos pagamento") && text.includes("não é compra"), slug);
  }
});

test("fora do ar por padrão: noindex, fora da navegação/sitemap/rotas fixas, bandeira ausente nos Workers e build desligado não escreve nada", () => {
  for (const html of Object.values(PAGES)) assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  const sp = path.join(ROOT, "sales-public");
  for (const f of fs.readdirSync(sp).filter((x) => x.endsWith(".html"))) {
    assert.doesNotMatch(f, /^lista-de-espera/, "página da Fase A dentro dos assets publicados");
    assert.doesNotMatch(fs.readFileSync(path.join(sp, f), "utf8"), /href="[^"]*lista-de-espera/, f + " linka a lista de espera");
  }
  for (const f of ["sitemap.xml", "index.html", path.join("sales-public", "llms.txt")]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /lista-de-espera/, f);
  const worker = fs.readFileSync(path.join(ROOT, "worker", "sales-public-worker.mjs"), "utf8");
  assert.doesNotMatch(worker.match(/const htmlRoutes=new Set\(\[[^\]]*\]\)/)[0], /lista-de-espera/);
  for (const f of fs.readdirSync(ROOT).filter((x) => /^wrangler.*\.toml$/.test(x))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /FASE_A_WAITLIST/, f + " liga a bandeira");
  const off = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-off-"));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }; delete env.ZEVANORY_FASE_A_PAGES;
  assert.match(pythonOk([path.join(ROOT, "scripts", "fase_a", "build_fase_a.py"), "--out", off], { env }), /FASE_A_PAGES=OFF/);
  assert.deepEqual(fs.readdirSync(off), []);
  assert.notEqual(runPython([path.join(ROOT, "scripts", "fase_a", "build_fase_a.py"), "--out", sp, "--preview"], { env }).status, 0, "preview nunca escreve em sales-public/");
  assert.notEqual(runPython([path.join(ROOT, "scripts", "fase_a", "build_fase_a.py"), "--out", off], { env: { ...env, ZEVANORY_FASE_A_PAGES: "on" } }).status, 0, "lançamento sem a seção da política é bloqueado");
});

test("CSP e acessibilidade básica: sem script/estilo inline, lang pt-BR, rótulos para todos os campos, paginação P03", () => {
  for (const [slug, html] of Object.entries(PAGES)) {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, slug);
    assert.doesNotMatch(html, /\sstyle="/, slug);
    assert.match(html, /<html lang="pt-BR">/);
    for (const id of ["wl-contato", "wl-nome", "wl-site"]) assert.ok(html.includes(`<label for="${id}">`), `${slug}: rótulo de ${id}`);
    assert.equal((html.match(/href="\/paginacao\.css"/g) || []).length, 1);
    assert.equal((html.match(/src="\/paginacao\.js"/g) || []).length, 1);
  }
});
