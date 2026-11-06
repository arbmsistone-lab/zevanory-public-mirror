// Conteúdo Pronto v3 (Sol AVAL 304): cada pacote mensal É uma campanha de promoção de vendas do assinante.
//   (1) o briefing do mês exige objetivo comercial, oferta, condição comercial e período; o gerador recusa sem eles;
//   (2) todo post e todo roteiro ancorado na campanha (oferta, condição, fases, calendário no período);
//   (4) página, oferta, atendimento, chat e descrições fiscal/Hotmart propostas descrevem exatamente esse serviço.
// DEC-14 (consenso Claude+GPT-6; DEC-04): os 21 testes deste arquivo que chamavam o pipeline legado em KV removido
// pelo NC-012 (handleHotmartWebhook, handleBriefing, lembretes, boas-vindas, entrega, reembolsos e operador) e o
// [camp-regen-mes] (regeneração em KV removida pelo DEC-14(b)) foram APOSENTADOS por mudança de escopo, um a um, em
// docs/ops/dec14-cp-retirement-registry.json, com o teste substituto de cada um (os [do][camp-*] de
// scripts/cp-nc014-l1-campaign.test.mjs e os [dec14-*] abaixo, que reconstroem sem KV as asserções puras que ainda
// matam mutantes vivos). Offline: IA simulada, rede bloqueada, nenhum KV.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import * as CS from "../worker/content-service.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { validateSiteReply } from "../worker/site-chat.mjs";
import { validateReply } from "../worker/whatsapp-conversation.mjs";
import { CAMPAIGN, campaignize, isoDay, plusDays } from "./helpers/cp-campaign.mjs";
import { cpSalesEnabled } from "../worker/nc015-sales-scope.mjs";

globalThis.fetch = async (u) => { throw new Error("rede bloqueada no teste: " + u); };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readTextNormalized(join(ROOT, rel));
const P = JSON.parse(read("data/politica-unica.json"));
const C = P.conteudo_pronto;
const BRIEF = { negocio: "Salão Bela", ramo: "salão de beleza", publico: "mulheres de 25 a 50 anos", produtos: "corte e escova", diferencial: "atendimento rápido", tom: "próximo", contato: "e-mail e Instagram Direct" };
const legenda = (i) => `Tema ${i}: atendimento com hora marcada, produtos de qualidade e equipe que explica cada etapa do serviço. Venha conhecer o salão e escolha o melhor horário para você, sem pressa e sem surpresa no valor.`;
const post = (i, fase) => ({ tema: "Tema " + i, legenda: legenda(i), cta: "Agende pelo Direct", hashtags: ["#salao", "#escova"], imagem: "foto da escova pronta, luz natural", ...(fase ? { fase } : {}) });
const roteiro = (o) => ({ objetivo_id: o.id, curta: "Olá! Aqui é do Salão Bela. Posso te passar os detalhes da nossa campanha e reservar um horário? Respondo por aqui mesmo.", email: { assunto: o.titulo + " · Salão Bela", corpo: "Olá! Obrigada pelo contato com o Salão Bela. ".repeat(6) + "Se fizer sentido, responda com o melhor dia." } });
function ai({ mode = "ok" } = {}) {
  const calls = [];
  return { calls, run: async (_m, input) => {
    const u = input.messages[1].content;
    calls.push(u);
    if (u.includes("roteiros multicanal")) return { response: JSON.stringify(mode === "sem_ancora" ? { roteiros: CS.ROTEIRO_OBJETIVOS.map(roteiro) } : campaignize(u, { roteiros: CS.ROTEIRO_OBJETIVOS.map(roteiro) })) };
    const from = Number(/posts (\d+) a/.exec(u)[1]);
    let posts = [0, 1, 2, 3, 4, 5].map((k) => post(from + k));
    posts = campaignize(u, { posts }).posts;
    if (mode === "uma_fase") posts = posts.map((p) => ({ ...p, fase: "anuncio" }));
    return { response: JSON.stringify({ posts }) };
  } };
}
const norm = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

