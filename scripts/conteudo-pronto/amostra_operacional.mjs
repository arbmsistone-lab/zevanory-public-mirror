#!/usr/bin/env node
// Conteúdo Pronto v3 — amostra operacional completa (campanha mensal de promoção de vendas), em modo SEGURO:
//   - rede global bloqueada (fetch lança erro); KV em memória; Hotmart = postback sintético com hottok local;
//   - IA = STUB que responde ancorado na campanha (texto do script, NÃO é saída de modelo);
//   - Resend = STUB que devolve id e, na consulta GET /emails/{id}, o evento "delivered".
// Percorre: compra -> e-mail de boas-vindas -> formulário (perfil + campanha) -> recusa sem campanha -> geração ->
// e-mail da campanha -> versão online -> recibo -> confirmação de entrega -> renovação -> pedido da campanha do mês 2
// -> campanha do mês 2 -> cancelamento. Grava cada artefato em <saida>/ e um RESUMO.json com os critérios do Sol 304.
// A amostra REAL (Workers AI e Resend de verdade, assinante interno) só roda com autorização do proprietário.
// Uso: node scripts/conteudo-pronto/amostra_operacional.mjs <saida>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = process.argv[2];
if (!OUT) { console.error("uso: amostra_operacional.mjs <saida>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.fetch = async (u) => { throw new Error("REDE BLOQUEADA NA AMOSTRA: " + u); };
const CS = await import(pathToFileURL(path.join(ROOT, "worker/content-service.mjs")).href);

class MapKV {
  data = new Map();
  async get(k) { return this.data.get(k) ?? null; }
  async put(k, v) { this.data.set(k, String(v)); }
  async delete(k) { this.data.delete(k); }
  async list({ prefix = "" } = {}) { return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; }
}
const HOTTOK = "hottok-amostra-local-000000000000";
const SUB_EMAIL = "assinante.teste@example.invalid";
const ALERTS = "alertas.teste@example.invalid";
const PERFIL = { negocio: "Ateliê Linha Viva (fictício)", ramo: "ateliê de costura sob medida", publico: "mulheres de 25 a 60 anos, noivas e madrinhas", produtos: "ajustes, vestidos sob medida, uniformes", diferencial: "prova com hora marcada e acabamento à mão", cidade: "Crato - CE", tom: "próximo e acolhedor", contato: "e-mail, Instagram Direct e chat do site" };
const CAMP1 = { objetivo_comercial: "Encher a agenda de ajustes antes das festas de fim de ano", oferta: "Ajuste de Festa", condicao_comercial: "barra grátis em vestidos ajustados até 30/11", periodo_inicio: "2026-11-03", periodo_fim: "2026-11-30" };
const CAMP2 = { objetivo_comercial: "Vender uniformes para pequenas empresas em janeiro", oferta: "Uniforme Sob Medida", condicao_comercial: "preço normal, com prova na sua empresa", periodo_inicio: "2026-12-01", periodo_fim: "2026-12-21" };

// IA stub ancorada: lê a campanha do prompt e devolve textos que citam a oferta, a condição e uma fase por post.
function stubAI() {
  const calls = [];
  return { calls, run: async (model, input) => {
    const u = input.messages[1].content;
    calls.push({ model, chars: u.length });
    const oferta = /Oferta promovida: (.+)/.exec(u)?.[1]?.trim();
    const cond = /Condição comercial: (.+)/.exec(u)?.[1]?.trim();
    if (u.includes("roteiros multicanal")) {
      return { response: JSON.stringify({ roteiros: CS.ROTEIRO_OBJETIVOS.map((o) => ({ objetivo_id: o.id,
        curta: `Olá! Aqui é do Ateliê Linha Viva. Sobre ${o.titulo.toLowerCase()}: a campanha ${oferta} está valendo. Posso te passar os detalhes? [STUB]`,
        email: { assunto: `${oferta} · Ateliê Linha Viva`, corpo: `Olá! Obrigada pelo contato com o Ateliê Linha Viva. Escrevo sobre ${o.titulo.toLowerCase()}. Neste período a campanha ${oferta} tem esta condição: ${cond}. Trabalhamos com prova em hora marcada e acabamento feito à mão. Se fizer sentido, responda com o melhor dia para a prova. Se não for o momento, tudo bem: é só responder e não volto a escrever sobre isso. [STUB]` } })) }) };
    }
    const from = Number(/posts (\d+) a/.exec(u)[1]);
    return { response: JSON.stringify({ posts: Array.from({ length: 6 }, (_, k) => {
      const i = from - 1 + k, fase = CS.FASES[i % CS.FASES.length];
      return { fase: fase.id, tema: `${fase.titulo}: ${oferta} (${i + 1})`,
        legenda: `${fase.titulo}. A campanha ${oferta} do Ateliê Linha Viva começa a valer no período informado, com ${cond}. Cada peça passa por prova com hora marcada e acabamento à mão, para vestir bem e durar. Se você tem uma peça parada no armário, traga para a prova. [STUB ${i + 1}]`,
        cta: `Agende a prova da ${oferta} pelo Direct`, hashtags: ["#costura", "#sobmedida", "#crato"], imagem: "mãos fazendo o acabamento de uma bainha, luz natural" };
    }) }) };
  } };
}
function resendStub() {
  const sent = [], events = new Map();
  const f = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.resend.com/emails")) throw new Error("fetch inesperado: " + u);
    if ((init.method || "GET") === "GET") { const id = u.split("/").pop(); return new Response(JSON.stringify({ id, last_event: events.get(id) || "sent" }), { status: 200 }); }
    const body = JSON.parse(init.body); const id = "stub-" + (sent.length + 1); sent.push({ ...body, id }); events.set(id, "delivered");
    return new Response(JSON.stringify({ id }), { status: 200 });
  };
  f.sent = sent; f.events = events; return f;
}
const ai = stubAI(), rs = resendStub();
const env = { ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "stub-nao-e-chave", AI: ai, OWNER_ALERT_EMAIL: ALERTS };
const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
const hook = (event, txn) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK },
  body: JSON.stringify({ event, data: { product: { id: 8704905, name: CS.SERVICE_PRODUCT_NAME }, buyer: { email: SUB_EMAIL, name: "Assinante Teste" }, purchase: { transaction: txn }, subscription: { subscriber: { code: "SUB-AMOSTRA" } } } }) });
