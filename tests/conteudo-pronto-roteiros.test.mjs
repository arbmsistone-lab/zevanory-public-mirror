// Conteúdo Pronto: roteiros multicanal no lugar de mensagens de WhatsApp (schema versionado).
// A conta WhatsApp Business da ZEVANORY foi banida pela Meta; a oferta e o gerador não podem mais
// prometer nem produzir mensagens de WhatsApp. Este teste amarra, pelo contrato versionado
// data/politica-unica.json (conteudo_pronto + resumo_oferta.assinatura.caracteristicas):
//   (a) o texto canônico da oferta (literal, oráculo deste teste) e o contrato da versão 2;
//   (b) a página-fonte /conteudo-pronto, o catálogo /solucoes, o suporte e as páginas geradas;
//   (c) a SAÍDA do gerador (worker/content-service.mjs): schema, versão, quantidades, objetivos na
//       ordem do contrato, versão curta + versão de e-mail, calendário — e o prompt da IA;
//   (d) a guarda: "WhatsApp" não aparece na oferta, nas fontes do produto, no prompt, no e-mail de
//       boas-vindas, no formulário, no pacote em texto nem no HTML entregue.
//   (f) leitura de pacote gravado (v1 ou qualquer outro): se um campo exibido citar canal banido ou o número
//       banido, o pacote é BLOQUEADO (não exibido nem reenviado), os bytes gravados ficam intactos e o
//       assinante ativo pode gerar uma versão nova sem custo (chave nova). Escolha documentada em
//       worker/content-service.mjs (packageBlocked) e em data/politica-unica.json (conteudo_pronto.nota).
//   (e) TODA página/texto do repositório que descreve o Conteúdo Pronto (guias ia-para-*, kit,
//       llms.txt, catálogo, fontes e geradas) diz "N posts e N roteiros multicanal", sem mensagens.
// Qualquer mudança de quantidade, objetivo, canal ou texto exige subir content_schema_version e
// registrar a impressão digital nova em CONTRACT_FINGERPRINTS (revisão explícita).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import * as CS from "../worker/content-service.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { openSalesHtml } from "../worker/sales-public-worker.mjs";
import { cpSalesEnabled } from "../worker/nc015-sales-scope.mjs";
import { CAMPAIGN, campaignize } from "./helpers/cp-campaign.mjs";

const CP_CARD = /<article class="catalog-card[^"]*" id="p-conteudo-pronto"[^>]*>[\s\S]*?<\/article>/;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readTextNormalized(join(ROOT, rel));
const P = JSON.parse(read("data/politica-unica.json"));
const C = P.conteudo_pronto;
const CARACT = P.resumo_oferta.assinatura.caracteristicas;
const WA = /whats\s*app/i;
// O nome do asset de contato (/whatsapp-contact.js, só e-mail desde o banimento; ver
// tests/contato-publico-whatsapp.test.mjs) não é promessa de canal: fica fora da guarda.
const noAsset = (html) => html.replace(/<script src="\/whatsapp-contact\.js" defer><\/script>/g, "");

const CANONICAL = "Todo mês, uma campanha de promoção de vendas da oferta que você escolher: no formulário do mês você informa o objetivo comercial, o produto, serviço ou oferta, a condição comercial e o período (de 7 a 30 dias). A campanha traz 12 posts com legenda, 4 roteiros multicanal de venda e acompanhamento — cada um com versão curta e versão de e-mail — e um calendário com as datas do período, todos sobre essa oferta e no tom do seu negócio. Os roteiros são para canais autorizados pelo cliente, como e-mail, Instagram Direct, Telegram ou chat do site. Você revisa antes de usar; não há disparo automático.";
const OBJECTIVE_IDS = ["oferta_solicitada", "acompanhamento", "reativacao", "indicacao"];
// v2 ainda não foi publicada: a impressão digital registra o contrato final da v2 (com wa.me nos termos proibidos).
const CONTRACT_FINGERPRINTS = { 2: "5a6a0d0c1fee4716dcf78f16a177337ec8c21c96bb973ed3998b279d19491498", 3: "d61bf299e117c0ce87fa21f5e71b223ae8e399d0e51141c18136b08f4a347a85" };
const fingerprint = () => {
  const { nota, ...contrato } = C;
  return createHash("sha256").update(JSON.stringify({ contrato, caracteristicas: CARACT })).digest("hex");
};

