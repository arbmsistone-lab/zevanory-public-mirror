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

const CANONICAL = "Todo mês: 12 posts com legenda, 4 roteiros multicanal de venda e acompanhamento — cada um com versão curta e versão de e-mail — e um calendário de 30 dias, no tom do seu negócio. Os roteiros são para canais autorizados pelo cliente, como e-mail, Instagram Direct, Telegram ou chat do site. Você revisa antes de usar; não há disparo automático.";
const OBJECTIVE_IDS = ["oferta_solicitada", "acompanhamento", "reativacao", "indicacao"];
// v2 ainda não foi publicada: a impressão digital registra o contrato final da v2 (com wa.me nos termos proibidos).
const CONTRACT_FINGERPRINTS = { 2: "5a6a0d0c1fee4716dcf78f16a177337ec8c21c96bb973ed3998b279d19491498" };
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
  assert.doesNotMatch(form, WA, "[form] formulário sem WhatsApp");
  await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams(BRIEF) }), env, null, fetchImpl);
  const delivery = emails.find((m) => /chegou/.test(m.subject));
  assert.ok(delivery, "pacote entregue");
  for (const part of [delivery.text, delivery.html]) assert.doesNotMatch(part, WA, "e-mail do pacote");
  assert.ok(delivery.text.includes(CS.ROTEIROS_TITULO) && delivery.text.includes(CS.ROTEIROS_AVISO));
  assert.match(CS.ROTEIROS_AVISO, /relacionamento ativo ou consentimento registrado/, "[aviso]");
  assert.match(CS.ROTEIROS_AVISO, /não há disparo automático/);
  const view = await (await CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + delivery.text.match(/pacote\?t=([A-Za-z0-9_-]+)/)[1]), env)).text();
  assert.doesNotMatch(view, WA, "HTML entregue");
  assert.equal((view.match(/<h2>Roteiro \d+ — /g) || []).length, 4);
  assert.equal((view.match(/<h3>Versão de e-mail<\/h3>/g) || []).length, 4, "[html-versao-email]");
  assert.ok(view.includes("4 roteiros multicanal de venda e acompanhamento"));
  // Pacote antigo (v1, campo "mensagens", calendário "whatsapp"): reexibido com rótulo neutro.
  const legacy = { schema: "zpc.cp.package.v1", cycle: 1, posts: [post(1)], mensagens: [{ objetivo: "Oferta", texto: "Texto antigo." }], calendario: [{ dia: 5, tipo: "whatsapp", tema: "Oferta" }] };
  const legacyText = CS.packageText(legacy);
  assert.doesNotMatch(legacyText, WA, "pacote v1 em texto");
  assert.match(legacyText, /Dia 05 · Roteiro · Oferta/, "[legacy-clean] texto");
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
  const required = [
    ...niches.flatMap((n) => [`${n}/index.html`, `sales-public/${n}.html`]),
    "kit-afiliado/index.html", "sales-public/kit-afiliado.html", "sales-overlay/llms.txt", "sales-public/llms.txt",
    "solucoes/index.html", "sales-public/solucoes.html", "sales-public/index.html",
  ];
  for (const rel of required) assert.ok(described.has(rel), "página descreve o Conteúdo Pronto e entrou na varredura: " + rel);
});

