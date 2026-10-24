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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readTextNormalized(join(ROOT, rel));
const P = JSON.parse(read("data/politica-unica.json"));
const C = P.conteudo_pronto;
const CARACT = P.resumo_oferta.assinatura.caracteristicas;
const WA = /whats\s*app/i;
// O nome do asset de contato (/whatsapp-contact.js, só e-mail desde o banimento; ver
// tests/contato-publico-whatsapp.test.mjs) não é promessa de canal: fica fora da guarda.
const noAsset = (html) => html.replace(/<script src="\/whatsapp-contact\.js" defer><\/script>/g, "");

const CANONICAL = "Todo mês: 12 posts com legenda, 4 roteiros multicanal de venda e acompanhamento — cada um com versão curta e versão de e-mail — e um calendário de 30 dias, no tom do seu negócio. Os roteiros são para canais autorizados pelo cliente, como e-mail, Instagram Direct, Telegram ou chat do site. Você revisa antes de usar; não há disparo automático.";
const OBJECTIVE_IDS = ["oferta_solicitada", "acompanhamento", "reativacao", "indicacao"];
const CONTRACT_FINGERPRINTS = { 2: "cdef6dbb4f311a80e86287f95a879be614a8eff8627653deb82d0b5283afd5fa" };
const fingerprint = () => {
  const { nota, ...contrato } = C;
  return createHash("sha256").update(JSON.stringify({ contrato, caracteristicas: CARACT })).digest("hex");
};

// IA falsa: devolve posts e roteiros válidos e grava os prompts recebidos.
const post = (i) => ({ tema: "Tema " + i, legenda: "Legenda completa e concreta para o negócio, explicando o benefício real do serviço sem promessas exageradas. ".repeat(3), cta: "Chame no Direct", hashtags: ["#negocio", "#local"], imagem: "foto da equipe" });
const roteiro = (o, extra = {}) => ({ objetivo_id: o.id, curta: "Olá! Aqui é do negócio. Passando para lembrar da nossa oferta principal e tirar qualquer dúvida que você tenha.", email: { assunto: "Sobre o que você pediu", corpo: "Olá! Obrigado pelo contato. ".repeat(10) + "Se fizer sentido, responda este e-mail e combinamos o próximo passo." }, ...extra });
function fakeAI() {
  const prompts = [];
  return { prompts, run: async (_m, { messages }) => { const u = messages[1].content; prompts.push(u); return { response: JSON.stringify(u.includes("roteiros multicanal") ? { roteiros: CS.ROTEIRO_OBJETIVOS.map((o) => roteiro(o)) } : { posts: [1, 2, 3, 4, 5, 6].map(post) }) }; } };
}
const BRIEF = { negocio: "Salão Bela", ramo: "salão de beleza", publico: "mulheres 25-50", produtos: "corte, escova", diferencial: "atendimento rápido", tom: "próximo", contato: "e-mail e Instagram Direct" };