// IA falsa: devolve posts e roteiros válidos e grava os prompts recebidos.
const post = (i) => ({ tema: "Tema " + i, legenda: "Legenda completa e concreta para o negócio, explicando o benefício real do serviço sem promessas exageradas. ".repeat(3), cta: "Chame no Direct", hashtags: ["#negocio", "#local"], imagem: "foto da equipe" });
const roteiro = (o, extra = {}) => ({ objetivo_id: o.id, curta: "Olá! Aqui é do negócio. Passando para lembrar da nossa oferta principal e tirar qualquer dúvida que você tenha.", email: { assunto: "Sobre o que você pediu", corpo: "Olá! Obrigado pelo contato. ".repeat(10) + "Se fizer sentido, responda este e-mail e combinamos o próximo passo." }, ...extra });
function fakeAI() {
  const prompts = [];
  return { prompts, run: async (_m, { messages }) => { const u = messages[1].content; prompts.push(u); return { response: JSON.stringify(campaignize(u, u.includes("roteiros multicanal") ? { roteiros: CS.ROTEIRO_OBJETIVOS.map((o) => roteiro(o)) } : { posts: [1, 2, 3, 4, 5, 6].map(post) })) }; } };
}
const BRIEF = { negocio: "Salão Bela", ramo: "salão de beleza", publico: "mulheres 25-50", produtos: "corte, escova", diferencial: "atendimento rápido", tom: "próximo", contato: "e-mail e Instagram Direct" };