test("[camp-recusa] sem campanha completa e válida o gerador recusa, sem chamar a IA", async () => {
  const a = ai();
  for (const f of CS.CAMPANHA_CAMPOS) {
    const { [f.id]: _drop, ...sem } = CAMPAIGN;
    assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1, sem), null, "[camp-recusa] sem " + f.id);
  }
  assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1), null, "[camp-recusa] sem campanha");
  for (const [label, c] of [["6 dias", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, 5) }], ["31 dias", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, 30) }], ["fim antes do início", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, -1) }],
    ["data inválida", { ...CAMPAIGN, periodo_inicio: "02/11/2026" }], ["promessa de resultado", { ...CAMPAIGN, condicao_comercial: "venda garantida ou seu dinheiro de volta" }], ["canal banido", { ...CAMPAIGN, condicao_comercial: "chame no WhatsApp" }]]) {
    assert.equal(CS.validateCampaign(c).ok, false, "[camp-recusa] " + label);
    assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1, c), null, "[camp-recusa] gerador: " + label);
  }
  assert.equal(a.calls.length, 0, "[camp-recusa] nenhuma chamada de IA");
  assert.equal(CS.validateCampaign(CAMPAIGN).ok, true, "[camp-recusa] campanha válida aceita");
});

test("[camp-ancora] validadores: post sem a oferta ou sem fase, roteiro sem a oferta ou sem a condição são recusados", () => {
  const ok = CS.FASES.map((fz, i) => ({ ...post(i + 1, fz.id), legenda: legenda(i + 1) + " " + CAMPAIGN.oferta + "." }));
  assert.equal(CS.validatePosts(ok, 6, CAMPAIGN).length, 6);
  assert.equal(CS.validatePosts([post(1, "anuncio")], 1, CAMPAIGN), null, "[camp-ancora] post sem a oferta");
  assert.equal(CS.validatePosts([{ ...ok[0], fase: "" }], 1, CAMPAIGN), null, "[camp-ancora] post sem fase");
  assert.equal(CS.validatePosts([{ ...ok[0], fase: "urgencia" }], 1, CAMPAIGN), null, "[camp-ancora] fase fora do contrato");
  const rs = campaignize(`Oferta promovida: ${CAMPAIGN.oferta}\nCondição comercial: ${CAMPAIGN.condicao_comercial}`, { roteiros: CS.ROTEIRO_OBJETIVOS.map(roteiro) }).roteiros;
  assert.equal(CS.validateRoteiros(rs, CAMPAIGN).length, 4);
  assert.equal(CS.validateRoteiros(CS.ROTEIRO_OBJETIVOS.map(roteiro), CAMPAIGN), null, "[camp-ancora] roteiros sem a oferta");
  const semCond = rs.map((r) => ({ ...r, email: { ...r.email, corpo: r.email.corpo.replace(CAMPAIGN.condicao_comercial, "condição especial") } }));
  assert.equal(CS.validateRoteiros(semCond, CAMPAIGN), null, "[camp-ancora] e-mail sem a condição comercial");
  const outraCurta = rs.map((r, i) => (i === 1 ? { ...r, curta: roteiro(CS.ROTEIRO_OBJETIVOS[1]).curta } : r));
  assert.equal(CS.validateRoteiros(outraCurta, CAMPAIGN), null, "[camp-ancora] versão curta sem a oferta");
});

test("[camp-ancora] IA que não ancora ou não cobre as seis fases: nenhum pacote", async () => {
  assert.equal(await CS.generatePackage({ AI: ai({ mode: "uma_fase" }) }, BRIEF, 1, CAMPAIGN), null, "[camp-ancora] fases não cobertas");
  assert.equal(await CS.generatePackage({ AI: ai({ mode: "sem_ancora" }) }, BRIEF, 1, CAMPAIGN), null, "[camp-ancora] roteiros sem âncora");
});

