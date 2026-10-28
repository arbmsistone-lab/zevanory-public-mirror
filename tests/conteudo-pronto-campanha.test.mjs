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
import { CAMPAIGN, CAMPAIGN_MONTH2, campaignize, isoDay, plusDays } from "./helpers/cp-campaign.mjs";

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
    return new Response(JSON.stringify({ id }), { status: f.status ?? 200 });
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
  for (const [label, c] of [["6 dias", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, 5) }], ["31 dias", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, 30) }], ["fim antes do início", { ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, -1) }],
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
  assert.equal((await submit(e, f, t, { ...BRIEF, ...CAMPAIGN, periodo_fim: plusDays(CAMPAIGN.periodo_inicio, 2) })).status, 400, "[camp-form] período curto");
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
  // Auditoria #953 H2 na renovação: o pedido da campanha que não sai entra na fila de formulários; o postback não conta
  // como processado até o envio; o cron reenvia o mesmo link.
  f.status = 500;
  const r3 = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-3"), e, null, f)).json();
  assert.equal(r3.status, "campaign_email_pending", "[camp-renovacao] pedido da campanha pendente");
  assert.notEqual((await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-3"), e, null, f)).json()).duplicate, true, "[camp-renovacao] não marcado como processado");
  delete f.status;
  const cron = await CS.retryPendingPackages(e, f);
  assert.equal(cron.welcome.sent, 1, "[camp-renovacao] cron envia o pedido da campanha do mês 3");
  const asks = f.sent.filter((m) => /defina a campanha do mês 3/.test(m.subject));
  assert.ok(asks.length >= 2 && new Set(asks.map((m) => m.text)).size === 1, "[camp-renovacao] mesmo link em toda tentativa");
  assert.equal((await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-3"), e, null, f)).json()).duplicate, true, "[camp-renovacao] processado depois do envio");
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

// ---------- Auditoria independente, rodada 2 do #960 (MED-1..5 e LOW) ----------
const alertKinds = (kv) => JSON.parse(kv.data.get("zpc:cp:alerts") || "[]").map((a) => a.kind);

test("[camp-corrida] cancelamento que chega durante a confirmação de entrega vence (registro relido antes de gravar)", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  assert.equal(rec(kv).status, "active");
  const slow = async (url, init) => {
    if ((init?.method || "GET") === "GET") { // o cancelamento chega enquanto o provedor responde
      await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "HP-C3-CANCEL"), e, null, f);
      return new Response(JSON.stringify({ id: String(url).split("/").pop(), last_event: "delivered" }), { status: 200 });
    }
    return f(url, init);
  };
  await CS.confirmPackageDeliveries(e, slow);
  const r = rec(kv);
  assert.equal(r.status, "inactive", "[camp-corrida] cancelamento preservado");
  assert.equal(r.stopEvent, "SUBSCRIPTION_CANCELLATION", "[camp-corrida] evento de parada preservado");
  assert.equal(r.deliveries[1].status, "confirmed", "[camp-corrida] recibo confirmado na mesma gravação");
});

test("[camp-lembretes] formulário sem resposta: lembretes nos dias 3, 7 e 14, alerta ao proprietário nos dias 7 e 14; política do mês pago na página", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-R2"), e, null, f); // renovação: pede a campanha do mês 2
  const ask2 = f.sent.filter((m) => /defina a campanha do mês 2/.test(m.subject)).at(-1);
  assert.ok(ask2, "[camp-lembretes] pedido da campanha do mês 2");
  const t2 = tokenOf(ask2.text, "briefing");
  let now = Date.now();
  for (let d = 1; d <= 20; d++) await CS.retryPendingPackages(e, f, 2, { now: now + d * 86400e3 });
  const reminders = f.sent.filter((m) => m.to[0] === "c3@example.invalid" && /Lembrete: falta a campanha do mês 2/.test(m.subject));
  assert.deepEqual(reminders.map((m) => /lembrete do dia (\d+)/.exec(m.text)[1]).map(Number), [...CS.CAMPAIGN_REMINDER_DAYS], "[camp-lembretes] um lembrete em cada dia, sem repetir");
  assert.ok(reminders.every((m) => m.text.includes("briefing?t=" + t2)), "[camp-lembretes] mesmo link do pedido");
  assert.equal(alertKinds(kv).filter((k) => k === "campanha_pendente").length, CS.CAMPAIGN_OWNER_ALERT_DAYS.length, "[camp-lembretes] alerta ao proprietário nos dias 7 e 14");
  const st = await (await CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/status"), e)).json();
  assert.equal(st.forms_waiting.length, 1, "[camp-lembretes] espera visível no status do operador");
  // A resposta encerra os lembretes; o mês 2 é entregue depois do dia 14 (mês reservado).
  await submit(e, f, t2, { ...BRIEF, ...CAMPAIGN_MONTH2 });
  assert.equal(rec(kv).deliveredCycle, 2, "[camp-lembretes] campanha enviada tarde ainda gera o mês pago");
  const before = f.sent.length;
  await CS.retryPendingPackages(e, f, 2, { now: now + 30 * 86400e3 });
  assert.equal(f.sent.filter((m, i) => i >= before && /Lembrete/.test(m.subject)).length, 0, "[camp-lembretes] sem lembrete depois da resposta");
  // Renovação seguinte sem a campanha do ciclo anterior => proprietário avisado.
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-R3"), e, null, f);
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-R4"), e, null, f);
  assert.ok(alertKinds(kv).includes("ciclo_sem_campanha"), "[camp-lembretes] ciclo terminado sem campanha alertado");
  // A página diz exatamente essa política.
  for (const rel of ["conteudo-pronto/index.html", "sales-public/conteudo-pronto.html"]) {
    const html = read(rel);
    assert.match(html, /E se eu não enviar a campanha do mês\?/, "[camp-lembretes] FAQ: " + rel);
    assert.match(html, new RegExp(`lembretes por e-mail ${CS.CAMPAIGN_REMINDER_DAYS.slice(0, -1).join(", ")} e ${CS.CAMPAIGN_REMINDER_DAYS.at(-1)} dias depois do pedido`), "[camp-lembretes] dias na página: " + rel);
    assert.match(html, new RegExp(`avisada no ${CS.CAMPAIGN_OWNER_ALERT_DAYS[0]}º dia`), "[camp-lembretes] alerta na página: " + rel);
    assert.ok(html.includes(C.mes_sem_campanha), "[camp-lembretes] mês pago (regra do contrato): " + rel);
  }
});

test("[camp-bounce] entrega com bounce: na fila de falhas, visível no status, reenviável pelo operador com link novo", async () => {
  const f = resend({ event: "bounced" }), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  await CS.retryPendingPackages(e, f);
  assert.equal(rec(kv).deliveries[1].status, "failed");
  const op = (path, body) => CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/" + path, body ? { method: "POST", body: JSON.stringify(body) } : {}), e);
  const st = await (await op("status")).json();
  const d = st.dead.find((x) => x.kind === "delivery_bounced");
  assert.ok(d && d.provider_event === "bounced" && d.cycle === 1, "[camp-bounce] falha visível no status");
  const first = tokenOf(f.sent.filter((m) => /chegou/.test(m.subject)).at(-1).text, "pacote");
  const r = await op("requeue", { sub: subKey(kv).slice(-12), operator: "ana", reason: "endereço conferido, reenviar" });
  assert.equal(r.status, 200, "[camp-bounce] reenvio aceito pelo operador");
  const calls = e.AI.calls.length;
  await CS.retryPendingPackages(e, f);
  const pkgs = f.sent.filter((m) => /chegou/.test(m.subject));
  assert.equal(pkgs.length, 2, "[camp-bounce] pacote reenviado");
  assert.notEqual(tokenOf(pkgs[1].text, "pacote"), first, "[camp-bounce] link novo (nova chave de idempotência)");
  assert.equal(e.AI.calls.length, calls, "[camp-bounce] mesmo pacote, sem nova geração");
  assert.equal(rec(kv).deliveryHistory.at(-1).receipt.status, "failed", "[camp-bounce] recibo com falha no histórico");
  // O reenvio também voltou com bounce (o provedor falso devolve bounced sempre): falha nova na fila, com histórico.
  const dead = JSON.parse(kv.data.get("zpc:cp:pending-dead"))[subKey(kv)];
  assert.ok(dead.status === "dead" && dead.operations.length === 1 && dead.history.length === 1, "[camp-bounce] nova falha registrada com o histórico da anterior");
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

test("[camp-datas] data inexistente, início no passado ou longe demais são recusados no formulário", async () => {
  assert.equal(CS.validateCampaign({ ...CAMPAIGN, periodo_inicio: "2027-02-30", periodo_fim: "2027-03-20" }).ok, false, "[camp-datas] 30/02 recusado");
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t = await subscribed(e, f);
  const past = { ...CAMPAIGN, periodo_inicio: isoDay(-3), periodo_fim: isoDay(10) };
  assert.equal((await submit(e, f, t, { ...BRIEF, ...past })).status, 400, "[camp-datas] início no passado");
  const far = { ...CAMPAIGN, periodo_inicio: isoDay(CS.CAMPANHA_INICIO_MAX_DIAS + 5), periodo_fim: isoDay(CS.CAMPANHA_INICIO_MAX_DIAS + 20) };
  assert.equal((await submit(e, f, t, { ...BRIEF, ...far })).status, 400, "[camp-datas] início longe demais");
  assert.equal(kv.data.get("zpc:cp:pending") ?? null, null, "[camp-datas] nada na fila");
  assert.equal((await submit(e, f, t, { ...BRIEF, ...CAMPAIGN })).status, 200, "[camp-datas] período válido aceito");
});

test("[camp-regen-mes] regeneração de pacote bloqueado só com a campanha do mês do pacote", async () => {
  const a = ai(), f = resend(), e = env(a), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const sub = "zpc:cp:sub:" + "b".repeat(40), pk = "zpc:cp:pkg:" + "b".repeat(40) + ":2";
  kv.data.set(pk, JSON.stringify({ schema: "zpc.cp.package.v1", cycle: 2, generatedAt: "2026-10-01T00:00:00.000Z", posts: [post(1)], mensagens: [{ objetivo: "Oferta", texto: "Chame no WhatsApp" }], calendario: [{ dia: 1, tipo: "post", tema: "Tema 1" }] }));
  kv.data.set(sub, JSON.stringify({ schema: "zpc.cp.v1", status: "active", email: "r@example.invalid", name: "R", cycles: 2, briefing: BRIEF, deliveredCycle: 2, lastPackage: pk, campanha: { ...CAMPAIGN, cycle: 1 } }));
  const out = await CS.regenerateBlockedPackage(e, sub, f);
  assert.equal(out.reason, "campaign_required", "[camp-regen-mes] campanha do mês anterior não serve");
  assert.equal(a.calls.length, 0, "[camp-regen-mes] nenhuma chamada de IA");
});

// ---------- Auditoria independente, rodada 3 do #960 (MED-A, MED-B e LOW) ----------
test("[camp-regra] regra do mês sem campanha: o mesmo texto no contrato, na página (FAQ e FAQPage), nos Termos, no atendimento e nos lembretes", async () => {
  const R = C.mes_sem_campanha;
  // Sol ORDEM 308 (S308-B4): crédito, limite explícito, reembolso a pedido e no cancelamento; nunca perda automática.
  for (const trecho of ["o mês pago vira crédito", "sem custo adicional", `no máximo ${C.creditos_max} meses em crédito`, "o crédito mais antigo é reembolsado",
    "pedir ao suporte o reembolso de mês pago sem pacote", "no cancelamento, todo mês pago sem pacote é reembolsado", "arrependimento de 7 dias"])
    assert.ok(R.includes(trecho), "[camp-regra] texto do contrato: " + trecho);
  assert.doesNotMatch(R, /não é reembolsado|não gera pacote e/, "[camp-regra] sem perda automática");
  assert.equal(CS.CREDITOS_MAX, C.creditos_max, "[camp-regra] limite de créditos do contrato no código");
  assert.equal(CS.MES_SEM_CAMPANHA, R, "[camp-regra] código lê o contrato");
  for (const rel of ["conteudo-pronto/index.html", "sales-public/conteudo-pronto.html"]) {
    const html = read(rel);
    assert.ok(html.includes("<strong>" + R + "</strong>"), "[camp-regra] FAQ com destaque: " + rel);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const faq = (ld["@graph"] || [ld]).find((n) => n["@type"] === "FAQPage");
    assert.ok(faq.mainEntity.some((q) => q.acceptedAnswer.text.includes(R)), "[camp-regra] FAQPage: " + rel);
  }
  for (const rel of ["termos/index.html", "sales-public/termos.html"]) assert.ok(read(rel).includes("<strong>" + R + "</strong>"), "[camp-regra] Termos com destaque (CDC art. 54 §4): " + rel);
  assert.ok(SUPPORT_PRODUCTS["conteudo-pronto"].content.includes(R), "[camp-regra] atendimento");
  const f = resend(), e = env(ai());
  await subscribed(e, f);
  await CS.retryPendingPackages(e, f, 2, { now: Date.now() + 3.1 * 86400e3 });
  const lembrete = f.sent.find((m) => /Lembrete/.test(m.subject));
  assert.ok(lembrete && lembrete.text.includes(R), "[camp-regra] lembrete");
  assert.match(lembrete.text, /Para não receber mais, cancele a assinatura/, "[camp-regra] linha de ajuda no lembrete");
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

test("[camp-operador-email] bounce: operador corrige o e-mail com motivo antes de reenviar; registrado sem o endereço no log", async () => {
  const f = resend({ event: "bounced" }), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  await CS.retryPendingPackages(e, f);
  const op = (body) => CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/requeue", { method: "POST", body: JSON.stringify(body) }), e);
  const sub = subKey(kv).slice(-12);
  assert.equal((await op({ sub, operator: "ana", reason: "endereço corrigido pelo assinante", new_email: "não-é-email" })).status, 400, "[camp-operador-email] e-mail inválido recusado");
  assert.equal((await op({ sub, operator: "ana", reason: "endereço corrigido pelo assinante", new_email: "Novo@Example.invalid" })).status, 200, "[camp-operador-email] reenvio com e-mail novo");
  await CS.retryPendingPackages(e, f);
  assert.equal(f.sent.filter((m) => /chegou/.test(m.subject)).at(-1).to[0], "novo@example.invalid", "[camp-operador-email] reenvio vai para o e-mail corrigido");
  assert.equal(rec(kv).emailChanges.length, 1, "[camp-operador-email] alteração registrada no assinante");
  const log = kv.data.get("zpc:cp:pending-log");
  assert.ok(JSON.parse(log).some((x) => x.event === "email_changed") && !/novo@example/i.test(log), "[camp-operador-email] log sem o endereço");
  // Renovação depois do bounce: o reenvio do ciclo antigo é recusado (N8).
  const f2 = resend({ event: "bounced" }), e2 = env(ai()), kv2 = e2.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e2, f2, await subscribed(e2, f2), { ...BRIEF, ...CAMPAIGN });
  await CS.retryPendingPackages(e2, f2);
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-OPR2"), e2, null, f2);
  assert.deepEqual(await CS.requeueDeadPackage(e2, subKey(kv2), { operator: "ana", reason: "reenviar o ciclo antigo" }), { ok: false, reason: "cycle_superseded" }, "[camp-operador-email] ciclo antigo não é reenviado");
});

test("[camp-cancelamento] cancelado não grava campanha nem recebe lembrete; renovação sem o formulário do 1º mês alerta certo; lembrete que falha alerta", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  const t = await subscribed(e, f);
  await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "HP-C3-X"), e, null, f);
  for (let d = 1; d <= 20; d++) await CS.retryPendingPackages(e, f, 2, { now: Date.now() + d * 86400e3 });
  assert.equal(f.sent.filter((m) => /Lembrete/.test(m.subject)).length, 0, "[camp-cancelamento] nenhum lembrete depois do cancelamento");
  // Formulário aberto por um token ainda válido depois do cancelamento (N2): recusado, registro continua inativo.
  const status = (await submit(e, f, t, { ...BRIEF, ...CAMPAIGN })).status;
  assert.ok(status === 404 || status === 409, "[camp-cancelamento] formulário recusa assinatura inativa");
  assert.equal(rec(kv).status, "inactive");
  assert.equal(rec(kv).campanha, undefined, "[camp-cancelamento] nenhuma campanha gravada");
  // Cancelamento que chega DURANTE o envio do formulário (depois da checagem inicial do token): o formulário relê o
  // registro antes de gravar e recusa; nada de campanha num assinante cancelado.
  const fr = resend(), er = env(ai()), kvr = er.ZEVANORY_PRIVATE_ARTIFACTS;
  const tr = await subscribed(er, fr);
  const put = kvr.put.bind(kvr);
  let fired = false;
  kvr.put = async (k, v, o) => {
    if (!fired && k === "zpc:cp:pending") { fired = true; await put(k, v, o); await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "HP-C3-XR"), er, null, fr); return; }
    return put(k, v, o);
  };
  assert.equal((await submit(er, fr, tr, { ...BRIEF, ...CAMPAIGN })).status, 409, "[camp-cancelamento] cancelamento durante o formulário vence");
  assert.equal(rec(kvr).status, "inactive");
  assert.equal(rec(kvr).campanha, undefined, "[camp-cancelamento] nenhuma campanha gravada no cancelado");
  // Renovação de quem nunca enviou o formulário do 1º mês: alerta "ciclo sem campanha", nunca "novo assinante".
  const f2 = resend(), e2 = env(ai()), kv2 = e2.ZEVANORY_PRIVATE_ARTIFACTS;
  await subscribed(e2, f2);
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-NR2"), e2, null, f2);
  assert.deepEqual(alertKinds(kv2), ["novo_assinante", "ciclo_sem_campanha"], "[camp-cancelamento] alerta certo na renovação sem formulário");
  // Lembrete que o provedor recusa: alerta ao proprietário uma vez, nova tentativa no cron seguinte.
  f2.status = 500;
  await CS.retryPendingPackages(e2, f2, 2, { now: Date.now() + 3.1 * 86400e3 });
  await CS.retryPendingPackages(e2, f2, 2, { now: Date.now() + 3.2 * 86400e3 });
  assert.equal(alertKinds(kv2).filter((k) => k === "lembrete_falhou").length, 1, "[camp-cancelamento] falha de lembrete alertada uma vez");
  // Envio da campanha encerra a espera (N18).
  const f3 = resend(), e3 = env(ai());
  await submit(e3, f3, await subscribed(e3, f3), { ...BRIEF, ...CAMPAIGN });
  const st = await (await CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/status"), e3)).json();
  assert.equal(st.forms_waiting.length, 0, "[camp-cancelamento] envio do formulário encerra os lembretes");
});