test("(a) oferta canônica e contrato v2: texto literal, quantidades e os quatro objetivos", () => {
  assert.equal(CARACT, CANONICAL, "características essenciais = texto canônico do auditor");
  assert.equal(C.content_schema_version, 3, "[schema-version] contrato na versão 3 do oráculo");
  assert.equal(C.package_schema, "zpc.cp.package.v3");
  // v3 (Sol AVAL 304): campanha mensal de promoção de vendas, com os cinco campos obrigatórios e seis fases.
  assert.equal(C.servico, "campanha mensal de promoção de vendas", "[campanha] serviço");
  assert.deepEqual(C.campanha.campos.map((f) => f.id), ["objetivo_comercial", "oferta", "condicao_comercial", "periodo_inicio", "periodo_fim"], "[campanha] campos obrigatórios");
  assert.equal(C.campanha.fases.length, 6, "[campanha] fases");
  for (const k of ["campanha de promoção de vendas", "objetivo comercial", "condição comercial", `período (de ${C.campanha.periodo_dias_min} a ${C.campanha.periodo_dias_max} dias)`, "todos sobre essa oferta"]) assert.ok(CARACT.includes(k), "[campanha] oferta descreve: " + k);
  for (const k of ["descricao_fiscal_proposta", "descricao_hotmart_proposta"]) assert.match(C[k], /campanha mensal de promoção de vendas/i, "[campanha] " + k);
  assert.equal(CONTRACT_FINGERPRINTS[C.content_schema_version], fingerprint(), "contrato mudou: suba content_schema_version e registre a impressão digital nova");
  assert.deepEqual(C.objetivos.map((o) => o.id), OBJECTIVE_IDS, "[objetivos] ids e ordem do contrato");
  assert.deepEqual(C.versoes_roteiro, ["curta", "email"]);
  const reat = C.objetivos.find((o) => o.id === "reativacao").regra;
  assert.match(reat, /somente/, "[reativacao]");
  assert.match(reat, /relacionamento ativo/, "[reativacao]");
  assert.match(reat, /consentimento registrado/, "[reativacao]");
  // O texto da oferta descreve exatamente o que o contrato manda gerar.
  assert.ok(CARACT.includes(`${C.posts} posts com legenda`));
  assert.ok(CARACT.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`));
  assert.ok(CARACT.includes("versão curta e versão de e-mail"));
  assert.ok(CARACT.includes("calendário com as datas do período"));
  const canais = C.canais_autorizados_exemplo;
  assert.ok(CARACT.includes(`canais autorizados pelo cliente, como ${canais.slice(0, -1).join(", ")} ou ${canais.at(-1)}`));
  assert.ok(CARACT.includes("não há disparo automático"));
  for (const [k, v] of Object.entries(C)) if (k !== "termos_proibidos_regex" && k !== "nota") assert.doesNotMatch(JSON.stringify(v), WA, "contrato sem WhatsApp: " + k);
});

// Auditoria #955 C7/C9: frases de promessa (resultado, venda, prazo de entrega) só passam numa frase com negação.
const FAQ_PROMESSA = /garant|asseguramos|com certeza|vender mais|mais vendas|aument\w* (?:as |suas )?vendas|resultado garantido|entrega (?:é )?garantida|em (?:até )?\d+ (?:minutos?|horas?)/i;
function* faqAnswers(html) {
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of ld) {
    const data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ""));
    for (const node of data["@graph"] || [data]) if (node["@type"] === "FAQPage") for (const q of node.mainEntity || []) yield String(q.acceptedAnswer?.text || "");
  }
  for (const m of html.matchAll(/<details><summary>[\s\S]*?<\/summary><p>([\s\S]*?)<\/p><\/details>/g)) yield m[1].replace(/<[^>]+>/g, "");
}
// NC-012: obsolete KV-only link TTL probe retired. The DO link contract is in scripts/cp-g03-g04-candidate.test.mjs.
// DEC-04 (fase 1): o CP está oculto. A página-fonte e a gerada são a lápide (noindex,nofollow, sem preço, sem oferta,
// sem assinatura, sem WhatsApp, inalterada pelo interruptor) e o catálogo não tem o cartão do CP. O contrato completo
// abaixo volta a valer quando cpSalesEnabled() for ligado por mudança auditada.
function assertCpTombstone() {
  for (const rel of ["conteudo-pronto/index.html", "sales-public/conteudo-pronto.html"]) {
    const html = read(rel);
    assert.match(html, /<meta name="robots" content="noindex,nofollow">/, "[dec04] lápide noindex: " + rel);
    assert.match(html, /<h1>Página indisponível<\/h1>/, "[dec04] lápide: " + rel);
    assert.doesNotMatch(html, WA, "[dec04] sem WhatsApp: " + rel);
    assert.doesNotMatch(html, /R\$|data-zev-sub|data-offer-summary|"@type":\s*"(?:Offer|Service)"|\/assinar\/|pay\.hotmart\.com/, "[dec04] sem oferta: " + rel);
    assert.equal(openSalesHtml(html, "conteudo-pronto"), html, "[dec04] interruptor de vendas não reabre o CP: " + rel);
  }
  for (const rel of ["solucoes/index.html", "sales-public/solucoes.html", "sales-public/index.html"]) assert.doesNotMatch(read(rel), CP_CARD, "[dec04] catálogo sem o cartão do CP: " + rel);
}
test("(b) página-fonte, catálogo, suporte e páginas geradas seguem o contrato e não prometem WhatsApp", async () => {
  if (!cpSalesEnabled()) {
    assertCpTombstone();
    // O atendimento continua descrevendo o serviço (pedidos antigos) sem WhatsApp e no contrato multicanal.
    const sup = SUPPORT_PRODUCTS["conteudo-pronto"].content;
    assert.doesNotMatch(sup, WA, "[suporte]");
    assert.ok(sup.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`) && sup.includes("versão curta e versão de e-mail") && sup.includes("não há disparo automático"));
    assert.match(sup, /a equipe da ZEVANORY é avisada/, "[p24-prazo] atendimento");
    assert.doesNotMatch(sup, /poucos minutos/, "[p24-prazo] atendimento sem prazo não medido");
    return;
  }
  const src = read("conteudo-pronto/index.html");
  assert.doesNotMatch(src, WA, "conteudo-pronto/index.html");
  assert.equal(src.match(/data-content-schema="(\d+)"/)?.[1], String(C.content_schema_version), "página e gerador na mesma versão de schema");
  const ld = JSON.parse(src.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  assert.equal(ld["@graph"].find((n) => n["@type"] === "Service").description, CANONICAL, "JSON-LD = texto canônico");
  const meta = src.match(/<meta name="description" content="([^"]*)"/)[1];
  const hero = src.match(/<p class="hero-copy">([^<]*)<\/p>/)[1];
  const items = src.match(/<ul class="outcome-list" data-content-schema="\d+">([\s\S]*?)<\/ul>/)[1];
  for (const [name, text] of [["meta", meta], ["hero", hero], ["itens", items]]) {
    assert.ok(text.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`), name);
    assert.ok(text.includes(`${C.posts} posts com legenda`), name);
  }
  assert.ok(items.includes("versão curta e versão de e-mail"));
  for (const canal of C.canais_autorizados_exemplo) assert.ok(items.includes(canal), "canal autorizado listado: " + canal);
  for (const k of ["oferta solicitada", "acompanhamento de conversa existente", "reativação só com relacionamento ativo ou consentimento registrado", "pedido de indicação"]) assert.ok(items.includes(k), "objetivo na página: " + k);
  assert.match(hero, /não há disparo automático/);

  // Catálogo do #914: cada produto é um <article id="p-<slug>"> (antes, um <a class="catalog-card">).
  const card = read("solucoes/index.html").match(CP_CARD)[0];
  assert.doesNotMatch(card, WA, "[catalogo]");
  assert.ok(card.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`));

  const sup = SUPPORT_PRODUCTS["conteudo-pronto"].content;
  assert.doesNotMatch(sup, WA, "[suporte]");
  assert.ok(sup.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`) && sup.includes("versão curta e versão de e-mail") && sup.includes("não há disparo automático"));

  for (const slug of ["conteudo-pronto", "solucoes", "index"]) {
    const built = read(`sales-public/${slug}.html`);
    const block = slug === "conteudo-pronto" ? noAsset(built) : built.match(CP_CARD)[0];
    assert.doesNotMatch(block, WA, "gerado: " + slug);
    assert.ok(block.includes(`${C.roteiros} roteiros multicanal`), "gerado: " + slug);
  }
  const built = read("sales-public/conteudo-pronto.html");
  assert.equal(built.match(/<div data-field="caracteristicas"><dt>[^<]*<\/dt><dd>([^<]*)<\/dd>/)?.[1], CANONICAL, "Resumo da oferta gerado = texto canônico");
  assert.equal(built.match(/data-content-schema="(\d+)"/)?.[1], String(C.content_schema_version));
  assert.doesNotMatch(noAsset(openSalesHtml(built, "conteudo-pronto")), WA, "modo aberto (runtime) sem WhatsApp");
  // P24 CP-10/CP-13/CP-09/CP-18: recibo do hero = roteiros multicanal; prazo realista; validade do link declarada;
  // nenhuma garantia de "qualidade" ligada a vendas (CDC art. 37 §1). Vale para a fonte e para a página gerada.
  const receipt = built.match(/<div class="hero-panel receipt">[\s\S]*?<\/ul>/)?.[0] || "";
  assert.ok(receipt.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`), "[p24-recibo] recibo do hero com roteiros multicanal");
  for (const [rel, html] of [["conteudo-pronto/index.html", read("conteudo-pronto/index.html")], ["sales-public/conteudo-pronto.html", built]]) {
    assert.doesNotMatch(html, /4 mensagens/, "[p24-recibo] " + rel);
    assert.doesNotMatch(html, /garante constância|base para vender mais/, "[p24-garantia] " + rel);
    assert.doesNotMatch(html, /<li>Em poucos minutos/, "[p24-prazo] " + rel);
    assert.match(html, /tenta de novo automaticamente a cada hora, até 12 vezes, e a equipe da ZEVANORY é avisada/, "[p24-prazo] " + rel);
    assert.doesNotMatch(html, /poucos minutos|acompanha até a entrega/, "[p24-prazo] sem prazo não medido nem acompanhamento que o sistema não faz: " + rel);
    assert.doesNotMatch(html, /consultar quando quiser/, "[p24-link] " + rel);
    assert.match(html, /disponível por 120 dias/, "[p24-link] " + rel);
  }
  // A validade declarada é a do token do PACOTE (medida numa entrega real do gerador), não a de qualquer token.
  const days = Number(read("conteudo-pronto/index.html").match(/disponível por (\d+) dias/)[1]);
  assert.equal(CS.PACKAGE_LINK_DAYS, days, "[p24-link] link do pacote vale exatamente o que a página promete");
  assert.match(SUPPORT_PRODUCTS["conteudo-pronto"].content, /a equipe da ZEVANORY é avisada/, "[p24-prazo] atendimento");
  assert.doesNotMatch(SUPPORT_PRODUCTS["conteudo-pronto"].content, /poucos minutos/, "[p24-prazo] atendimento sem prazo não medido");
  // FAQ (FAQPage e <details>): nenhuma resposta promete resultado, venda ou prazo sem negação na mesma frase.
  for (const [rel, html] of [["conteudo-pronto/index.html", read("conteudo-pronto/index.html")], ["sales-public/conteudo-pronto.html", built]]) {
    const answers = [...faqAnswers(html)];
    assert.ok(answers.length >= 4, "[p24-faq-promessa] respostas encontradas: " + rel);
    for (const a of answers) for (const frase of a.split(/(?<=[.!?])\s+/)) {
      if (FAQ_PROMESSA.test(frase)) assert.match(frase, /\b(não|nenhuma?|sem)\b/i, `[p24-faq-promessa] ${rel}: "${frase}"`);
    }
  }
  for (const rel of ["kit-afiliado/index.html", "sales-public/kit-afiliado.html", "sales-overlay/llms.txt", "sales-public/llms.txt"]) {
    const lines = read(rel).split(/<li>|\n/).filter((l) => l.includes("Conteúdo Pronto") && /12 posts/.test(l));
    assert.ok(lines.length >= 1, rel);
    for (const l of lines) { assert.ok(l.includes("4 roteiros multicanal"), rel + ": " + l.slice(0, 80)); assert.doesNotMatch(l, /4 mensagens|whats\s*app/i, rel); }
  }
});