const tokenOf = (text, p) => new RegExp(p + "\\?t=([A-Za-z0-9_-]+)").exec(text)?.[1];
const post = (t, fields) => CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + t, { method: "POST", body: new URLSearchParams(fields) }), env, null, rs);
const W = (n, d) => fs.writeFileSync(path.join(OUT, n), typeof d === "string" ? d : JSON.stringify(d, null, 2));
const toSub = () => rs.sent.filter((m) => m.to[0] === SUB_EMAIL);
const record = () => JSON.parse(kv.data.get([...kv.data.keys()].find((k) => k.startsWith("zpc:cp:sub:"))));
const norm = (s) => String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// 1) compra e boas-vindas
await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-AMOSTRA-1"), env, null, rs);
const welcome = toSub()[0];
const bt = tokenOf(welcome.text, "briefing");
W("01_email_boas_vindas.txt", `Para: ${welcome.to}\nAssunto: ${welcome.subject}\n\n${welcome.text}`);
W("02_formulario.html", await (await CS.handleBriefing(new Request("https://zevanory.api.br/conteudo-pronto/briefing?t=" + bt), env, null, rs)).text());
// 2) recusa sem campanha
const sem = await post(bt, PERFIL);
const callsAntes = ai.calls.length;
W("03_recusa_sem_campanha.html", await sem.text());
// 3) campanha do mês 1
await post(bt, { ...PERFIL, ...CAMP1 });
const d1 = toSub().find((m) => /mês 1 chegou/.test(m.subject));
W("04_email_campanha_mes1.txt", `Para: ${d1.to}\nAssunto: ${d1.subject}\n\n${d1.text}`);
const r1 = record();
const pkg1 = JSON.parse(kv.data.get(r1.lastPackage));
W("05_pacote_mes1.json", pkg1);
const pt1 = tokenOf(d1.text, "pacote");
// 4) confirmação de entrega pelo provedor (cron)
const conf = await CS.confirmPackageDeliveries(env, rs);
const view1 = await (await CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + pt1), env)).text();
W("06_versao_online_mes1.html", view1);
W("07_recibo_mes1.json", record().deliveries[1]);
// 5) renovação -> pedido da campanha do mês 2 -> campanha do mês 2
const callsAntesRenovacao = ai.calls.length;
const ren = await (await CS.handleHotmartWebhook(hook("PURCHASE_APPROVED", "HP-AMOSTRA-2"), env, null, rs)).json();
const ask2 = toSub().find((m) => /campanha do mês 2/.test(m.subject));
W("08_email_pedido_campanha_mes2.txt", `Para: ${ask2.to}\nAssunto: ${ask2.subject}\n\n${ask2.text}`);
const genAntesMes2 = ai.calls.length;
await post(tokenOf(ask2.text, "briefing"), { ...PERFIL, ...CAMP2 });
const d2 = toSub().find((m) => /mês 2 chegou/.test(m.subject));
W("09_email_campanha_mes2.txt", `Para: ${d2.to}\nAssunto: ${d2.subject}\n\n${d2.text}`);
const pkg2 = JSON.parse(kv.data.get(record().lastPackage));
W("10_pacote_mes2.json", pkg2);
// 6) cancelamento
await CS.handleHotmartWebhook(hook("SUBSCRIPTION_CANCELLATION", "HP-AMOSTRA-3"), env, null, rs);
const v1depois = await (await CS.handlePackageView(new Request("https://zevanory.api.br/conteudo-pronto/pacote?t=" + pt1), env)).text();