// ---------- Sol ORDEM 308 (S308-B4): mês sem campanha vira crédito; reembolso a pedido e no cancelamento ----------
const statusOf = async (e) => (await CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/status"), e)).json();

test("[camp-credito] renovação sem campanha: o mês vira crédito; a campanha enviada depois gera o pacote do crédito mais antigo, sem custo; limite de créditos com reembolso do excedente", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });   // mês 1 entregue
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-K2"), e, null, f); // mês 2 pago, sem campanha
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-K3"), e, null, f); // renovação: mês 2 vira crédito
  assert.deepEqual(rec(kv).credits.map((c) => c.cycle), [2], "[camp-credito] mês 2 virou crédito");
  assert.deepEqual(CS.pendingCycles(rec(kv)), [2, 3], "[camp-credito] pendentes: crédito 2 e mês 3");
  assert.deepEqual(((await statusOf(e)).credits || []).map((c) => c.cycles), [[2]], "[camp-credito] crédito visível no status");
  const ask = f.sent.filter((m) => /defina a campanha do mês 2/.test(m.subject)).at(-1);
  assert.ok(ask && /em crédito/.test(ask.text), "[camp-credito] pedido da campanha do mês em crédito");
  await submit(e, f, tokenOf(ask.text, "briefing"), { ...BRIEF, ...CAMPAIGN_MONTH2 });
  assert.ok(f.sent.some((m) => /mês 2 chegou/.test(m.subject)), "[camp-credito] pacote do mês 2 gerado com o crédito");
  assert.deepEqual(rec(kv).credits, [], "[camp-credito] crédito consumido");
  assert.deepEqual(rec(kv).creditsUsed.map((c) => c.cycle), [2], "[camp-credito] crédito registrado como usado");
  assert.equal(JSON.parse(kv.data.get(rec(kv).lastPackage)).cycle, 2);
  await CS.retryPendingPackages(e, f); // a fila de formulários pede a campanha do mês 3
  const ask3 = f.sent.filter((m) => /defina a campanha do mês 3/.test(m.subject)).at(-1);
  assert.ok(ask3, "[camp-credito] pede a campanha do mês atual depois de usar o crédito");
  await submit(e, f, tokenOf(ask3.text, "briefing"), { ...BRIEF, ...CAMPAIGN });
  assert.equal(rec(kv).deliveredCycle, 3, "[camp-credito] mês 3 entregue");
  // Limite: com 2 créditos, mais um mês sem campanha reembolsa o crédito mais antigo (pedido registrado e alertado).
  const g = resend(), e2 = env(ai()), kv2 = e2.ZEVANORY_PRIVATE_ARTIFACTS;
  await subscribed(e2, g); // mês 1 sem formulário
  for (const n of [2, 3, 4]) await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-L" + n), e2, null, g);
  assert.deepEqual(rec(kv2).credits.map((c) => c.cycle), [2, 3], "[camp-credito] no máximo " + CS.CREDITOS_MAX + " créditos");
  assert.deepEqual(rec(kv2).refundRequests.map((r) => [r.cycle, r.reason]), [[1, "limite_de_creditos"]], "[camp-credito] excedente vira pedido de reembolso");
  assert.ok(alertKinds(kv2).includes("reembolso_pedido"), "[camp-credito] proprietário avisado do reembolso");
  assert.deepEqual(CS.pendingCycles(rec(kv2)), [2, 3, 4], "[camp-credito] o mês reembolsado não gera mais pacote");
});