test("(c) saída do gerador = contrato: schema versionado, objetivos na ordem, curta + e-mail, calendário", async () => {
  assert.equal(CS.CONTENT_SCHEMA_VERSION, C.content_schema_version);
  assert.equal(CS.PACKAGE_SCHEMA, C.package_schema);
  const ai = fakeAI();
  const pkg = await CS.generatePackage({ AI: ai }, BRIEF, 3, CAMPAIGN);
  assert.ok(pkg, "pacote gerado");
  assert.equal(pkg.schema, C.package_schema);
  assert.equal(pkg.content_schema_version, C.content_schema_version, "[pkg-version]");
  assert.equal(pkg.cycle, 3);
  assert.equal(pkg.posts.length, C.posts);
  assert.equal(pkg.mensagens, undefined, "campo antigo 'mensagens' não é mais gerado");
  assert.equal(pkg.roteiros.length, C.roteiros);
  assert.deepEqual(pkg.roteiros.map((r) => r.objetivo_id), OBJECTIVE_IDS);
  assert.deepEqual(pkg.roteiros.map((r) => r.objetivo), C.objetivos.map((o) => o.titulo), "objetivo exibido vem do contrato");
  for (const r of pkg.roteiros) {
    assert.ok(r.curta.length >= 60, "versão curta");
    assert.ok(r.email.assunto.length >= 5 && r.email.corpo.length >= 200, "versão de e-mail");
  }
  assert.equal(pkg.calendario.length, C.posts + C.roteiros, "[calendario] posts + roteiros");
  assert.deepEqual(pkg.calendario.filter((c) => c.tipo === "roteiro").map((c) => c.tema), C.objetivos.map((o) => o.titulo));
  assert.deepEqual(new Set(pkg.calendario.map((c) => c.tipo)), new Set(["post", "roteiro"]));
  assert.ok(pkg.calendario.every((c, i, a) => c.dia >= 1 && c.dia <= C.calendario_dias && (i === 0 || a[i - 1].dia <= c.dia)));
  const prompt = ai.prompts.find((u) => u.includes("roteiros multicanal"));
  assert.ok(prompt, "prompt de roteiros enviado");
  assert.doesNotMatch(prompt, WA, "prompt sem WhatsApp");
  for (const o of C.objetivos) assert.ok(prompt.includes(`"${o.id}": ${o.regra}`), "prompt traz objetivo e regra: " + o.id);
  assert.ok(OBJECTIVE_IDS.map((id) => prompt.indexOf(`"${id}"`)).every((p, i, a) => i === 0 || a[i - 1] < p), "objetivos na ordem");
  for (const canal of C.canais_autorizados_exemplo) assert.ok(prompt.includes(canal), "prompt cita canal autorizado: " + canal);
  assert.match(prompt, /nada é enviado automaticamente/);
  assert.match(prompt, /versão curta/);
  assert.match(prompt, /versão de e-mail/);
});

