// Conteúdo Pronto v3 (Sol AVAL 304): cada pacote mensal É uma campanha de promoção de vendas do assinante.
//   (1) o briefing do mês exige objetivo comercial, oferta, condição comercial e período; o gerador recusa sem eles;
//   (2) todo post e todo roteiro ancorado na campanha (oferta, condição, fases, calendário no período);
//   (3) entrega verificável (recibo com protocolo, SHA-256 e id do e-mail; confirmação pelo provedor);
//   (4) página, oferta, atendimento, chat e descrições fiscal/Hotmart propostas descrevem exatamente esse serviço;
//   (6) amostra operacional completa em modo seguro (IA e Resend simulados).
// Offline: KV em memória, IA e Resend simulados, rede bloqueada.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import * as CS from "../worker/content-service.mjs";
import { SUPPORT_PRODUCTS } from "../worker/support-knowledge.mjs";
import { validateSiteReply } from "../worker/site-chat.mjs";
import { validateReply } from "../worker/whatsapp-conversation.mjs";
import { CAMPAIGN, CAMPAIGN_MONTH2, campaignize } from "./helpers/cp-campaign.mjs";

globalThis.fetch = async (u) => { throw new Error("rede bloqueada no teste: " + u); };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readTextNormalized(join(ROOT, rel));
const P = JSON.parse(read("data/politica-unica.json"));
const C = P.conteudo_pronto;
class MapKV {
  data = new Map();
  async get(k) { return this.data.get(k) ?? null; }
  async put(k, v) { this.data.set(k, String(v)); }
  async delete(k) { this.data.delete(k); }
  async list({ prefix = "" } = {}) { return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; }
}
const HOTTOK = "hottok-local-campanha-0000000000";
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
function resend({ event = "delivered" } = {}) {
  const sent = [], events = new Map();
  const f = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.resend.com/emails")) throw new Error("fetch inesperado: " + u);
    if ((init.method || "GET") === "GET") { const id = u.split("/").pop(); return new Response(JSON.stringify({ id, last_event: events.get(id) || "sent" }), { status: 200 }); }
    const id = "em-" + (sent.length + 1);
    sent.push({ ...JSON.parse(init.body), id });
    events.set(id, event);
    return new Response(JSON.stringify({ id }), { status: 200 });
  };
  f.sent = sent;
  return f;
}
const env = (a) => ({ ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "stub", AI: a, OWNER_ALERT_EMAIL: "alertas@example.invalid" });
const hook = (event, txn, sub = "SUB-C3", email = "c3@example.invalid") => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK },
  body: JSON.stringify({ event, data: { product: { id: 8704905, name: CS.SERVICE_PRODUCT_NAME }, buyer: { email, name: "Assinante" }, purchase: { transaction: txn }, subscription: { subscriber: { code: sub } } } }) });
const tokenOf = (text, p) => new RegExp(p + "\\?t=([A-Za-z0-9_-]+)").exec(text)?.[1];
const submit = (e, f, t, fields) => CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams(fields) }), e, null, f);
const subKey = (kv) => [...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"));
const rec = (kv) => JSON.parse(kv.data.get(subKey(kv)));
async function subscribed(e, f) {
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-1"), e, null, f);
  return tokenOf(f.sent.find((m) => m.to[0] === "c3@example.invalid").text, "briefing");
}
const norm = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

test("[camp-recusa] sem campanha completa e válida o gerador recusa, sem chamar a IA", async () => {
  const a = ai();
  for (const f of CS.CAMPANHA_CAMPOS) {
    const { [f.id]: _drop, ...sem } = CAMPAIGN;
    assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1, sem), null, "[camp-recusa] sem " + f.id);
  }
  assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1), null, "[camp-recusa] sem campanha");
  for (const [label, c] of [["6 dias", { ...CAMPAIGN, periodo_fim: "2026-11-07" }], ["31 dias", { ...CAMPAIGN, periodo_fim: "2026-12-02" }], ["fim antes do início", { ...CAMPAIGN, periodo_fim: "2026-11-01" }],
    ["data inválida", { ...CAMPAIGN, periodo_inicio: "02/11/2026" }], ["promessa de resultado", { ...CAMPAIGN, condicao_comercial: "venda garantida ou seu dinheiro de volta" }], ["canal banido", { ...CAMPAIGN, condicao_comercial: "chame no WhatsApp" }]]) {
    assert.equal(CS.validateCampaign(c).ok, false, "[camp-recusa] " + label);
    assert.equal(await CS.generatePackage({ AI: a }, BRIEF, 1, c), null, "[camp-recusa] gerador: " + label);
  }
  assert.equal(a.calls.length, 0, "[camp-recusa] nenhuma chamada de IA");
  assert.equal(CS.validateCampaign(CAMPAIGN).ok, true, "[camp-recusa] campanha válida aceita");
});