// (f) Pacotes gravados contaminados: bloqueio na leitura + regeneração gratuita, bytes antigos intactos.
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
class KV { data = new Map(); async get(k) { return this.data.get(k) ?? null; } async put(k, v) { this.data.set(k, String(v)); } }
function legacyEnv(pkg, { status = "active" } = {}) {
  const kv = new KV(), emails = [];
  const sub = "zpc:cp:sub:" + "a".repeat(40), legacyKey = "zpc:cp:pkg:" + "a".repeat(40) + ":1", token = "T".repeat(43);
  const raw = JSON.stringify(pkg);
  kv.data.set(legacyKey, raw);
  kv.data.set("zpc:cp:token:" + token, sub);
  kv.data.set(sub, JSON.stringify({ schema: "zpc.cp.v1", status, email: "c@example.com", name: "Ana", cycles: 1, briefing: BRIEF, deliveredCycle: 1, lastPackage: legacyKey }));
  const ai = fakeAI();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, RESEND_API_KEY: "re_test", AI: ai };
  const resend = fakeResend(emails);
  const url = "https://zevanory.api.br/conteudo-pronto/pacote?t=" + token;
  return { kv, env, ai, emails, resend, fetchImpl: resend.fetch, url, sub, legacyKey, raw };
}
// Resend falso com a semântica documentada da Idempotency-Key (https://resend.com/docs/dashboard/emails/idempotency-keys):
// mesma chave + mesmo payload => resposta original, sem enviar de novo; payload diferente => 409. Sucesso = 200 + id.
// mode: "ok" | "timeout" (fetch rejeita com TimeoutError, como AbortSignal.timeout) | status HTTP numérico.
function fakeResend(delivered = []) {
  const r = { mode: "ok", requests: [], delivered, byKey: new Map(), events: new Map() };
  r.fetch = async (u, init = {}) => {
    if ((init.method || "GET") === "GET") {
      const id = decodeURIComponent(String(u).split("/").pop());
      r.requests.push({ method: "GET", id });
      if (![...r.byKey.values()].some((v) => v.id === id)) return new Response(JSON.stringify({ name: "not_found" }), { status: 404 });
      return new Response(JSON.stringify({ object: "email", id, last_event: r.events.get(id) ?? "sent" }), { status: 200 });
    }
    const key = init?.headers?.["idempotency-key"];
    r.requests.push({ method: "POST", key, body: JSON.parse(init.body) });
    const customer = JSON.parse(init.body).to?.[0] === "c@example.com"; // o modo de falha vale para o envio ao cliente
    if (customer && r.mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (customer && r.mode === "noid") return new Response("{}", { status: 200 });
    if (customer && r.mode === "concurrent") return new Response(JSON.stringify({ statusCode: 409, name: "concurrent_idempotent_requests" }), { status: 409 });
    if (customer && typeof r.mode === "number") return new Response(JSON.stringify({ name: "provider_error" }), { status: r.mode });
    if (key && r.byKey.has(key)) {
      const prev = r.byKey.get(key);
      if (prev.payload !== init.body) return new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
      return new Response(JSON.stringify({ id: prev.id }), { status: 200 });
    }
    const id = "re_" + (r.delivered.length + 1);
    r.delivered.push(JSON.parse(init.body));
    r.byKey.set(key || "nokey-" + id, { id, payload: init.body });
    return new Response(JSON.stringify({ id }), { status: 200 });
  };
  return r;
}
const toCustomer = (list) => list.filter((m) => m.to?.[0] === "c@example.com");
const customerPosts = (t) => t.resend.requests.filter((q) => q.method === "POST" && q.body.to[0] === "c@example.com");
const regenKeys = (kv) => [...kv.data.keys()].filter((k) => k.startsWith("zpc:cp:regen:"));
const candOf = (t) => { const ks = regenKeys(t.kv); assert.equal(ks.length, 1, "[regen-single] um candidato ativo"); return { key: ks[0], ...JSON.parse(t.kv.data.get(ks[0])) }; };
const recOf = (t) => JSON.parse(t.kv.data.get(t.sub));
const regenPost = (t) => CS.handlePackageView(new Request(t.url, { method: "POST", body: new URLSearchParams({ acao: "regenerar" }) }), t.env, null, t.fetchImpl);
const COPY_FORBIDDEN = /chegou|entregue|foi enviad|entrega da versão nova foi confirmada/i;
const ownerAlerts = (t) => t.emails.filter((m) => m.to?.[0] !== "c@example.com");
const regenEvents = (kv) => [...kv.data.values()].filter((v) => v.includes('"status":"service_package_regenerated"')).length;
const LEAK = (term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "i");

test("(f) pacote gravado com canal ou número banido em qualquer campo exibido: bloqueado, bytes intactos, sem vazamento", async () => {
  let cases = 0;
  for (const [field, put] of Object.entries(LEGACY_FIELDS)) {
    for (const [label, value] of CONTAMINANTS) {
      const pkg = legacyPkg(); put(pkg, value);
      const where = `${field} × ${label}`;
      assert.equal(CS.packageBlocked(pkg), true, "[legacy-detect] " + where);
      const t = legacyEnv(pkg);
      const res = await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl);
      const html = await res.text();
      assert.equal(res.status, 200, where);
      assert.doesNotMatch(html, LEAK(value), "[legacy-html-leak] " + where);
      assert.doesNotMatch(html, /whats\s*app|wa\.me|\bzap\b/i, "[legacy-html-leak] " + where);
      assert.ok(html.includes(CS.BLOQUEIO_TEXTO) && html.includes("Gerar versão nova sem custo"), "[legacy-offer] " + where);
      const text = CS.packageText(pkg);
      assert.doesNotMatch(text, LEAK(value), "[legacy-text-leak] " + where);
      assert.ok(text.includes(CS.BLOQUEIO_TEXTO), "[legacy-text-leak] " + where);
      assert.equal(t.kv.data.get(t.legacyKey), t.raw, "[legacy-bytes] " + where);
      assert.equal(t.emails.length, 0, "leitura não envia e-mail: " + where);
      cases++;
    }
  }
  assert.equal(cases, Object.keys(LEGACY_FIELDS).length * CONTAMINANTS.length);
  // Assinante inativo: bloqueado, sem botão; orientação de pedir pelo suporte.
  const pkg = legacyPkg(); LEGACY_FIELDS["mensagens.texto"](pkg, "Chame no WhatsApp");
  const t = legacyEnv(pkg, { status: "inactive" });
  const html = await (await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl)).text();
  assert.ok(!html.includes("Gerar versão nova sem custo") && html.includes("suporte@zevanory.api.br"), "[legacy-inactive]");
  assert.doesNotMatch(html, WA, "[legacy-html-leak] inativo");
  const post409 = await CS.handlePackageView(new Request(t.url, { method: "POST", body: new URLSearchParams({ acao: "regenerar" }) }), t.env, null, t.fetchImpl);
  assert.equal(post409.status, 409, "[legacy-inactive] inativo não regenera");
  assert.equal(t.ai.prompts.length, 0, "[legacy-inactive] sem chamada de IA");
});