test("[camp-pacote] pacote = campanha: campanha gravada, posts e roteiros ancorados, seis fases, calendário com datas no período", async () => {
  const pkg = await CS.generatePackage({ AI: ai() }, BRIEF, 2, CAMPAIGN);
  assert.ok(pkg, "[camp-pacote] gerado");
  assert.equal(pkg.schema, "zpc.cp.package.v3");
  assert.equal(pkg.servico, C.servico);
  assert.deepEqual(pkg.campanha, { ...CAMPAIGN }, "[camp-pacote] campanha gravada no pacote");
  for (const p of pkg.posts) assert.ok(norm(p.legenda + p.cta).includes(norm(CAMPAIGN.oferta)), "[camp-pacote] post cita a oferta");
  for (const r of pkg.roteiros) assert.ok(norm(r.curta).includes(norm(CAMPAIGN.oferta)) && norm(r.email.corpo).includes(norm(CAMPAIGN.condicao_comercial)), "[camp-pacote] roteiro ancorado");
  assert.equal(new Set(pkg.posts.map((p) => p.fase)).size, CS.FASES.length, "[camp-pacote] seis fases");
  assert.equal(pkg.calendario.length, C.posts + C.roteiros);
  assert.ok(pkg.calendario.every((c, i, a) => c.data >= CAMPAIGN.periodo_inicio && c.data <= CAMPAIGN.periodo_fim && (i === 0 || a[i - 1].data <= c.data)), "[camp-pacote] calendário no período e em ordem");
  assert.equal(pkg.calendario[0].data, CAMPAIGN.periodo_inicio, "[camp-pacote] começa no início");
  assert.equal(pkg.calendario.filter((c) => c.tipo === "post").at(-1).data, CAMPAIGN.periodo_fim, "[camp-pacote] último post no fim");
  const txt = CS.packageText(pkg, "Salão Bela");
  for (const k of ["CAMPANHA DO MÊS", `Oferta promovida: ${CAMPAIGN.oferta}`, `Condição comercial: ${CAMPAIGN.condicao_comercial}`, "CALENDÁRIO DA CAMPANHA"]) assert.ok(txt.includes(k), "[camp-pacote] texto: " + k);
  // Rodada 8: as datas da campanha são relativas a hoje (helpers/cp-campaign.mjs); o literal fixo "02/11/2026 a
  // 29/11/2026" só passava no dia 28/10/2026 e quebrava a suíte em qualquer outro dia.
  const brDate = (iso) => iso.split("-").reverse().join("/");
  assert.ok(txt.includes(`Período: ${brDate(CAMPAIGN.periodo_inicio)} a ${brDate(CAMPAIGN.periodo_fim)}`), "[camp-pacote] período do texto = período da campanha");
});