test("[camp-form] formulário sem a campanha do mês responde 400 e nada entra na fila", async () => {
  const a = ai(), f = resend(), e = env(a), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t = await subscribed(e, f);
  const html = await (await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t), e, null, f)).text();
  for (const fd of CS.CAMPANHA_CAMPOS) assert.match(html, new RegExp(`name="${fd.id}"[^>]*required`), "[camp-form] campo obrigatório no formulário: " + fd.id);
  assert.equal((await submit(e, f, t, BRIEF)).status, 400, "[camp-form] sem campanha");
  assert.equal((await submit(e, f, t, { ...BRIEF, ...CAMPAIGN, periodo_fim: "2026-11-04" })).status, 400, "[camp-form] período curto");
  assert.equal(kv.data.get("zpc:cp:pending") ?? null, null, "[camp-form] nada na fila");
  assert.equal(a.calls.length, 0, "[camp-form] nenhuma chamada de IA");
  assert.equal(f.sent.filter((m) => /chegou/.test(m.subject)).length, 0);
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
  for (const k of ["CAMPANHA DO MÊS", `Oferta promovida: ${CAMPAIGN.oferta}`, `Condição comercial: ${CAMPAIGN.condicao_comercial}`, "Período: 02/11/2026 a 29/11/2026", "CALENDÁRIO DA CAMPANHA"]) assert.ok(txt.includes(k), "[camp-pacote] texto: " + k);
});

test("[camp-renovacao] renovação pede a campanha do mês e não gera nada até o assinante responder; fila descarta com registro", async () => {
  const a = ai(), f = resend(), e = env(a), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  const calls = a.calls.length;
  const r = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-2"), e, null, f)).json();
  assert.equal(r.status, "campaign_requested", "[camp-renovacao] status");
  assert.equal(a.calls.length, calls, "[camp-renovacao] nenhuma geração sem a campanha do mês");
  assert.ok(f.sent.some((m) => m.to[0] === "c3@example.invalid" && /defina a campanha do mês 2/.test(m.subject)), "[camp-renovacao] e-mail com o formulário");
  assert.deepEqual(await CS.generateAndDeliver(e, subKey(kv), f), { ok: false, reason: "campaign_required" }, "[camp-renovacao] entrega recusa sem campanha");
  kv.data.set("zpc:cp:pending", JSON.stringify([subKey(kv)]));
  await CS.retryPendingPackages(e, f);
  const log = JSON.parse(kv.data.get("zpc:cp:pending-log"));
  assert.ok(log.some((x) => x.event === "dropped" && x.reason === "campaign_required"), "[camp-renovacao] saída da fila registrada");
  // O formulário do mês 2 vem com o perfil preenchido e a campanha em branco.
  const t2 = tokenOf(f.sent.filter((m) => /defina a campanha/.test(m.subject)).at(-1).text, "briefing");
  const form = await (await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t2), e, null, f)).text();
  assert.match(form, /value="Salão Bela"/, "[camp-renovacao] perfil preenchido");
  assert.doesNotMatch(form, new RegExp(CAMPAIGN.oferta), "[camp-renovacao] campanha do mês anterior não é reaproveitada");
  await submit(e, f, t2, { ...BRIEF, ...CAMPAIGN_MONTH2 });
  assert.equal(JSON.parse(kv.data.get(rec(kv).lastPackage)).campanha.oferta, CAMPAIGN_MONTH2.oferta, "[camp-renovacao] mês 2 com a campanha nova");
});