test("(f2) regeneração: 2xx do envio só deixa o candidato accepted; entrega confirmada pelo email_id promove a chave nova; v1 limpo legível", async () => {
  const pkg = legacyPkg(); LEGACY_FIELDS["posts.cta"](pkg, "https://wa.me/" + BANNED);
  const t = legacyEnv(pkg);
  const res = await regenPost(t);
  const html = await res.text();
  assert.equal(res.status, 202, "[regen-accepted] POST: 202, entrega ainda não confirmada");
  assert.ok(html.includes(CS.REGEN_MSG.accepted), "[regen-accepted] mensagem de envio aceito");
  assert.ok(!html.includes(CS.REGEN_MSG.delivered) && !COPY_FORBIDDEN.test(html), "[regen-copy] 2xx não vira entrega");
  assert.equal(recOf(t).lastPackage, t.legacyKey, "[regen-accepted] 2xx não promove");
  assert.equal(regenEvents(t.kv), 0, "[regen-accepted] 2xx não registra delivery_sent");
  const cand = candOf(t);
  assert.equal(cand.delivery, "accepted", "[regen-accepted] estado accepted");
  assert.equal(cand.email_id, "re_1", "[regen-accepted] email_id gravado");
  assert.match(cand.protocolo, /^CPR-[0-9A-F]{10}$/);
  assert.equal(toCustomer(t.emails).length, 1, "[regen] e-mail da versão nova");
  const mail = toCustomer(t.emails)[0];
  assert.match(mail.subject, /nova versão/);
  for (const part of [mail.text, mail.html]) { assert.doesNotMatch(part, WA, "[regen] e-mail sem WhatsApp"); assert.equal(CS.bannedNumberIn(part), false, "[regen] e-mail sem número banido"); }
  assert.ok(mail.text.includes(CS.ROTEIROS_TITULO), "[regen] formato atual");
  const pending = await (await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl)).text();
  assert.ok(pending.includes(CS.REGEN_MSG.accepted) && !pending.includes("Gerar versão nova sem custo") && !pending.includes(CS.REGEN_MSG.delivered), "[regen-accepted] página mostra o estado, sem o pacote");
  // last_event ainda "sent": continua accepted.
  await CS.retryPendingPackages(t.env, t.fetchImpl);
  assert.equal(recOf(t).lastPackage, t.legacyKey, "[regen-accepted] last_event sent não promove");
  t.resend.events.set("re_1", "delivered");
  const cron = await CS.retryPendingPackages(t.env, t.fetchImpl);
  assert.equal(cron.regen?.promoted, 1, "[regen-cron] reconciliação no cron");
  assert.equal(t.kv.data.get(t.legacyKey), t.raw, "[legacy-bytes] após regenerar");
  const rec = recOf(t);
  assert.ok(rec.lastPackage.startsWith(t.legacyKey.replace(/:1$/, ":1:v" + C.content_schema_version + ":c")), "[regen] chave nova com versão");
  assert.equal(rec.lastPackage, cand.candidate_key, "[regen] chave nova com versão");
  assert.equal(rec.blockedPackage, t.legacyKey, "[regen] referência ao pacote antigo");
  assert.equal(regenEvents(t.kv), 1, "[regen] um delivery_sent após a entrega confirmada");
  const fresh = JSON.parse(t.kv.data.get(rec.lastPackage));
  assert.equal(fresh.schema, C.package_schema, "[regen] schema v2");
  const view = await (await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl)).text();
  assert.equal((view.match(/<h3>Versão de e-mail<\/h3>/g) || []).length, 4, "[regen] página mostra a versão nova");
  const calls = t.ai.prompts.length;
  const again = await (await regenPost(t)).text();
  assert.ok(again.includes(CS.REGEN_MSG.delivered), "[regen-idempotent]");
  assert.equal(t.ai.prompts.length, calls, "[regen-idempotent] sem nova chamada de IA");
  assert.equal(toCustomer(t.emails).length, 1, "[regen-idempotent] sem novo e-mail");
  // v1 limpo (calendário com tipo antigo, nunca exibido): legível, rótulo neutro, sem oferta de regeneração.
  const clean = legacyEnv(legacyPkg());
  const cleanHtml = await (await CS.handlePackageView(new Request(clean.url), clean.env, null, clean.fetchImpl)).text();
  assert.ok(cleanHtml.includes("Texto antigo de retorno.") && !cleanHtml.includes("Gerar versão nova sem custo"), "[legacy-clean]");
  assert.doesNotMatch(cleanHtml, WA, "[legacy-clean]");
  assert.match(cleanHtml, /Dia 5 · Roteiro · Oferta/, "[legacy-clean]");
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