test("[camp-textos] página, oferta, atendimento, chat e descrições fiscal/Hotmart descrevem a campanha mensal de promoção de vendas", () => {
  const caract = P.resumo_oferta.assinatura.caracteristicas;
  const page = read("conteudo-pronto/index.html");
  const built = read("sales-public/conteudo-pronto.html");
  const sup = SUPPORT_PRODUCTS["conteudo-pronto"].content;
  const chat = JSON.parse(read("data/site-chat-policy.json")).closed_summaries["conteudo-pronto"];
  // DEC-04 (fase 1): com o CP oculto, a página-fonte e a gerada são a lápide (sem oferta); os demais textos
  // (oferta, atendimento, chat, fiscal, Hotmart) continuam descrevendo a campanha. Ligado, a página volta a ser exigida.
  const live = cpSalesEnabled();
  if (!live) for (const [nome, t] of [["página", page], ["página gerada", built]]) {
    assert.match(t, /<meta name="robots" content="noindex,nofollow">/, "[camp-textos] lápide noindex: " + nome);
    assert.doesNotMatch(t, /R\$|data-zev-sub|\/assinar\/|pay\.hotmart\.com|promoção/i, "[camp-textos] lápide sem oferta: " + nome);
  }
  const pages = (rows) => rows.filter(([nome]) => live || !nome.startsWith("página"));
  for (const [nome, t] of pages([["oferta", caract], ["página", page], ["página gerada", built], ["atendimento", sup], ["chat", chat], ["fiscal", C.descricao_fiscal_proposta], ["hotmart", C.descricao_hotmart_proposta]])) {
    assert.match(t, /campanha (mensal )?de promoção de vendas/i, "[camp-textos] " + nome);
  }
  for (const [nome, t] of pages([["oferta", caract], ["página", page], ["atendimento", sup], ["fiscal", C.descricao_fiscal_proposta], ["hotmart", C.descricao_hotmart_proposta]])) {
    assert.match(t, /objetivo comercial/i, "[camp-textos] objetivo comercial: " + nome);
    assert.match(t, /condição comercial/i, "[camp-textos] condição comercial: " + nome);
  }
  // Nada além do entregue: sem publicação, sem disparo, sem anúncio, sem garantia de resultado.
  for (const [nome, t] of pages([["página", page], ["hotmart", C.descricao_hotmart_proposta], ["fiscal", C.descricao_fiscal_proposta]])) {
    assert.doesNotMatch(t, /publicamos (nas|por)|enviamos as mensagens|gerenciamos (seus )?anúncios|resultado garantido|vendas garantidas/i, "[camp-textos] nada além do entregue: " + nome);
  }
  if (live) assert.match(page, /Escolher a oferta ou a condição comercial por você/, "[camp-textos] a condição é do assinante");
  // O nome do serviço passa nos validadores do chat e do atendimento; "promoção" fora dele continua bloqueada.
  const nome = "O Conteúdo Pronto é uma campanha mensal de promoção de vendas da oferta que você escolher.";
  assert.equal(validateSiteReply(nome).ok, true, "[camp-textos] chat aceita o nome do serviço");
  assert.ok(!validateReply(nome).issues.includes("discount"), "[camp-textos] atendimento aceita o nome do serviço");
  for (const t of ["Aproveite a promoção de hoje.", "Temos uma promoção de vendas para você."]) {
    assert.ok(validateSiteReply(t).issues.includes("discount_or_urgency"), "[camp-textos] chat ainda bloqueia: " + t);
    assert.ok(validateReply(t).issues.includes("discount"), "[camp-textos] atendimento ainda bloqueia: " + t);
  }
  if (live) assert.match(page, /data-content-schema="3"/);
});

test("[camp-ancora-vazia] palavras vazias não ancoram: oferta ou condição só com 'de'/'da' é recusada; âncora é palavra inteira", () => {
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, oferta: "de" }).ok, false, "[camp-ancora-vazia] oferta 'de'");
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, condicao_comercial: "da" }).ok, false, "[camp-ancora-vazia] condição 'da'");
  const semOferta = [1, 2, 3, 4, 5, 6].map((i) => ({ ...post(i, CS.FASES[i - 1].id), legenda: legenda(i) + " Venha de manhã ou de tarde." }));
  assert.equal(CS.validatePosts(semOferta, 6, { ...CAMPAIGN, oferta: "de" }), null, "[camp-ancora-vazia] posts sem oferta não passam com oferta 'de'");
  const parcial = [1, 2, 3, 4, 5, 6].map((i) => ({ ...post(i, CS.FASES[i - 1].id), legenda: legenda(i) + " Escovação completa." }));
  assert.equal(CS.validatePosts(parcial, 6, { ...CAMPAIGN, oferta: "Escova" }), null, "[camp-ancora-vazia] 'Escovação' não ancora 'Escova'");
  assert.equal(CS.anchored("Hoje tem Escova Quarta Feliz.", CAMPAIGN.oferta), true, "[camp-ancora-vazia] oferta citada ancora");
  for (const o of ["produto", "serviço especial", "nossa oferta"]) assert.equal(CS.validateCampaign({ ...CAMPAIGN, oferta: o }).ok, false, "[camp-ancora-vazia] oferta genérica recusada: " + o);
  assert.equal(CS.anchored("Conheça nosso produto.", "produto"), false, "[camp-ancora-vazia] palavra genérica sozinha não ancora");
});