test("[camp-reembolso] pedido de reembolso pelo suporte e cancelamento com crédito: registrado e alertado, nunca dinheiro movido pelo sistema", async () => {
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-Q2"), e, null, f);
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-Q3"), e, null, f); // crédito 2, mês 3 pendente
  const op = (body) => CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/refund-request", { method: "POST", body: JSON.stringify(body) }), e);
  const sub = subKey(kv).slice(-12);
  assert.equal((await op({ sub, cycle: 2, operator: "ana", reason: "" })).status, 400, "[camp-reembolso] sem motivo recusado");
  assert.equal((await op({ sub, cycle: 1, operator: "ana", reason: "assinante pediu reembolso" })).status, 400, "[camp-reembolso] mês já entregue não é reembolsável aqui");
  assert.equal((await op({ sub, cycle: 2, operator: "ana", reason: "assinante pediu reembolso do mês 2" })).status, 200, "[camp-reembolso] pedido registrado");
  assert.deepEqual(CS.pendingCycles(rec(kv)), [3], "[camp-reembolso] mês reembolsado sai dos pendentes");
  const st = await statusOf(e);
  assert.ok(st.refund_requests.some((r) => r.cycle === 2 && r.reason === "pedido_do_assinante"), "[camp-reembolso] pedido visível no status");
  assert.deepEqual(st.credits, [], "[camp-reembolso] crédito reembolsado sai do índice");
  assert.ok(alertKinds(kv).includes("reembolso_pedido"), "[camp-reembolso] proprietário avisado");
  assert.ok(f.sent.every((m) => !/api\.hotmart|refund/i.test(m.to?.[0] || "")), "[camp-reembolso] nenhuma chamada de estorno");
  // Cancelamento com crédito e mês atual sem pacote: todos reembolsados (pedido registrado), nada mais é gerado.
  const g = resend(), e2 = env(ai()), kv2 = e2.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e2, g, await subscribed(e2, g), { ...BRIEF, ...CAMPAIGN });
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-Z2"), e2, null, g);
  await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-C3-Z3"), e2, null, g);
  await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "HP-C3-ZX"), e2, null, g);
  assert.deepEqual((rec(kv2).refundRequests || []).map((r) => [r.cycle, r.reason]), [[2, "cancelamento"], [3, "cancelamento"]], "[camp-reembolso] cancelamento reembolsa todo mês pago sem pacote");
  assert.deepEqual(CS.pendingCycles(rec(kv2)), [], "[camp-reembolso] nada pendente depois do cancelamento");
  assert.deepEqual((await statusOf(e2)).credits, [], "[camp-reembolso] cancelado sai do índice de créditos");
  assert.ok(alertKinds(kv2).includes("reembolso_pedido"), "[camp-reembolso] proprietário avisado no cancelamento");
});