// (g) Regeneração com entrega confirmada (critério Sol #898): bloqueado / candidato / atual; pending -> accepted -> delivered | dead.
const isCandPkg = (k) => k.startsWith("zpc:cp:pkg:") && /:c[0-9a-f]{12}$/.test(k);
const contaminatedLegacy = () => { const pkg = legacyPkg(); LEGACY_FIELDS["mensagens.texto"](pkg, "Chame no WhatsApp"); return pkg; };
const deliver = async (t) => { t.resend.events.set(candOf(t).email_id, "delivered"); return CS.reconcileRegenCandidates(t.env, t.fetchImpl); };
function countingPuts(t) {
  const put = t.kv.put.bind(t.kv), puts = [];
  t.kv.put = async (k, v, o) => { puts.push(k); return put(k, v, o); };
  return puts;
}
const TRANSIENT = [["tempo esgotado", "timeout"], ["408", 408], ["429", 429], ["500", 500], ["502", 502], ["503", 503], ["2xx sem id", "noid"], ["409 concurrent_idempotent_requests (clique duplo)", "concurrent"], ["sendEmail=false (sem RESEND_API_KEY)", "nokey"]];

test("(g1) tempo esgotado, 429, 5xx ou envio falso: candidato pending, 202 com protocolo, nada promovido; retomada com a mesma chave", async () => {
  for (const [label, mode] of TRANSIENT) {
    const t = legacyEnv(contaminatedLegacy());
    if (mode === "nokey") delete t.env.RESEND_API_KEY; else t.resend.mode = mode;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await regenPost(t);
      const html = await res.text();
      const cand = candOf(t);
      assert.equal(recOf(t).lastPackage, t.legacyKey, `[regen-fail] ${label} #${attempt}: lastPackage não avança`);
      assert.equal(regenEvents(t.kv), 0, `[regen-fail] ${label} #${attempt}: sem delivery_sent`);
      assert.equal(res.status, 202, `[regen-fail] ${label} #${attempt}: 202`);
      assert.ok(html.includes(CS.REGEN_MSG.pending(cand.protocolo)), `[regen-fail] ${label} #${attempt}: mensagem de pendência com protocolo`);
      assert.ok(!COPY_FORBIDDEN.test(html), `[regen-copy] ${label} #${attempt}`);
      assert.equal(cand.delivery, "pending", `[regen-fail] ${label} #${attempt}: candidato pending`);
      assert.equal(t.kv.data.get(t.legacyKey), t.raw, `[legacy-bytes] ${label} #${attempt}`);
      const view = await (await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl)).text();
      assert.ok(view.includes(CS.REGEN_MSG.pending(cand.protocolo)) && view.includes("Gerar versão nova sem custo"), `[regen-fail] ${label} #${attempt}: bloqueado, estado e nova tentativa`);
      assert.doesNotMatch(view, WA, `[legacy-html-leak] ${label}`);
    }
    assert.equal(toCustomer(t.emails).length, 0, `[regen-fail] ${label}: nada entregue`);
    assert.equal(ownerAlerts(t).length, 0, `[regen-fail] ${label}: temporário não é dead`);
    assert.equal(t.ai.prompts.length, 3, `[regen-single] ${label}: candidato reaproveitado, sem nova IA`);
    // Retomada pelo cron (mesma chave, mesmo candidato), depois confirmação de entrega.
    t.env.RESEND_API_KEY = "re_test"; t.resend.mode = "ok";
    const c1 = await CS.reconcileRegenCandidates(t.env, t.fetchImpl);
    assert.equal(c1.accepted, 1, `[regen-retry] ${label}: cron reenviou`);
    assert.equal(recOf(t).lastPackage, t.legacyKey, `[regen-accepted] ${label}: aceito não promove`);
    await deliver(t);
    assert.equal(recOf(t).lastPackage, candOf(t).candidate_key, `[regen-retry] ${label}: promovido após delivered`);
    assert.equal(regenEvents(t.kv), 1, `[regen-retry] ${label}: um delivery_sent`);
    assert.equal(toCustomer(t.emails).length, 1, `[regen-retry] ${label}: um e-mail`);
    const keys = new Set(customerPosts(t).map((q) => q.key));
    assert.equal(keys.size, 1, `[regen-idem] ${label}: mesma Idempotency-Key em todas as tentativas`);
    assert.equal([...keys][0], candOf(t).idempotencyKey, `[regen-idem] ${label}: chave do candidato`);
    assert.match([...keys][0] || "", /^cp-regen\/[0-9a-f]{40}$/, `[regen-idem] ${label}: chave presente`);
  }
});