test("[camp-promessa] condição com promessa de resultado é recusada e nunca é exigida no e-mail; textos gerados também", () => {
  for (const c of ["dobre suas vendas", "100% de lucro", "garantimos que você vai vender", "satisfação garantida ou seu dinheiro de volta", "venda mais com risco zero", "aumente seu faturamento"]) {
    assert.equal(CS.validateCampaign({ ...CAMPAIGN, condicao_comercial: c }).ok, false, "[camp-promessa] condição recusada: " + c);
  }
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, condicao_comercial: "garantia de 90 dias no conserto" }).ok, true, "[camp-promessa] garantia de produto com prazo passa");
  const camp = { ...CAMPAIGN, condicao_comercial: "dobre suas vendas" };
  const rots = CS.ROTEIRO_OBJETIVOS.map((o) => campaignize(CS.roteirosPrompt("b", camp), { roteiros: [roteiro(o)] }).roteiros[0]);
  assert.equal(CS.validateRoteiros(rots, camp), null, "[camp-promessa] promessa nunca exigida no e-mail");
  const ok = CS.ROTEIRO_OBJETIVOS.map((o) => campaignize(CS.roteirosPrompt("b", CAMPAIGN), { roteiros: [roteiro(o)] }).roteiros[0]);
  assert.ok(CS.validateRoteiros(ok, CAMPAIGN), "[camp-promessa] campanha sem promessa passa");
  const comPromessa = ok.map((r) => ({ ...r, email: { ...r.email, corpo: r.email.corpo + " Você vai vender mais." } }));
  assert.equal(CS.validateRoteiros(comPromessa, CAMPAIGN), null, "[camp-promessa] e-mail gerado com promessa recusado");
});

test("[camp-promessa-lista] portão de promessa só para resultado de vendas/renda/desempenho; frases promocionais comuns passam; o prompt avisa o modelo", async () => {
  const proibidas = ["dobre suas vendas", "100% de lucro", "garantimos que você vai vender", "satisfação garantida ou seu dinheiro de volta", "venda mais com risco zero", "aumente seu faturamento",
    "você vai lucrar o dobro", "faturamento em dobro", "retorno de 300% no investimento", "satisfação total ou seu dinheiro devolvido", "resultados em 7 dias", "faturamento garantido", "resultado garantido", "clientes garantidos", "Você vai vender muito"];
  const permitidas = ["vaga garantida", "seu horário garantido", "entrega garantida até sexta", "Quer vender mais?", "Com certeza você vai amar", "garantia de 90 dias no conserto", "15% na segunda escova"];
  for (const t of proibidas) { assert.equal(CS.promessa(t), true, "[camp-promessa-lista] recusa: " + t); assert.equal(CS.validateCampaign({ ...CAMPAIGN, condicao_comercial: t }).ok, false, "[camp-promessa-lista] campanha recusa: " + t); }
  for (const t of permitidas) assert.equal(CS.promessa(t), false, "[camp-promessa-lista] permite: " + t);
  const fases = CS.FASES.map((x) => x.id);
  const mk = (extra) => [1, 2, 3, 4, 5, 6].map((i) => ({ ...post(i, fases[i - 1]), legenda: legenda(i) + " " + CAMPAIGN.oferta + ". " + extra }));
  assert.ok(CS.validatePosts(mk("Vaga garantida e horário garantido. Com certeza você vai amar."), 6, CAMPAIGN), "[camp-promessa-lista] post promocional comum passa");
  assert.equal(CS.validatePosts(mk("Você vai vender o dobro."), 6, CAMPAIGN), null, "[camp-promessa-lista] post com promessa recusado");
  const systems = [];
  await CS.generatePackage({ AI: { run: async (_m, input) => { systems.push(input.messages[0].content); return { response: "{}" }; } } }, BRIEF, 1, CAMPAIGN);
  assert.ok(systems.length && systems.every((s) => s.includes(CS.PROMESSAS_PROIBIDAS)), "[camp-promessa-lista] lista de promessas proibidas no prompt");
});