test("(c2) validador: rejeita ordem trocada, falta de versão de e-mail, menos roteiros e canal banido", () => {
  const ok = CS.ROTEIRO_OBJETIVOS.map((o) => roteiro(o));
  assert.equal(CS.validateRoteiros(ok).length, 4);
  assert.equal(CS.validateRoteiros([ok[1], ok[0], ok[2], ok[3]]), null, "ordem dos objetivos");
  assert.equal(CS.validateRoteiros(ok.slice(0, 3)), null, "quatro roteiros");
  assert.equal(CS.validateRoteiros(ok.map((r) => ({ ...r, email: undefined }))), null, "versão de e-mail obrigatória");
  assert.equal(CS.validateRoteiros(ok.map((r) => ({ ...r, curta: "" }))), null, "versão curta obrigatória");
  for (const bad of ["Me chama no WhatsApp para fechar.", "Responda no whats app.", "Manda um zap!", "Vamos fazer um disparo em massa."]) {
    const list = ok.map((r, i) => (i === 2 ? { ...r, curta: r.curta + " " + bad } : r));
    assert.equal(CS.validateRoteiros(list), null, "termo proibido na curta: " + bad);
    const list2 = ok.map((r, i) => (i === 3 ? { ...r, email: { ...r.email, corpo: r.email.corpo + " " + bad } } : r));
    assert.equal(CS.validateRoteiros(list2), null, "termo proibido no e-mail: " + bad);
  }
  assert.equal(CS.validateRoteiros(ok.map((r, i) => (i === 0 ? { ...r, curta: r.curta + " Use o Zapier." } : r))).length, 4, "sem falso positivo");
});