test("(g2) 4xx permanente: dead na hora com alerta; dead nunca vira atual, nem com delivered tardio; reabrir exige operação registrada", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const t = legacyEnv(contaminatedLegacy());
    t.resend.mode = status;
    const res = await regenPost(t);
    const html = await res.text();
    const cand = candOf(t);
    assert.equal(cand.delivery, "dead", `[regen-dead] ${status}: dead`);
    assert.equal(res.status, 409, `[regen-dead] ${status}: 409`);
    assert.ok(html.includes(CS.REGEN_MSG.dead(cand.protocolo)) && !COPY_FORBIDDEN.test(html), `[regen-dead] ${status}: mensagem honesta`);
    assert.equal(ownerAlerts(t).length, 1, `[regen-dead] alerta ${status}`);
    assert.equal(recOf(t).lastPackage, t.legacyKey, `[regen-dead] ${status}: não promovido`);
    t.resend.mode = "ok";
    assert.equal((await regenPost(t)).status, 409, `[regen-dead] ${status}: continua dead`);
    assert.equal(customerPosts(t).length, 1, `[regen-dead] ${status}: dead não chama o Resend de novo`);
  }
  // accepted -> dead (bounced) e delivered tardio não promove; operação registrada reabre com chave nova.
  const t = legacyEnv(contaminatedLegacy());
  assert.equal((await regenPost(t)).status, 202, "[regen-accepted] 202");
  t.resend.events.set("re_1", "bounced");
  const r1 = await CS.reconcileRegenCandidates(t.env, t.fetchImpl);
  assert.equal(r1.dead, 1, "[regen-bounce] bounced => dead");
  assert.equal(candOf(t).delivery, "dead", "[regen-bounce]");
  assert.equal(ownerAlerts(t).length, 1, "[regen-bounce] alerta");
  t.resend.events.set("re_1", "delivered");
  const late = await CS.applyRegenDelivered(t.env, candOf(t).key, "re_1", t.fetchImpl);
  assert.equal(late.promoted, false, "[regen-dead] delivered tardio não promove dead");
  await CS.reconcileRegenCandidates(t.env, t.fetchImpl);
  assert.equal(recOf(t).lastPackage, t.legacyKey, "[regen-dead] dead nunca vira atual");
  assert.equal(regenEvents(t.kv), 0, "[regen-dead] sem delivery_sent");
  const k = candOf(t).key;
  assert.equal((await CS.reopenDeadRegenCandidate(t.env, k, {})).ok, false, "[regen-reopen] sem operador/motivo não reabre");
  assert.equal((await CS.reopenDeadRegenCandidate(t.env, k, { operator: "renan" })).ok, false, "[regen-reopen] sem motivo não reabre");
  assert.equal(candOf(t).delivery, "dead", "[regen-reopen] continua dead");
  const op = await CS.reopenDeadRegenCandidate(t.env, k, { operator: "renan", reason: "endereço corrigido pelo cliente" });
  assert.equal(op.ok, true, "[regen-reopen]");
  const reopened = candOf(t);
  assert.equal(reopened.operations.length, 1, "[regen-reopen] operação registrada");
  assert.notEqual(reopened.idempotencyKey, reopened.baseIdempotencyKey, "[regen-reopen] chave nova");
  assert.equal(reopened.candidate_key, candOf(t).candidate_key, "[regen-reopen] mesmo pacote imutável");
  await CS.reconcileRegenCandidates(t.env, t.fetchImpl);
  await deliver(t);
  assert.equal(recOf(t).lastPackage, reopened.candidate_key, "[regen-reopen] promovido só após operação + entrega");
});