test("[camp-correcao] recusa por promessa: uma nova chamada corretiva antes de contar a tentativa como falha", async () => {
  const calls = [];
  let dirty = 1;
  const a = { calls, run: async (_m, input) => {
    const u = input.messages[1].content;
    calls.push(u);
    if (u.includes("roteiros multicanal")) return { response: JSON.stringify(campaignize(u, { roteiros: CS.ROTEIRO_OBJETIVOS.map(roteiro) })) };
    const from = Number(/posts (\d+) a/.exec(u)[1]);
    let posts = campaignize(u, { posts: [0, 1, 2, 3, 4, 5].map((k) => post(from + k)) }).posts;
    if (dirty-- > 0) posts = posts.map((p) => ({ ...p, legenda: p.legenda + " Você vai vender o dobro." }));
    return { response: JSON.stringify({ posts }) };
  } };
  const pkg = await CS.generatePackage({ AI: a }, BRIEF, 1, CAMPAIGN);
  assert.ok(pkg, "[camp-correcao] pacote gerado depois da correção");
  assert.equal(calls.length, 4, "[camp-correcao] 3 chamadas + 1 corretiva");
  assert.ok(calls[1].includes(CS.CORRECAO_PROMESSA), "[camp-correcao] a segunda chamada leva a instrução corretiva");
  assert.ok(CS.GEN_WORST_CASE_MS >= 3 * (2 * 2 + 1) * 60000 && CS.GEN_LEASE_MS > CS.GEN_WORST_CASE_MS, "[camp-correcao] lease cobre a chamada corretiva");
});

// ---------- DEC-14: reconstrução sem KV das asserções puras dos testes aposentados ----------
// Cada [dec14-*] substitui a parte PURA de um teste aposentado (o resto dependia do webhook/formulário em KV removidos)
// e é a prova causal primária dos mutantes que miram código que continua no repositório.
test("[dec14-datas] validateCampaign recusa data inexistente, início no passado ou longe demais (substitui a parte pura de [camp-datas])", () => {
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, periodo_inicio: "2027-02-30", periodo_fim: "2027-03-20" }).ok, false, "[dec14-datas] 30/02 recusado");
  const now = Date.now();
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, periodo_inicio: isoDay(-3), periodo_fim: isoDay(10) }, { now }).ok, false, "[dec14-datas] início no passado");
  const far = { ...CAMPAIGN, periodo_inicio: isoDay(CS.CAMPANHA_INICIO_MAX_DIAS + 5), periodo_fim: isoDay(CS.CAMPANHA_INICIO_MAX_DIAS + 20) };
  assert.equal(CS.validateCampaign(far, { now }).ok, false, "[dec14-datas] início longe demais");
  assert.equal(CS.validateCampaign(CAMPAIGN, { now }).ok, true, "[dec14-datas] período válido aceito");
});