const anchored = (pkg) => pkg.posts.every((p) => norm(p.legenda + " " + p.cta).includes(norm(pkg.campanha.oferta)))
  && pkg.roteiros.every((r) => norm(r.curta).includes(norm(pkg.campanha.oferta)) && norm(r.email.corpo).includes(norm(pkg.campanha.oferta)) && norm(r.email.corpo).includes(norm(pkg.campanha.condicao_comercial)));
const inPeriod = (pkg) => pkg.calendario.every((c) => c.data >= pkg.campanha.periodo_inicio && c.data <= pkg.campanha.periodo_fim);
const R = {
  modo: "STUB (IA e Resend simulados, rede bloqueada) — não é a amostra real",
  servico: pkg1.servico,
  criterios: {
    "1_recusa_sem_campanha": sem.status === 400 && callsAntes === 0,
    "1_campanha_gravada_no_pacote": JSON.stringify(pkg1.campanha) === JSON.stringify({ ...CAMP1 }),
    "2_posts_e_roteiros_ancorados_mes1": anchored(pkg1),
    "2_posts_e_roteiros_ancorados_mes2": anchored(pkg2),
    "2_seis_fases_nos_posts": new Set(pkg1.posts.map((p) => p.fase)).size === CS.FASES.length,
    "2_calendario_no_periodo": inPeriod(pkg1) && inPeriod(pkg2) && pkg1.calendario.length === 16,
    "3_recibo_com_protocolo_sha_e_id": Boolean(r1.deliveries?.[1]?.protocolo && r1.deliveries[1].sha256 && r1.deliveries[1].email_id),
    "3_entrega_confirmada_pelo_provedor": record().deliveries[1].status === "confirmed" && conf.confirmed >= 1,
    "3_recibo_na_versao_online": /entrega confirmada pelo provedor/.test(view1),
    "4_renovacao_pede_campanha_sem_gerar": ren.status === "campaign_requested" && /campanha do mês 2/.test(ask2.subject) && genAntesMes2 === callsAntesRenovacao && pkg2.campanha.oferta === CAMP2.oferta,
    "5_link_mes1_continua_no_mes1": /mês 1/.test(v1depois) && !/mês 2/.test(v1depois),
    "alertas_em_caixa_separada": rs.sent.filter((m) => m.subject.startsWith("ZEVANORY ·")).every((m) => m.to[0] === ALERTS),
  },
  emails: rs.sent.map((m) => ({ para: m.to[0] === SUB_EMAIL ? "assinante" : m.to[0] === ALERTS ? "alertas" : "outro", assunto: m.subject })),
  chamadas_ia: ai.calls.length,
};
R.ok = Object.values(R.criterios).every(Boolean);
W("RESUMO.json", R);
console.log(JSON.stringify(R, null, 2));
process.exit(R.ok ? 0 : 1);