test("(g3) queda entre o envio e a gravação: sem segundo e-mail na retomada; queda na promoção converge; delivered duplicado não promove nem notifica", async () => {
  // Página: o envio aceito não chega a ser gravado.
  const t = legacyEnv(contaminatedLegacy());
  const put = t.kv.put.bind(t.kv);
  let crash = "send";
  t.kv.put = async (k, v, o) => {
    if (crash === "send" && k.startsWith("zpc:cp:regen:") && JSON.parse(v).delivery === "accepted") { crash = null; throw new Error("isolate killed"); }
    if (crash === "promote" && k === t.sub && JSON.parse(v).lastPackage !== t.legacyKey) { crash = null; throw new Error("isolate killed"); }
    if (crash === "close" && k.startsWith("zpc:cp:regen:") && JSON.parse(v).promotedAt) { crash = null; throw new Error("isolate killed"); }
    return put(k, v, o);
  };
  const r1 = await regenPost(t);
  assert.equal(r1.status, 503, "[regen-crash] gravação falhou => 503");
  assert.ok((await r1.text()).includes(CS.REGEN_MSG.persist), "[regen-crash] mensagem de persistência");
  assert.equal(toCustomer(t.emails).length, 1, "[regen-crash] o envio aconteceu antes da queda");
  assert.equal(candOf(t).delivery, "pending", "[regen-crash] estado ficou pending");
  const r2 = await regenPost(t);
  assert.equal(r2.status, 202, "[regen-crash] retomada (accepted = 202)");
  const reqs = customerPosts(t);
  assert.equal(reqs.length, 2, "[regen-crash] duas chamadas ao Resend");
  assert.equal(reqs[0].key, reqs[1].key, "[regen-idem] mesma chave na retomada");
  assert.match(reqs[0].key || "", /^cp-regen\//, "[regen-idem] chave presente");
  assert.equal(toCustomer(t.emails).length, 1, "[regen-crash] sem envio duplicado");
  assert.equal(candOf(t).email_id, "re_1", "[regen-crash] id da entrega original");
  // Cron: queda ao promover; a reconciliação seguinte promove.
  crash = "promote";
  await assert.rejects(deliver(t), /isolate killed/);
  assert.equal(recOf(t).lastPackage, t.legacyKey, "[regen-converge] nada promovido na queda");
  assert.equal(candOf(t).delivery, "delivered", "[regen-converge] delivered gravado");
  const conv = await regenPost(t);
  assert.ok((await conv.text()).includes(CS.REGEN_MSG.delivered), "[regen-converge] POST converge a promoção");
  assert.equal(recOf(t).lastPackage, candOf(t).candidate_key, "[regen-converge] promovido na retomada");
  assert.equal(regenEvents(t.kv), 1, "[regen-converge] um delivery_sent");
  assert.ok(candOf(t).promotedAt, "[regen-converge] candidato fechado");
  // delivered duplicado: nenhuma escrita, nenhuma notificação.
  const puts = countingPuts(t);
  const dup1 = await CS.applyRegenDelivered(t.env, candOf(t).key, "re_1", t.fetchImpl);
  const dup2 = await CS.reconcileRegenCandidates(t.env, t.fetchImpl);
  assert.equal(dup1.promoted, false, "[regen-dup] duplicado não promove");
  assert.equal(puts.filter((k) => k === t.sub || k.startsWith("zpc:cp:regen:") || k.startsWith("zpc-activity") || k.includes("activity")).length, 0, "[regen-dup] sem escrita nem notificação");
  assert.equal(dup2.promoted, 0, "[regen-dup]");
  assert.equal(regenEvents(t.kv), 1, "[regen-dup] um delivery_sent");
  assert.equal(toCustomer(t.emails).length, 1, "[regen-dup] um e-mail");
  // Queda depois de promover e antes de fechar o candidato: converge sem nova promoção.
  const u = legacyEnv(contaminatedLegacy());
  await regenPost(u);
  const uput = u.kv.put.bind(u.kv);
  let once = true;
  u.kv.put = async (k, v, o) => { if (once && k.startsWith("zpc:cp:regen:") && JSON.parse(v).promotedAt) { once = false; throw new Error("isolate killed"); } return uput(k, v, o); };
  await assert.rejects(deliver(u), /isolate killed/);
  const promotedAt = recOf(u).regeneratedAt;
  await CS.reconcileRegenCandidates(u.env, u.fetchImpl);
  assert.equal(recOf(u).lastPackage, candOf(u).candidate_key, "[regen-converge] continua atual");
  assert.equal(recOf(u).regeneratedAt, promotedAt, "[regen-converge] sem segunda promoção");
  assert.ok(candOf(u).promotedAt && !candOf(u).superseded, "[regen-converge] fechado, não superseded");
  assert.equal(regenEvents(u.kv), 1, "[regen-converge] um delivery_sent");
  // email_id diferente nunca confirma.
  const w = legacyEnv(contaminatedLegacy());
  await regenPost(w);
  assert.equal((await CS.applyRegenDelivered(w.env, candOf(w).key, "re_999", w.fetchImpl)).promoted, false, "[regen-emailid] outro email_id não promove");
  assert.equal(recOf(w).lastPackage, w.legacyKey, "[regen-emailid]");
});

test("(g4) persistência: candidato ou outbox não gravados => 503 exato, nenhum envio; pacote do candidato imutável e único", async () => {
  for (const target of ["candidato", "outbox"]) {
    const t = legacyEnv(contaminatedLegacy());
    const put = t.kv.put.bind(t.kv);
    let fail = true;
    t.kv.put = async (k, v, o) => {
      const hit = target === "candidato" ? k.startsWith("zpc:cp:regen:") : k === "zpc:cp:regen-outbox";
      if (fail && hit) { fail = false; throw new Error("kv indisponível"); }
      return put(k, v, o);
    };
    const res = await regenPost(t);
    const html = await res.text();
    assert.equal(res.status, 503, `[regen-persist] ${target}: 503`);
    assert.ok(html.includes(CS.REGEN_MSG.persist), `[regen-persist] ${target}: mensagem exata`);
    assert.equal(customerPosts(t).length, 0, `[regen-persist] ${target}: nenhum envio sem registro durável`);
    assert.equal(recOf(t).lastPackage, t.legacyKey, `[regen-persist] ${target}`);
    assert.equal(t.kv.data.get(t.legacyKey), t.raw, `[legacy-bytes] persist ${target}`);
    const pkgKeys = [...t.kv.data.keys()].filter(isCandPkg);
    const before = pkgKeys.map((k) => t.kv.data.get(k));
    const again = await regenPost(t);
    assert.equal(again.status, 202, `[regen-persist] ${target}: retomada (accepted = 202)`);
    assert.equal(t.ai.prompts.length, 3, `[regen-single] ${target}: pacote do candidato reaproveitado`);
    assert.deepEqual(pkgKeys.map((k) => t.kv.data.get(k)), before, `[regen-immutable] ${target}`);
    const cand = candOf(t);
    assert.equal(createHash("sha256").update(t.kv.data.get(cand.candidate_key)).digest("hex"), cand.hash, `[regen-immutable] ${target}: hash`);
  }
  // Muitas tentativas => um candidato, um pacote novo.
  const t = legacyEnv(contaminatedLegacy());
  t.resend.mode = 500;
  for (let i = 0; i < 4; i++) await regenPost(t);
  candOf(t);
  assert.equal([...t.kv.data.keys()].filter(isCandPkg).length, 1, "[regen-single] um pacote candidato");
  assert.equal(t.ai.prompts.length, 3, "[regen-single] uma geração");
});

test("(g5) janelas: pending > 23 h vira dead sem chamar o Resend; accepted > 72 h sem confirmação vira dead; ambos com alerta", async () => {
  const t = legacyEnv(contaminatedLegacy());
  t.resend.mode = 500;
  assert.equal((await regenPost(t)).status, 202);
  const c = candOf(t);
  t.kv.data.set(c.key, JSON.stringify({ ...JSON.parse(t.kv.data.get(c.key)), firstAttemptAt: new Date(Date.now() - (CS.REGEN_SEND_WINDOW_HOURS * 3600000 + 60000)).toISOString() }));
  t.resend.mode = "ok";
  const res = await regenPost(t);
  assert.equal(customerPosts(t).length, 1, "[regen-window] sem chamada ao Resend fora da janela");
  assert.equal(res.status, 409, "[regen-window] dead");
  assert.equal(candOf(t).delivery, "dead", "[regen-window] dead");
  assert.equal(ownerAlerts(t).length, 1, "[regen-window] alerta");
  assert.equal(recOf(t).lastPackage, t.legacyKey, "[regen-window] não promovido");
  const u = legacyEnv(contaminatedLegacy());
  await regenPost(u);
  const r = await CS.reconcileRegenCandidates(u.env, u.fetchImpl, { now: Date.now() + (CS.REGEN_ACCEPTED_MAX_HOURS * 3600000 + 60000) });
  assert.equal(r.dead, 1, "[regen-accepted-timeout] dead");
  assert.equal(candOf(u).delivery, "dead", "[regen-accepted-timeout]");
  assert.equal(ownerAlerts(u).length, 1, "[regen-accepted-timeout] alerta");
  assert.equal(recOf(u).lastPackage, u.legacyKey, "[regen-accepted-timeout] não promovido");
});

test("(g6) pacote v2 gravado contaminado em curta, assunto ou corpo: bloqueado como o legado; candidato nunca sobrescreve o v2 bloqueado", async () => {
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
      const t = legacyEnv(pkg);
      const html = await (await CS.handlePackageView(new Request(t.url), t.env, null, t.fetchImpl)).text();
      assert.doesNotMatch(html, LEAK(value), "[v2-html-leak] " + where);
      assert.ok(html.includes(CS.BLOQUEIO_TEXTO) && html.includes("Gerar versão nova sem custo"), "[v2-offer] " + where);
      assert.doesNotMatch(CS.packageText(pkg), LEAK(value), "[v2-text-leak] " + where);
      cases++;
    }
  }
  assert.equal(cases, Object.keys(V2_FIELDS).length * CONTAMINANTS.length);
  const pkg = v2(); V2_FIELDS["roteiros.curta"](pkg, "Chame no WhatsApp");
  const t = legacyEnv(pkg);
  const v2Key = t.legacyKey + ":v" + C.content_schema_version;
  const rec0 = recOf(t);
  t.kv.data.set(v2Key, t.raw); t.kv.data.delete(t.legacyKey);
  t.kv.data.set(t.sub, JSON.stringify({ ...rec0, lastPackage: v2Key }));
  assert.equal((await regenPost(t)).status, 202, "[v2-regen] candidato aceito (202)");
  await deliver(t);
  const rec = recOf(t);
  assert.notEqual(rec.lastPackage, v2Key, "[v2-bytes] chave nova");
  assert.equal(t.kv.data.get(v2Key), t.raw, "[v2-bytes] bytes do v2 bloqueado intactos");
  assert.equal(CS.packageBlocked(JSON.parse(t.kv.data.get(rec.lastPackage))), false, "[v2-bytes] versão nova limpa");
});