// ---------- Auditoria independente, rodada 5 do #960 (estorno por mês x fim da assinatura; estados do reembolso) ----------
const hookX = (event, txn, { status = "", recurrence = 0, sub = "SUB-C3", price = 0 } = {}) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK },
  body: JSON.stringify({ event, data: { product: { id: 8704905, name: CS.SERVICE_PRODUCT_NAME }, buyer: { email: "c3@example.invalid", name: "Assinante" }, purchase: { transaction: txn, ...(recurrence ? { recurrence_number: recurrence } : {}), ...(price ? { price: { value: price } } : {}) }, subscription: { subscriber: { code: sub }, ...(status ? { status } : {}) } } }) });
const refundOp = (e, path, body) => CS.handleContentOperator(new Request("https://zevanory.api.br/api/admin/conteudo-pronto/" + path, { method: "POST", body: JSON.stringify(body) }), e);
async function withCredit() { // mês 1 entregue, mês 2 virou crédito, mês 3 atual sem pacote
  const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
  await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
  await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-E2"), e, null, f);
  await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-E3"), e, null, f);
  return { f, e, kv };
}

test("[camp-estorno] estorno de UM mês não encerra a assinatura; fim só por cancelamento ou status de encerramento; mês devolvido nunca vira crédito", async () => {
  // A) Reembolso a pedido executado na Hotmart: o pedido aberto vira "processed" e a assinatura continua ativa.
  { const { f, e, kv } = await withCredit();
    assert.equal((await refundOp(e, "refund-request", { sub: subKey(kv).slice(-12), cycle: 2, operator: "ana", reason: "assinante pediu o reembolso do mês 2" })).status, 200);
    await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-E2"), e, null, f);
    assert.equal(rec(kv).status, "active", "[camp-estorno] estorno do mês pedido mantém a assinatura ativa");
    assert.equal(rec(kv).refundRequests.find((r) => r.cycle === 2)?.status, "processed", "[camp-estorno] pedido do mês vira processado pelo webhook");
    assert.ok(((await statusOf(e)).refund_requests || []).some((r) => r.cycle === 2 && r.status === "processed"), "[camp-estorno] processado na lista do proprietário");
    assert.ok(!alertKinds(kv).includes("assinatura_confirmar"), "[camp-estorno] estorno correspondente não pede confirmação");
    // B) Estorno sem pedido e sem status no payload: falha segura (ativa, alerta para confirmar, mês fora dos pendentes).
    await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-E3"), e, null, f);
    assert.equal(rec(kv).status, "active", "[camp-estorno] sem status: assinatura mantida ativa");
    assert.ok(alertKinds(kv).includes("assinatura_confirmar"), "[camp-estorno] sem status: proprietário confirma");
    assert.deepEqual(CS.pendingCycles(rec(kv)), [], "[camp-estorno] mês estornado sai dos pendentes");
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-E4"), e, null, f);
    assert.ok(!(rec(kv).credits || []).some((c) => c.cycle === 3), "[camp-estorno] mês estornado não vira crédito na renovação"); }
  // C) Chargeback com status de encerramento: assinatura encerrada, os OUTROS meses sem pacote viram pedido de reembolso.
  { const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_CHARGEBACK", "HP-E3", { status: "CANCELLED_BY_CUSTOMER" }), e, null, f);
    assert.equal(rec(kv).status, "inactive", "[camp-estorno] status de encerramento encerra a assinatura");
    assert.deepEqual((rec(kv).refundRequests || []).map((r) => [r.cycle, r.status]).sort(), [[2, "requested"], [3, "processed"]], "[camp-estorno] crédito restante vira pedido; o mês estornado fica processado");
    assert.ok(alertKinds(kv).includes("reembolso_pedido"), "[camp-estorno] proprietário avisado");
    // D) Reassinatura depois do chargeback: o mês devolvido não vira crédito.
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-E9"), e, null, f);
    assert.equal(rec(kv).status, "active");
    assert.ok(!(rec(kv).credits || []).some((c) => c.cycle === 3) && !CS.pendingCycles(rec(kv)).includes(3), "[camp-estorno] reassinatura não transforma o mês devolvido em crédito"); }
  // E) PURCHASE_CANCELED com status de encerramento pede reembolso dos meses sem pacote.
  { const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_CANCELED", "HP-E3", { status: "CANCELLED_BY_SELLER" }), e, null, f);
    assert.ok((rec(kv).refundRequests || []).some((r) => r.cycle === 2 && r.reason === "cancelamento"), "[camp-estorno] PURCHASE_CANCELED que encerra pede reembolso"); }
  // F) Mesma transação de renovação com outro evento (APPROVED e depois COMPLETE): um crédito só.
  { const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_COMPLETE", "HP-E3"), e, null, f);
    assert.equal(rec(kv).cycles, 3, "[camp-estorno] sem crédito em dobro pela mesma transação: o ciclo não avança");
    assert.deepEqual((rec(kv).credits || []).map((c) => c.cycle), [2], "[camp-estorno] sem crédito em dobro pela mesma transação"); }
});