test("(d) rotas NC-012 não publicam Conteúdo Pronto antes da outbox DO e preservam os textos seguros", async () => {
  assert.doesNotMatch(read("worker/content-service.mjs"), WA, "worker/content-service.mjs sem WhatsApp");
  const {routeBriefingNc011,routePackageNc011}=await import("../worker/cp-nc011-routing.mjs");
  const x=await routeBriefingNc011(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=invalid"),{});
  assert.equal(x.status,404);
  assert.doesNotMatch(await x.text(), WA);
  const y=routePackageNc011();
  assert.equal(y.status,503, "[pacote-503] nenhum pacote exibido antes da homologação da fase 2");
  assert.doesNotMatch(await y.text(), WA);
  // DEC-14: o formulário efetivo (cp-nc011-routing) renderiza os rótulos de CP_BRIEFING_FIELDS e CAMPANHA_CAMPOS.
  assert.doesNotMatch(CS.CP_BRIEFING_FIELDS.map((f) => f[1]).join("\n") + CS.CAMPANHA_CAMPOS.map((f) => f.rotulo).join("\n"), WA, "[form] rótulos do formulário sem WhatsApp");
  assert.match(CS.ROTEIROS_AVISO, /não há disparo automático/, "[aviso] sem disparo automático");
  assert.ok(CS.ROTEIROS_AVISO.includes("Use a reativação só com relacionamento ativo ou consentimento registrado."), "[aviso] regra de consentimento");
  // Pacote em texto (o que seria enviado por e-mail): formato atual, quatro versões de e-mail, sem WhatsApp.
  const pkg = await CS.generatePackage({ AI: fakeAI() }, BRIEF, 1, CAMPAIGN);
  const text = CS.packageText(pkg, BRIEF.negocio);
  assert.doesNotMatch(text, WA, "e-mail do pacote sem WhatsApp");
  assert.ok(text.includes(CS.ROTEIROS_TITULO) && CS.ROTEIROS_TITULO === `${C.roteiros} ROTEIROS MULTICANAL DE VENDA E ACOMPANHAMENTO`, "e-mail do pacote: título dos roteiros multicanal");
  assert.equal((text.match(/^Versão de e-mail:$/gm) || []).length, C.roteiros, "[texto-versao-email] pacote em texto com a versão de e-mail de cada roteiro");
  assert.equal((text.match(/ · Roteiro · /g) || []).length, C.roteiros, "[calendario-rotulo] calendário rotula os roteiros como Roteiro");
});

// (e) Varredura:// (e) Varredura: nenhum texto que descreve o Conteúdo Pronto pode divergir do contrato.
const SKIP_DIRS = new Set([".git", "node_modules", "tests"]);
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name)); }
    else if (/\.(html|txt|md)$/.test(e.name)) yield join(dir, e.name);
  }
}
// Linhas, itens/blocos HTML, cartões de catálogo vizinhos (</a><a) e campos de JSON-LD (", ")
// são segmentos independentes; um link "Conteúdo Pronto</a>: 12 posts..." fica no mesmo segmento.
// O cartão do Conteúdo Pronto no catálogo do #914 (<article id="p-conteudo-pronto">, itens em <li>) é UM segmento:
// o nome fica no <h3> e as quantidades nos <li> do mesmo cartão.
const SEGMENT = /\n|<\/?(?:li|dd|div|section|td|article)\b[^>]*>|<\/a>(?=<a\b)|", "/;
function describingSegments(text) {
  const cards = text.match(new RegExp(CP_CARD.source, "g")) || [];
  const rest = cards.reduce((t, c) => t.replace(c, "\n"), text);
  return [...cards, ...rest.split(SEGMENT)].filter((seg) => seg.includes("Conteúdo Pronto") && /\b\d+ posts\b/.test(seg));
}