test("[dec14-fuso] hoje e limite pela data civil de Brasília (viradas UTC, de mês, de ano, 29/02); data impossível sem exceção (substitui a parte pura de [camp-fuso])", () => {
  const at = (iso) => Date.parse(iso);
  const camp = (ini, fim) => ({ ...CAMPAIGN, periodo_inicio: ini, periodo_fim: fim ?? plusDays(ini, 14) });
  const ok = (ini, nowIso, fim) => CS.validateCampaign(camp(ini, fim), { now: at(nowIso) }).ok;
  assert.deepEqual(["2026-11-02T23:59:00Z", "2026-11-03T00:00:00Z", "2026-11-03T02:59:00Z", "2026-11-03T03:00:00Z"].map((x) => CS.civilDaySP(at(x))),
    ["2026-11-02", "2026-11-02", "2026-11-02", "2026-11-03"], "[dec14-fuso] data civil de Brasília");
  assert.equal(ok("2026-11-02", "2026-11-02T23:59:00Z"), true, "[dec14-fuso] 20h59 de Brasília é hoje");
  assert.equal(ok("2026-11-02", "2026-11-03T00:00:00Z"), true, "[dec14-fuso] 21h de Brasília ainda é hoje");
  assert.equal(ok("2026-11-02", "2026-11-03T02:59:00Z"), true, "[dec14-fuso] 23h59 de Brasília ainda é hoje");
  assert.equal(ok("2026-11-02", "2026-11-03T03:00:00Z"), false, "[dec14-fuso] 00h de Brasília: ontem já passou");
  const max = plusDays("2026-11-02", CS.CAMPANHA_INICIO_MAX_DIAS);
  assert.equal(ok(max, "2026-11-03T00:00:00Z"), true, "[dec14-fuso] limite de dias: último dia aceito");
  assert.equal(ok(plusDays(max, 1), "2026-11-03T00:00:00Z"), false, "[dec14-fuso] limite de dias pela data de Brasília");
  assert.equal(ok("2026-10-31", "2026-11-01T02:30:00Z"), true, "[dec14-fuso] 31/10 23h30 de Brasília ainda é 31/10");
  assert.equal(ok("2026-10-31", "2026-11-01T03:00:00Z"), false, "[dec14-fuso] 01/11 00h de Brasília: 31/10 passou");
  assert.equal(ok("2026-12-31", "2027-01-01T01:00:00Z", "2027-01-15"), true, "[dec14-fuso] 31/12 22h de Brasília ainda é 31/12");
  assert.equal(ok("2026-12-31", "2027-01-01T03:00:00Z", "2027-01-15"), false, "[dec14-fuso] 01/01 00h de Brasília: 31/12 passou");
  assert.equal(CS.civilDaySP(at("2028-03-01T00:30:00Z")), "2028-02-29", "[dec14-fuso] 29/02/2028 21h30 de Brasília");
  assert.equal(ok("2028-02-29", "2028-03-01T00:30:00Z", "2028-03-14"), true, "[dec14-fuso] 29/02/2028 aceito no próprio dia");
  assert.equal(CS.validateCampaign(camp("2027-02-29", "2027-03-14")).ok, false, "[dec14-fuso] 29/02/2027 não existe");
  for (const v of ["2026-13-01", "2026-02-30", "2026-00-10", "abc", ""]) {
    let r = null, threw = null;
    try { r = CS.validateCampaign(camp(v, "2026-11-20")); } catch (err) { threw = err; }
    assert.ok(!threw, "[dec14-fuso] data impossível sem exceção: " + JSON.stringify(v));
    assert.equal(r.ok, false); assert.match(r.error, /data válida/, "[dec14-fuso] erro de validação: " + JSON.stringify(v));
  }
});

test("[dec14-reembolso-texto] /reembolso (fonte e gerada) traz a regra única do contrato, o prazo e o caminho Hotmart (substitui a parte pura de [camp-reembolso-prazo])", () => {
  assert.match(C.mes_sem_campanha, new RegExp(`O estorno é processado em até ${C.reembolso_prazo_dias_uteis} dias úteis`), "[dec14-reembolso-texto] prazo no texto único");
  for (const rel of ["reembolso/index.html", "sales-public/reembolso.html"]) {
    const html = read(rel);
    assert.ok(html.includes(C.mes_sem_campanha), "[dec14-reembolso-texto] regra do Conteúdo Pronto em " + rel);
    assert.match(html, /a instituição de pagamento é a Hotmart/, "[dec14-reembolso-texto] caminho Hotmart em " + rel);
  }
});