test("[camp-reembolso-prazo] pedido de reembolso: requested → processed (webhook ou operador) → overdue com alerta; prazo no texto; /reembolso com a regra", async () => {
  assert.ok(C.mes_sem_campanha.includes(`O estorno é processado em até ${CS.REEMBOLSO_PRAZO_DIAS_UTEIS} dias úteis`), "[camp-reembolso-prazo] prazo no texto único");
  for (const rel of ["reembolso/index.html", "sales-public/reembolso.html"]) {
    const html = read(rel);
    assert.ok(html.includes(C.mes_sem_campanha), "[camp-reembolso-prazo] regra do Conteúdo Pronto em " + rel);
    assert.match(html, /a instituição de pagamento é a Hotmart/, "[camp-reembolso-prazo] caminho Hotmart em " + rel);
  }
  const { f, e, kv } = await withCredit();
  const sub = subKey(kv).slice(-12);
  await refundOp(e, "refund-request", { sub, cycle: 2, operator: "ana", reason: "assinante pediu o reembolso do mês 2" });
  assert.equal(((await statusOf(e)).refund_requests || []).find((r) => r.cycle === 2)?.status, "requested");
  const later = Date.now() + (CS.REEMBOLSO_ALERTA_DIAS + 1) * 86400e3;
  await CS.checkOverdueRefunds(e, f, { now: later });
  await CS.checkOverdueRefunds(e, f, { now: later + 3600e3 });
  assert.equal(((await statusOf(e)).refund_requests || []).find((r) => r.cycle === 2)?.status, "overdue", "[camp-reembolso-prazo] pedido parado vira overdue");
  assert.equal(alertKinds(kv).filter((k) => k === "reembolso_atrasado").length, 1, "[camp-reembolso-prazo] alerta de atraso uma vez");
  assert.equal((await refundOp(e, "refund-processed", { sub, cycle: 2, operator: "ana", reason: "" })).status, 400, "[camp-reembolso-prazo] processado exige motivo");
  assert.equal((await refundOp(e, "refund-processed", { sub, cycle: 2, operator: "ana", reason: "estornado na Hotmart hoje" })).status, 200, "[camp-reembolso-prazo] operador marca processado");
  assert.equal(((await statusOf(e)).refund_requests || []).find((r) => r.cycle === 2)?.status, "processed", "[camp-reembolso-prazo] processado na lista");
  assert.equal(rec(kv).refundRequests.find((r) => r.cycle === 2)?.status, "processed", "[camp-reembolso-prazo] processado no assinante");
  assert.equal((await refundOp(e, "refund-processed", { sub, cycle: 2, operator: "ana", reason: "estornado na Hotmart hoje" })).status, 400, "[camp-reembolso-prazo] não processa duas vezes");
  assert.ok(!JSON.stringify(await statusOf(e)).includes(subKey(kv)), "[camp-reembolso-prazo] status sem a chave inteira");
});