test("(e) toda página que descreve o Conteúdo Pronto (guias ia-para-*, kit, llms, catálogo; fonte e gerada) segue o contrato", () => {
  const described = new Map();
  for (const abs of walk(ROOT)) {
    const rel = relative(ROOT, abs).split(sep).join("/");
    const segs = describingSegments(readTextNormalized(abs));
    if (segs.length) described.set(rel, segs);
  }
  for (const [rel, segs] of described) {
    for (const seg of segs) {
      const where = rel + ": " + seg.replace(/<[^>]+>/g, "").trim().slice(0, 120);
      assert.ok(seg.includes(`${C.posts} posts`), "quantidade de posts do contrato — " + where);
      assert.ok(seg.includes(`${C.roteiros} roteiros multicanal`), "roteiros multicanal do contrato — " + where);
      assert.doesNotMatch(seg, /mensage(?:m|ns)|whats\s*app/i, "sem mensagens/WhatsApp — " + where);
    }
  }
  // Cobertura: cada guia de nicho (fonte e página gerada), kit, llms e catálogo entram na varredura.
  const niches = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("ia-para-")).map((e) => e.name);
  assert.ok(niches.length >= 40, "guias de nicho encontrados: " + niches.length);
  const required = [];
  // DEC-04: com o CP oculto, catálogo, llms.txt, guias de nicho e kit do afiliado não o descrevem (nem o anunciam,
  // nem linkam a lápide 404); ligado, voltam a ser exigidos.
  const catalog = ["sales-overlay/llms.txt", "sales-public/llms.txt", "solucoes/index.html", "sales-public/solucoes.html", "sales-public/index.html",
    ...niches.flatMap((n) => [`${n}/index.html`, `sales-public/${n}.html`]),
    "kit-afiliado/index.html", "sales-public/kit-afiliado.html"];
  if (cpSalesEnabled()) required.push(...catalog);
  else for (const rel of catalog) {
    assert.ok(!described.has(rel), "[dec04] CP oculto não é descrito em: " + rel);
    assert.doesNotMatch(read(rel), /Conteúdo Pronto|\/conteudo-pronto|\/assinar\//, "[dec04] CP oculto não é anunciado em: " + rel);
  }
  for (const rel of required) assert.ok(described.has(rel), "página descreve o Conteúdo Pronto e entrou na varredura: " + rel);
});

// (f) Pacotes gravados contaminados (DEC-14): o bloqueio é puro (packageBlocked/displayedText/packageText). A leitura
// do pacote pelo link privado (handlePackageView, em KV) e a regeneração gratuita (candidato/outbox em KV) foram
// removidas com o pipeline KV (DEC-14(b)); hoje a rota /conteudo-pronto/pacote responde 503 (teste (d)), isto é, nenhum
// pacote é exibido. O que continua valendo, e é testado aqui sem KV: nenhum campo exibido de um pacote contaminado
// (v1 ou v2) sai no texto do pacote, e o pacote v1 limpo segue legível com rótulo neutro.
const BANNED = P.contato_publico.numeros_banidos[0];
const CONTAMINANTS = [
  ["WhatsApp", "Chame no WhatsApp"], ["whats app", "fale no whats app hoje"], ["zap", "manda um zap"],
  ["wa.me", "https://wa.me/5511999990000"], ["api.whatsapp.com", "https://api.whatsapp.com/send?phone=5511999990000"],
  ["whatsapp://", "whatsapp://send?text=oi"], ["número banido completo", BANNED],
  ["número banido formatado", `(${BANNED.slice(2, 4)}) ${BANNED.slice(4, 9)}-${BANNED.slice(9)}`],
  ["número banido com +55 e espaços", `+55 (${BANNED.slice(2, 4)}) ${BANNED[4]} ${BANNED.slice(5, 9)}-${BANNED.slice(9)}`],
  ["número banido mascarado", `(${BANNED.slice(2, 4)}) ${BANNED[4]}****-${BANNED.slice(9)}`],
];
const LEGACY_FIELDS = {
  "mensagens.texto": (pkg, v) => { pkg.mensagens[1].texto += " " + v; },
  "mensagens.objetivo": (pkg, v) => { pkg.mensagens[0].objetivo += " " + v; },
  "posts.tema": (pkg, v) => { pkg.posts[0].tema += " " + v; },
  "posts.legenda": (pkg, v) => { pkg.posts[1].legenda += " " + v; },
  "posts.cta": (pkg, v) => { pkg.posts[0].cta = v; },
  "posts.hashtags": (pkg, v) => { pkg.posts[0].hashtags.push(v); },
  "posts.imagem": (pkg, v) => { pkg.posts[1].imagem = v; },
  "calendario.tema": (pkg, v) => { pkg.calendario[0].tema += " " + v; },
};
const legacyPkg = () => ({ schema: "zpc.cp.package.v1", cycle: 1, generatedAt: "2026-10-01T00:00:00.000Z",
  posts: [post(1), post(2)], mensagens: [{ objetivo: "Oferta", texto: "Texto antigo de oferta." }, { objetivo: "Retorno", texto: "Texto antigo de retorno." }],
  calendario: [{ dia: 1, tipo: "post", tema: "Tema 1" }, { dia: 5, tipo: "whatsapp", tema: "Oferta" }] });
const LEAK = (term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "i");