test("[camp-entrega] entrega verificável: recibo com protocolo, SHA-256 e id; confirmação pelo provedor; falha registrada com alerta", async () => {
  for (const [event, status] of [["delivered", "confirmed"], ["bounced", "failed"]]) {
    const f = resend({ event }), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
    const r0 = rec(kv).deliveries[1];
    assert.match(r0.protocolo, /^CP-[0-9A-F]{10}$/, "[camp-entrega] protocolo");
    assert.equal(r0.sha256.length, 64, "[camp-entrega] SHA-256");
    assert.equal(r0.sha256, (await import("node:crypto")).createHash("sha256").update(kv.data.get(rec(kv).lastPackage)).digest("hex"), "[camp-entrega] SHA-256 do pacote gravado");
    assert.ok(r0.email_id && f.sent.some((m) => m.id === r0.email_id && /chegou/.test(m.subject)), "[camp-entrega] id do e-mail enviado");
    assert.equal(r0.status, "sent");
    const out = await CS.confirmPackageDeliveries(e, f);
    const r1 = rec(kv).deliveries[1];
    assert.equal(r1.status, status, "[camp-entrega] " + event);
    if (status === "failed") {
      assert.equal(out.failed, 1);
      assert.ok(f.sent.some((m) => m.to[0] === "alertas@example.invalid" && /não entregue/.test(m.subject)), "[camp-entrega] alerta de falha");
    } else {
      const pt = tokenOf(f.sent.find((m) => /chegou/.test(m.subject)).text, "pacote");
      const view = await (await CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + pt), e)).text();
      assert.match(view, new RegExp(`Recibo de entrega: protocolo ${r1.protocolo}[^<]*entrega confirmada pelo provedor`), "[camp-entrega] recibo na versão online");
      assert.match(view, new RegExp(`Oferta promovida:</b> ${CAMPAIGN.oferta}`), "[camp-entrega] campanha na versão online");
    }
  }
});

test("[camp-textos] página, oferta, atendimento, chat e descrições fiscal/Hotmart descrevem a campanha mensal de promoção de vendas", () => {
  const caract = P.resumo_oferta.assinatura.caracteristicas;
  const page = read("conteudo-pronto/index.html");
  const built = read("sales-public/conteudo-pronto.html");
  const sup = SUPPORT_PRODUCTS["conteudo-pronto"].content;
  const chat = JSON.parse(read("data/site-chat-policy.json")).closed_summaries["conteudo-pronto"];
  for (const [nome, t] of [["oferta", caract], ["página", page], ["página gerada", built], ["atendimento", sup], ["chat", chat], ["fiscal", C.descricao_fiscal_proposta], ["hotmart", C.descricao_hotmart_proposta]]) {
    assert.match(t, /campanha (mensal )?de promoção de vendas/i, "[camp-textos] " + nome);
  }
  for (const [nome, t] of [["oferta", caract], ["página", page], ["atendimento", sup], ["fiscal", C.descricao_fiscal_proposta], ["hotmart", C.descricao_hotmart_proposta]]) {
    assert.match(t, /objetivo comercial/i, "[camp-textos] objetivo comercial: " + nome);
    assert.match(t, /condição comercial/i, "[camp-textos] condição comercial: " + nome);
  }
  // Nada além do entregue: sem publicação, sem disparo, sem anúncio, sem garantia de resultado.
  for (const [nome, t] of [["página", page], ["hotmart", C.descricao_hotmart_proposta], ["fiscal", C.descricao_fiscal_proposta]]) {
    assert.doesNotMatch(t, /publicamos (nas|por)|enviamos as mensagens|gerenciamos (seus )?anúncios|resultado garantido|vendas garantidas/i, "[camp-textos] nada além do entregue: " + nome);
  }
  assert.match(page, /Escolher a oferta ou a condição comercial por você/, "[camp-textos] a condição é do assinante");
  // O nome do serviço passa nos validadores do chat e do atendimento; "promoção" fora dele continua bloqueada.
  const nome = "O Conteúdo Pronto é uma campanha mensal de promoção de vendas da oferta que você escolher.";
  assert.equal(validateSiteReply(nome).ok, true, "[camp-textos] chat aceita o nome do serviço");
  assert.ok(!validateReply(nome).issues.includes("discount"), "[camp-textos] atendimento aceita o nome do serviço");
  for (const t of ["Aproveite a promoção de hoje.", "Temos uma promoção de vendas para você."]) {
    assert.ok(validateSiteReply(t).issues.includes("discount_or_urgency"), "[camp-textos] chat ainda bloqueia: " + t);
    assert.ok(validateReply(t).issues.includes("discount"), "[camp-textos] atendimento ainda bloqueia: " + t);
  }
  assert.match(page, /data-content-schema="3"/);
});

test("[camp-amostra] amostra operacional completa (modo seguro) cumpre todos os critérios", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-amostra-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/conteudo-pronto/amostra_operacional.mjs"), dir], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr.slice(-2000));
    const R = JSON.parse(readTextNormalized(join(dir, "RESUMO.json")));
    for (const [k, v] of Object.entries(R.criterios)) assert.equal(v, true, "[camp-amostra] " + k);
    assert.equal(R.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