// ---------- Auditoria independente, rodada 6 do #960 (só mês PAGO é devolvido; parcial; status desconhecido) ----------
const mailText = (f, rx) => f.sent.filter((m) => rx.test(m.subject || "")).map((m) => String(m.text || m.html || "")).join("\n");

test("[camp-pago] só um mês pago pode ser devolvido: cobrança recusada não é reembolso; transação desconhecida não mexe em mês", async () => {
  // A) Renovação recusada (PURCHASE_CANCELED de transação nunca aprovada, recorrência 3) e depois aprovada.
  { const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-P2"), e, null, f);
    const r = await (await CS.handleHotmartWebhook(hookX("PURCHASE_CANCELED", "HP-P3-RECUSADA", { recurrence: 3 }), e, null, f)).json();
    assert.equal(r.cycle, null, "[camp-pago] cobrança recusada não aponta mês");
    assert.deepEqual(rec(kv).refundRequests || [], [], "[camp-pago] cobrança recusada não vira reembolso");
    assert.ok(alertKinds(kv).includes("cobranca_nao_concluida"), "[camp-pago] alerta de cobrança não concluída");
    assert.match(mailText(f, /não concluída/), /não paga/, "[camp-pago] texto do alerta fala em cobrança não paga");
    assert.doesNotMatch(mailText(f, /não concluída/), /estorno de um mês/, "[camp-pago] texto do alerta não fala em estorno");
    const asks = () => f.sent.filter((m) => /campanha do mês/.test(m.subject || "")).length;
    const asked = asks();
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-P3-OK", { recurrence: 3 }), e, null, f);
    assert.equal(rec(kv).cycles, 3);
    assert.deepEqual(CS.pendingCycles(rec(kv)), [2, 3], "[camp-pago] mês 3 pago depois da recusa fica pendente");
    assert.ok(asks() > asked, "[camp-pago] a renovação paga pede a campanha"); }
  // B) Estorno de transação desconhecida com recurrence_number: sem palpite pelo número (a Hotmart recomeça em 1 numa
  //    reassinatura); nenhum mês alterado, alerta para confirmar. Número não inteiro não aparece no alerta.
  { const { f, e, kv } = await withCredit();
    const r = await (await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-FORMATO-OUTRO", { recurrence: 2 }), e, null, f)).json();
    assert.equal(r.cycle, null, "[camp-pago] sem palpite pela recorrência");
    assert.deepEqual(CS.pendingCycles(rec(kv)), [2, 3], "[camp-pago] transação desconhecida não tira mês");
    assert.ok(alertKinds(kv).includes("assinatura_confirmar"), "[camp-pago] transação desconhecida pede confirmação");
    assert.match(mailText(f, /transação desconhecida/), /recorrência 2 na Hotmart/, "[camp-pago] alerta traz a recorrência inteira");
    await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-FORMATO-OUTRO-2", { recurrence: 2.5 }), e, null, f);
    assert.doesNotMatch(mailText(f, /transação desconhecida/), /2\.5/, "[camp-pago] recorrência não inteira descartada");
    assert.deepEqual(CS.pendingCycles(rec(kv)), [2, 3]); }
  // C) Reassinatura: recorrência 1 da assinatura nova com transação desconhecida não devolve o ciclo 1 antigo nem o atual.
  { const f = resend(), e = env(ai()), kv = e.ZEVANORY_PRIVATE_ARTIFACTS;
    await submit(e, f, await subscribed(e, f), { ...BRIEF, ...CAMPAIGN });
    await CS.handleHotmartWebhook(hookX("SUBSCRIPTION_CANCELLATION", "HP-R-C"), e, null, f);
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-R-NOVA", { recurrence: 1 }), e, null, f);
    const before = JSON.stringify(rec(kv).refundRequests || []);
    await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-R-NOVA-OUTRO", { recurrence: 1 }), e, null, f);
    assert.equal(JSON.stringify(rec(kv).refundRequests || []), before, "[camp-pago] reassinatura: recorrência 1 não marca ciclo nenhum");
    assert.ok(CS.pendingCycles(rec(kv)).includes(rec(kv).cycles), "[camp-pago] reassinatura: mês atual continua pendente"); }
});

test("[camp-parcial] estorno parcial mantém o mês; status desconhecido alerta; baixa do operador não gera alerta inútil", async () => {
  // A) Parcial: pagou 197, estornou 20 -> o mês continua a entregar, o parcial fica registrado, o proprietário é avisado.
  { const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_APPROVED", "HP-V4", { price: 197 }), e, null, f);
    const r = await (await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-V4", { price: 20 }), e, null, f)).json();
    assert.equal(r.partial, true, "[camp-parcial] estorno parcial não tira o mês: resposta marca parcial");
    assert.ok(CS.pendingCycles(rec(kv)).includes(4), "[camp-parcial] estorno parcial não tira o mês");
    assert.deepEqual((rec(kv).partialRefunds || []).map((x) => [x.cycle, x.amount, x.paid]), [[4, 20, 197]], "[camp-parcial] parcial registrado");
    assert.ok(alertKinds(kv).includes("estorno_parcial"), "[camp-parcial] proprietário avisado do parcial");
    await CS.handleHotmartWebhook(hookX("PURCHASE_CHARGEBACK", "HP-V4", { price: 197 }), e, null, f);
    assert.ok(!CS.pendingCycles(rec(kv)).includes(4), "[camp-parcial] estorno do valor inteiro tira o mês"); }
  // B) Status fora dos conhecidos (OVERDUE, DELAYED, SUSPENDED): ativa, créditos mantidos, alerta. ACTIVE não alerta.
  for (const st of ["OVERDUE", "DELAYED", "SUSPENDED"]) {
    const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_CHARGEBACK", "HP-E3", { status: st }), e, null, f);
    assert.equal(rec(kv).status, "active", "[camp-parcial] status desconhecido mantém ativa: " + st);
    assert.ok(CS.pendingCycles(rec(kv)).includes(2), "[camp-parcial] status desconhecido mantém o crédito: " + st);
    assert.ok(alertKinds(kv).includes("assinatura_status_desconhecido"), "[camp-parcial] status desconhecido alerta: " + st);
  }
  { const { f, e, kv } = await withCredit();
    await CS.handleHotmartWebhook(hookX("PURCHASE_CHARGEBACK", "HP-E3", { status: "ACTIVE" }), e, null, f);
    assert.ok(!alertKinds(kv).includes("assinatura_status_desconhecido"), "[camp-parcial] ACTIVE é conhecido"); }
  // C) O operador marcou processado antes do webhook: o webhook não pede confirmação.
  { const { f, e, kv } = await withCredit();
    const sub = subKey(kv).slice(-12);
    await refundOp(e, "refund-request", { sub, cycle: 2, operator: "ana", reason: "assinante pediu o reembolso do mês 2" });
    await refundOp(e, "refund-processed", { sub, cycle: 2, operator: "ana", reason: "estornado na Hotmart hoje" });
    await CS.handleHotmartWebhook(hookX("PURCHASE_REFUNDED", "HP-E2"), e, null, f);
    assert.ok(!alertKinds(kv).includes("assinatura_confirmar"), "[camp-parcial] sem alerta de confirmação depois da baixa do operador");
    assert.equal(rec(kv).refundRequests.find((r) => r.cycle === 2)?.processedBy, "ana", "[camp-parcial] baixa do operador preservada"); }
});

test("[camp-corrida-reembolso] pedido de reembolso: releitura antes de gravar (409) e um só pedido por mês na lista do proprietário", async () => {
  // A) Outro escritor registra o mês 2 entre a leitura e a gravação da rota: a releitura vê e responde 409.
  { const { e, kv } = await withCredit();
    const key = subKey(kv), sub = key.slice(-12), orig = kv.get.bind(kv);
    let reads = 0;
    kv.get = async (k, ...rest) => {
      const v = await orig(k, ...rest);
      if (k === key && ++reads === 1) { const r = JSON.parse(kv.data.get(key)); r.refundRequests = [...(r.refundRequests || []), { cycle: 2, reason: "pedido_do_assinante", status: "requested", at: new Date().toISOString() }]; kv.data.set(key, JSON.stringify(r)); }
      return v;
    };
    const res = await refundOp(e, "refund-request", { sub, cycle: 2, operator: "ana", reason: "assinante pediu o reembolso do mês 2" });
    kv.get = orig;
    assert.equal(res.status, 409, "[camp-corrida-reembolso] releitura detecta o outro escritor");
    assert.equal(rec(kv).refundRequests.filter((r) => r.cycle === 2).length, 1, "[camp-corrida-reembolso] um pedido só no assinante"); }
  // B) Atualização perdida no registro (corrida) e depois cancelamento: a lista do proprietário não duplica o mês.
  { const { f, e, kv } = await withCredit();
    const key = subKey(kv);
    await refundOp(e, "refund-request", { sub: key.slice(-12), cycle: 2, operator: "ana", reason: "assinante pediu o reembolso do mês 2" });
    const r = JSON.parse(kv.data.get(key)); r.refundRequests = []; kv.data.set(key, JSON.stringify(r)); // simula a atualização perdida
    await CS.handleHotmartWebhook(hookX("SUBSCRIPTION_CANCELLATION", "HP-E-C"), e, null, f);
    const list = JSON.parse(kv.data.get("zpc:cp:refund-requests") || "[]").filter((x) => x.key === key && x.cycle === 2);
    assert.equal(list.length, 1, "[camp-corrida-reembolso] um pedido só por mês na lista do proprietário"); }
});