test("(g7) texto ao cliente: nenhuma mensagem de regeneração diz chegou/entregue/enviada; só a de delivered fala em entrega confirmada", () => {
  const src = read("worker/content-service.mjs");
  const a = src.indexOf("// ---------- Regeneração de pacote bloqueado"), b = src.indexOf("export async function handlePackageView");
  assert.ok(a > 0 && b > a, "[regen-copy] seção de regeneração localizada");
  assert.doesNotMatch(src.slice(a, b), /chegou|entregue|foi enviad/i, "[regen-copy] fonte da regeneração");
  for (const [k, v] of Object.entries(CS.REGEN_MSG)) {
    const text = typeof v === "function" ? v("CPR-0000000000") : v;
    if (k === "delivered") assert.equal(text, "Pronto! A entrega da versão nova foi confirmada no seu e-mail.", "[regen-copy] delivered exato");
    else assert.ok(!COPY_FORBIDDEN.test(text), "[regen-copy] " + k);
  }
  assert.equal(CS.REGEN_MSG.accepted, "A versão nova foi gerada e o provedor aceitou o envio. A entrega ao seu e-mail ainda está sendo confirmada.", "[regen-copy] accepted exato");
  assert.equal(CS.REGEN_MSG.pending("P-1"), "A versão nova foi gerada, mas o envio ainda está pendente. Continuaremos tentando sem gerar outra cópia nem fazer qualquer cobrança. Use o protocolo P-1 para acompanhar pelo suporte.", "[regen-copy] pending exato");
  assert.equal(CS.REGEN_MSG.persist, "Não foi possível registrar a regeneração com segurança agora. A versão antiga continua bloqueada e não foi exibida nem alterada. Tente novamente mais tarde ou escreva para suporte@zevanory.api.br. Nenhuma nova entrega foi confirmada.", "[regen-copy] persist exato");
  assert.deepEqual(CS.regenResponse({ reason: "accepted" }), [202, CS.REGEN_MSG.accepted], "[regen-copy] accepted 202");
  assert.deepEqual(CS.regenResponse({ reason: "pending", protocolo: "X" }), [202, CS.REGEN_MSG.pending("X")], "[regen-copy] pending 202");
  assert.deepEqual(CS.regenResponse({ reason: "persist_failed" }), [503, CS.REGEN_MSG.persist], "[regen-copy] persist 503");
  assert.deepEqual(CS.regenResponse({ reason: "delivered" }), [200, CS.REGEN_MSG.delivered], "[regen-copy] delivered");
});