test("(f) pacote gravado com canal ou número banido em qualquer campo exibido: bloqueado, sem vazamento no texto; v1 limpo legível", () => {
  let cases = 0;
  for (const [field, put] of Object.entries(LEGACY_FIELDS)) {
    for (const [label, value] of CONTAMINANTS) {
      const pkg = legacyPkg(); put(pkg, value);
      const where = `${field} × ${label}`;
      assert.equal(CS.packageBlocked(pkg), true, "[legacy-detect] " + where);
      const text = CS.packageText(pkg);
      assert.doesNotMatch(text, LEAK(value), "[legacy-text-leak] " + where);
      assert.ok(text.includes(CS.BLOQUEIO_TEXTO), "[legacy-text-leak] " + where);
      cases++;
    }
  }
  assert.equal(cases, Object.keys(LEGACY_FIELDS).length * CONTAMINANTS.length);
  // v1 limpo (calendário com tipo antigo, nunca exibido): legível, rótulo neutro, sem o bloqueio.
  const clean = legacyPkg();
  assert.equal(CS.packageBlocked(clean), false, "[legacy-clean] v1 limpo não é bloqueado");
  const cleanText = CS.packageText(clean);
  assert.ok(cleanText.includes("Texto antigo de retorno.") && !cleanText.includes(CS.BLOQUEIO_TEXTO), "[legacy-clean] v1 limpo legível");
  assert.doesNotMatch(cleanText, WA, "[legacy-clean] v1 limpo sem WhatsApp");
  assert.match(cleanText, /Dia 05 · Roteiro · Oferta/, "[legacy-clean] tipo antigo do calendário vira Roteiro");
});

test("(f3) gerador v2 também rejeita canal e número banido nos posts; detector do número banido sem falso positivo", () => {
  assert.equal(CS.validatePosts([post(1)], 1).length, 1);
  for (const [label, value] of CONTAMINANTS) {
    assert.equal(CS.validatePosts([{ ...post(1), cta: value }], 1), null, "[posts-guard] cta " + label);
    assert.equal(CS.validatePosts([{ ...post(1), legenda: post(1).legenda + " " + value }], 1), null, "[posts-guard] legenda " + label);
    const rs = CS.ROTEIRO_OBJETIVOS.map((o) => roteiro(o));
    rs[1] = { ...rs[1], email: { ...rs[1].email, corpo: rs[1].email.corpo + " " + value } };
    assert.equal(CS.validateRoteiros(rs), null, "[roteiros-guard] " + label);
  }
  for (const ok of ["(88) 99999-0000", "R$ 5413,00", "Ligue 0800 545 413", "pedido 5413", "(11) 9****-5413"]) assert.equal(CS.bannedNumberIn(ok), false, "[number-false-positive] " + ok);
});

test("(g6) pacote v2 gravado contaminado em curta, assunto ou corpo: bloqueado como o legado, sem vazamento no texto", () => {
  const v2 = () => ({ schema: C.package_schema, content_schema_version: C.content_schema_version, cycle: 1, generatedAt: "2026-10-20T00:00:00.000Z",
    posts: [post(1), post(2)], roteiros: CS.ROTEIRO_OBJETIVOS.map((o) => ({ objetivo_id: o.id, objetivo: o.titulo, curta: roteiro(o).curta, email: { ...roteiro(o).email } })),
    calendario: [{ dia: 1, tipo: "post", tema: "Tema 1" }, { dia: 5, tipo: "roteiro", tema: CS.ROTEIRO_OBJETIVOS[0].titulo }] });
  const V2_FIELDS = {
    "roteiros.curta": (pkg, v) => { pkg.roteiros[2].curta += " " + v; },
    "roteiros.email.assunto": (pkg, v) => { pkg.roteiros[1].email.assunto = "Novidade: " + v; },
    "roteiros.email.corpo": (pkg, v) => { pkg.roteiros[3].email.corpo += " " + v; },
  };
  assert.equal(CS.packageBlocked(v2()), false, "[v2-clean] v2 limpo não é bloqueado");
  let cases = 0;
  for (const [field, put] of Object.entries(V2_FIELDS)) {
    for (const [label, value] of CONTAMINANTS) {
      const pkg = v2(); put(pkg, value);
      const where = `${field} × ${label}`;
      assert.equal(CS.packageBlocked(pkg), true, "[v2-detect] " + where);
      const text = CS.packageText(pkg);
      assert.doesNotMatch(text, LEAK(value), "[v2-text-leak] " + where);
      assert.ok(text.includes(CS.BLOQUEIO_TEXTO), "[v2-text-leak] " + where);
      cases++;
    }
  }
  assert.equal(cases, Object.keys(V2_FIELDS).length * CONTAMINANTS.length);
});