test("(a) oferta canônica e contrato v2: texto literal, quantidades e os quatro objetivos", () => {
  assert.equal(CARACT, CANONICAL, "características essenciais = texto canônico do auditor");
  assert.equal(C.content_schema_version, 2);
  assert.equal(C.package_schema, "zpc.cp.package.v2");
  assert.equal(CONTRACT_FINGERPRINTS[C.content_schema_version], fingerprint(), "contrato mudou: suba content_schema_version e registre a impressão digital nova");
  assert.deepEqual(C.objetivos.map((o) => o.id), OBJECTIVE_IDS);
  assert.deepEqual(C.versoes_roteiro, ["curta", "email"]);
  const reat = C.objetivos.find((o) => o.id === "reativacao").regra;
  assert.match(reat, /somente/);
  assert.match(reat, /relacionamento ativo/);
  assert.match(reat, /consentimento registrado/);
  // O texto da oferta descreve exatamente o que o contrato manda gerar.
  assert.ok(CARACT.includes(`${C.posts} posts com legenda`));
  assert.ok(CARACT.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`));
  assert.ok(CARACT.includes("versão curta e versão de e-mail"));
  assert.ok(CARACT.includes(`calendário de ${C.calendario_dias} dias`));
  const canais = C.canais_autorizados_exemplo;
  assert.ok(CARACT.includes(`canais autorizados pelo cliente, como ${canais.slice(0, -1).join(", ")} ou ${canais.at(-1)}`));
  assert.ok(CARACT.includes("não há disparo automático"));
  for (const [k, v] of Object.entries(C)) if (k !== "termos_proibidos_regex" && k !== "nota") assert.doesNotMatch(JSON.stringify(v), WA, "contrato sem WhatsApp: " + k);
});

test("(b) página-fonte, catálogo, suporte e páginas geradas seguem o contrato e não prometem WhatsApp", () => {
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

  const card = read("solucoes/index.html").match(/<a class="catalog-card" href="[^"]*conteudo-pronto">[\s\S]*?<\/a>/)[0];
  assert.doesNotMatch(card, WA);
  assert.ok(card.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`));

  const sup = SUPPORT_PRODUCTS["conteudo-pronto"].content;
  assert.doesNotMatch(sup, WA);
  assert.ok(sup.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`) && sup.includes("versão curta e versão de e-mail") && sup.includes("não há disparo automático"));

  for (const slug of ["conteudo-pronto", "solucoes", "index"]) {
    const built = read(`sales-public/${slug}.html`);
    const block = slug === "conteudo-pronto" ? noAsset(built) : built.match(/<a class="catalog-card" href="\/conteudo-pronto">[\s\S]*?<\/a>/)[0];
    assert.doesNotMatch(block, WA, "gerado: " + slug);
    assert.ok(block.includes(`${C.roteiros} roteiros multicanal`), "gerado: " + slug);
  }
  const built = read("sales-public/conteudo-pronto.html");
  assert.equal(built.match(/<div data-field="caracteristicas"><dt>[^<]*<\/dt><dd>([^<]*)<\/dd>/)?.[1], CANONICAL, "Resumo da oferta gerado = texto canônico");
  assert.equal(built.match(/data-content-schema="(\d+)"/)?.[1], String(C.content_schema_version));
  assert.doesNotMatch(noAsset(openSalesHtml(built, "conteudo-pronto")), WA, "modo aberto (runtime) sem WhatsApp");
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
  const pkg = await CS.generatePackage({ AI: ai }, BRIEF, 3);
  assert.ok(pkg, "pacote gerado");
  assert.equal(pkg.schema, C.package_schema);
  assert.equal(pkg.content_schema_version, C.content_schema_version);
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
  assert.equal(pkg.calendario.length, C.posts + C.roteiros);
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

test("(d) guarda: fonte do gerador, e-mail de boas-vindas, formulário, pacote em texto e HTML entregue sem WhatsApp", async () => {
  assert.doesNotMatch(read("worker/content-service.mjs"), WA, "worker/content-service.mjs sem WhatsApp");
  class MapKV { data = new Map(); async get(k) { return this.data.get(k) ?? null; } async put(k, v) { this.data.set(k, String(v)); } }
  const emails = [];
  const fetchImpl = async (url, init) => { emails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: "hottok-test-1234567890abcdef", RESEND_API_KEY: "re_test", AI: fakeAI() };
  const hook = new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": env.HOTMART_HOTTOK }, body: JSON.stringify({ event: "PURCHASE_APPROVED", data: { product: { id: 1, name: CS.SERVICE_PRODUCT_NAME }, buyer: { email: "c@example.com", name: "Ana" }, purchase: { transaction: "W1" }, subscription: { subscriber: { code: "S1" } } } }) });
  await CS.handleHotmartWebhook(hook, env, null, fetchImpl);
  const welcome = emails.find((m) => /falta só 1 passo/.test(m.subject));
  assert.doesNotMatch(welcome.text, WA, "boas-vindas");
  assert.ok(welcome.text.includes(`${C.roteiros} roteiros multicanal de venda e acompanhamento`));
  const t = welcome.text.match(/t=([A-Za-z0-9_-]+)/)[1];
  const form = await (await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t), env, null, fetchImpl)).text();
  assert.doesNotMatch(form, WA, "formulário");
  await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams(BRIEF) }), env, null, fetchImpl);
  const delivery = emails.find((m) => /chegou/.test(m.subject));
  assert.ok(delivery, "pacote entregue");
  for (const part of [delivery.text, delivery.html]) assert.doesNotMatch(part, WA, "e-mail do pacote");
  assert.ok(delivery.text.includes(CS.ROTEIROS_TITULO) && delivery.text.includes(CS.ROTEIROS_AVISO));
  assert.match(CS.ROTEIROS_AVISO, /relacionamento ativo ou consentimento registrado/);
  assert.match(CS.ROTEIROS_AVISO, /não há disparo automático/);
  const view = await (await CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + delivery.text.match(/pacote\?t=([A-Za-z0-9_-]+)/)[1]), env)).text();
  assert.doesNotMatch(view, WA, "HTML entregue");
  assert.equal((view.match(/<h2>Roteiro \d+ — /g) || []).length, 4);
  assert.equal((view.match(/<h3>Versão de e-mail<\/h3>/g) || []).length, 4);
  assert.ok(view.includes("4 roteiros multicanal de venda e acompanhamento"));
  // Pacote antigo (v1, campo "mensagens", calendário "whatsapp"): reexibido com rótulo neutro.
  const legacy = { schema: "zpc.cp.package.v1", cycle: 1, posts: [post(1)], mensagens: [{ objetivo: "Oferta", texto: "Texto antigo." }], calendario: [{ dia: 5, tipo: "whatsapp", tema: "Oferta" }] };
  const legacyText = CS.packageText(legacy);
  assert.doesNotMatch(legacyText, WA, "pacote v1 em texto");
  assert.match(legacyText, /Dia 05 · Roteiro · Oferta/);
});

// (e) Varredura: nenhum texto que descreve o Conteúdo Pronto pode divergir do contrato.
const SKIP_DIRS = new Set([".git", "node_modules", "tests"]);
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name)); }
    else if (/\.(html|txt|md)$/.test(e.name)) yield join(dir, e.name);
  }
}
// Linhas, itens/blocos HTML, cartões de catálogo vizinhos (</a><a) e campos de JSON-LD (", ")
// são segmentos independentes; um link "Conteúdo Pronto</a>: 12 posts..." fica no mesmo segmento.
const SEGMENT = /\n|<\/?(?:li|dd|div|section|td|article)\b[^>]*>|<\/a>(?=<a\b)|", "/;
function describingSegments(text) {
  return text.split(SEGMENT).filter((seg) => seg.includes("Conteúdo Pronto") && /\b\d+ posts\b/.test(seg));
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
  const required = [
    ...niches.flatMap((n) => [`${n}/index.html`, `sales-public/${n}.html`]),
    "kit-afiliado/index.html", "sales-public/kit-afiliado.html", "sales-overlay/llms.txt", "sales-public/llms.txt",
    "solucoes/index.html", "sales-public/solucoes.html", "sales-public/index.html",
  ];
  for (const rel of required) assert.ok(described.has(rel), "página descreve o Conteúdo Pronto e entrou na varredura: " + rel);
});
