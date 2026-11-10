// Relatório diário real ao proprietário + Diagnosticador v1 (CANAL_PARADO) + índice real de autonomia + hotmart_view
// separado no aviso público (Plano Mestre ZEVANORY v1.2, seções 2, 4, 6 e 9; F1 itens 4, 5 e 9). Só fakes locais:
// nenhuma rede real, nenhum KV real, nenhum e-mail enviado, nenhum segredo.
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { REGRAS_DIAGNOSTICO, esperadasNoDia, canaisAtivos, lerStatusDoDia, diagnosticarDia, autonomiaDoDia, autonomiaDaJanela, indiceAutonomia, classeDoMotivo } from "../worker/diagnostico-diario.mjs";
import { montarRelatorioDiario, estadoVendasHotmart, funilDoDia } from "../worker/relatorio-diario.mjs";
import { runOwnerDailyDigest } from "../worker/acquisition-engine.mjs";
import { buildFunnelSummary } from "../worker/funnel.mjs";

const MON = "2026-10-12", TUE = "2026-10-13";
const NOW_MON_20H = new Date("2026-10-12T23:10:00Z"); // 20:10 em São Paulo, mesmo dia UTC
function fake(entries = {}, { throwOn = null } = {}) {
  const data = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])), writes = [];
  return { data, writes, kv: { get: async (k) => { if (throwOn && throwOn(k)) throw new Error("kv_down"); return data.get(k) ?? null; }, put: async (k, v) => { writes.push(k); data.set(k, String(v)); } } };
}
const ALL_ACTIVE = { blog: { ativo: true }, telegram: { ativo: true }, bluesky: { ativo: true }, youtube: { ativo: false, motivo: "desligado" } };
const CHECKLIST_OK = [{ id: "telegram", configured: true }, { id: "bluesky", configured: true }];

test("regras versionadas: só CANAL_PARADO, sem ação automática; esperadas por canal, dia da semana e hora limite", () => {
  const raw = JSON.parse(readTextNormalized(new URL("../data/regras-diagnostico.json", import.meta.url)));
  assert.equal(raw.schema, "zevanory-regras-diagnostico/v1"); assert.match(raw.versao, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(raw.regras.map((r) => [r.id, r.ativa, r.acao_automatica]), [["CANAL_PARADO", true, false]]);
  assert.deepEqual(REGRAS_DIAGNOSTICO, raw);
  assert.equal(esperadasNoDia("blog", MON, 20), 1); assert.equal(esperadasNoDia("blog", TUE, 20), 0, "blog só seg/qua/sex");
  assert.equal(esperadasNoDia("blog", MON, 8), 0, "antes da hora limite não é devido");
  assert.equal(esperadasNoDia("telegram", TUE, 12), 1); assert.equal(esperadasNoDia("telegram", TUE, 11), 0);
  assert.equal(esperadasNoDia("bluesky", TUE, 19), 1); assert.equal(esperadasNoDia("youtube", MON, 24), 0, "Shorts desligados");
  assert.equal(esperadasNoDia("inexistente", MON, 24), 0);
  const ativos = canaisAtivos([{ id: "telegram", configured: true }, { id: "bluesky", configured: false }]);
  assert.deepEqual([ativos.blog.ativo, ativos.telegram.ativo, ativos.bluesky.ativo, ativos.youtube.ativo], [true, true, false, false]);
  assert.equal(ativos.bluesky.motivo, "aguardando credencial");
  assert.equal(classeDoMotivo("credential_expired"), "D"); assert.equal(classeDoMotivo("telegram_http_403"), "B");
});

test("CANAL_PARADO: cada canal ativo abaixo do esperado gera diagnóstico com o motivo lido das chaves de status", async () => {
  const x = fake({
    ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "blog", status: "erro", code: "rejected:duplicado" }, { channel: "telegram", status: "erro", code: "telegram_http_403" }, { channel: "bluesky", status: "publicado", url: "https://bsky.app/profile/x/post/1", provider_post_id: "at://did/1" }] },
    ["zpc:acquisition:daily:" + MON + ":telegram"]: { status: "erro", code: "telegram_http_403" },
    ["zpc:blog:status:v1:" + MON]: { resultado: "rejeitado", motivos: ["duplicado"] },
  });
  const status = await lerStatusDoDia(x.kv, MON);
  const d = diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status });
  assert.deepEqual(d.map((y) => [y.regra, y.canal, y.publicadas, y.esperadas, y.motivo, y.classe, y.acao_automatica]), [
    ["CANAL_PARADO", "blog", 0, 1, "gate do blog: duplicado", "B", "nenhuma"],
    ["CANAL_PARADO", "telegram", 0, 1, "telegram_http_403", "B", "nenhuma"],
  ]);
  assert.equal(d[0].versao_regras, REGRAS_DIAGNOSTICO.versao);
  assert.deepEqual(x.writes, [], "o Diagnosticador v1 só lê");
  // Sem registro do motor no dia: o canal ativo aparece como parado com motivo sem_registro.
  const vazio = await lerStatusDoDia(fake().kv, MON);
  assert.equal(vazio.fonte, "sem_registro");
  assert.deepEqual(diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: vazio }).map((y) => y.canal), ["blog", "telegram", "bluesky"]);
  assert.match(diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: vazio })[0].motivo, /^sem_registro/);
  // Antes da hora limite, canal inativo e regra desligada não diagnosticam; credencial expirada é classe D.
  assert.deepEqual(diagnosticarDia({ day: MON, hour: 8, ativos: ALL_ACTIVE, status: vazio }), []);
  assert.deepEqual(diagnosticarDia({ day: MON, hour: 20, ativos: { blog: { ativo: false } }, status: vazio }), []);
  assert.deepEqual(diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: vazio, regras: { ...REGRAS_DIAGNOSTICO, regras: [{ id: "CANAL_PARADO", ativa: false }] } }), []);
  const exp = await lerStatusDoDia(fake({ ["zpc:acquisition:daily:" + MON + ":bluesky"]: { status: "erro", code: "credential_expired" }, ["zpc:acquisition:daily:" + MON]: { outcomes: [] } }).kv, MON);
  assert.equal(diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: exp }).find((y) => y.canal === "bluesky").classe, "D");
  // Falha de leitura do KV vira motivo explícito, nunca "publicado".
  const falha = await lerStatusDoDia(fake({}, { throwOn: () => true }).kv, MON);
  assert.equal(falha.fonte, "falha_leitura");
  assert.match(diagnosticarDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: falha })[0].motivo, /falha ao ler/);
});

test("autonomia real = concluídas sem comando ÷ devidas; sem fonte ou sem devidas = não medido, nunca 100", async () => {
  assert.deepEqual([indiceAutonomia({}).valor, indiceAutonomia({}).texto], [null, "não medido"]);
  assert.equal(indiceAutonomia({ devidas: 0, concluidas: 0, fonteOk: true }).texto, "não medido");
  assert.equal(indiceAutonomia({ devidas: 3, concluidas: 3, fonteOk: false }).valor, null, "sem fonte não é 100");
  assert.equal(indiceAutonomia({ devidas: 3, concluidas: 2, fonteOk: true }).valor, 66.7);
  assert.equal(indiceAutonomia({ devidas: 2, concluidas: 5, fonteOk: true }).valor, 100, "concluídas limitadas às devidas");
  const x = fake({
    ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "blog", status: "publicado", url: "https://zevanory.api.br/blog/a" }] },
    ["zpc:acquisition:daily:" + MON + ":telegram"]: { status: "publicado", url: "https://t.me/zevanory/9", provider_post_id: "9", trigger: "manual" },
    ["zpc:acquisition:daily:" + MON + ":bluesky"]: { status: "erro", code: "bluesky_http_500" },
  });
  const status = await lerStatusDoDia(x.kv, MON);
  const a = autonomiaDoDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status });
  assert.deepEqual([a.devidas, a.concluidas, a.valor], [3, 1, 33.3], "Telegram disparado por comando não conta como autônomo");
  assert.equal(autonomiaDoDia({ day: MON, hour: 20, ativos: ALL_ACTIVE, status: await lerStatusDoDia(fake().kv, MON) }).texto, "não medido");
  // Janela (snapshot): dia sem registro não entra; canal aguardando credencial não é devido.
  assert.equal(autonomiaDaJanela({}).texto, "não medido");
  assert.equal(autonomiaDaJanela({ [MON]: {} }).texto, "não medido");
  const w = autonomiaDaJanela({ [MON]: { blog: { status: "publicado" }, telegram: { status: "aguardando credencial" }, bluesky: { status: "erro" } }, [TUE]: { telegram: { status: "publicado" }, bluesky: { status: "publicado", trigger: "manual" } } });
  assert.deepEqual([w.devidas, w.concluidas, w.valor, w.diasComFonte], [4, 2, 50, 2]);
});

test("vendas Hotmart: sem eventos = NÃO TESTADO (nunca 0 comprovado); ledger = PENDENTE; falha = INCONCLUSIVO; reconciliado = COMPROVADO", () => {
  assert.equal(estadoVendasHotmart({ ok: true, v: null }, MON).estado, "NAO_TESTADO");
  assert.match(estadoVendasHotmart({ ok: true, v: null }, MON).texto, /^NÃO TESTADO/);
  assert.equal(estadoVendasHotmart({ ok: true, v: { schema: "outro" } }, MON).estado, "NAO_TESTADO");
  assert.equal(estadoVendasHotmart({ ok: false, v: null }, MON).estado, "INCONCLUSIVO");
  const zero = estadoVendasHotmart({ ok: true, v: { schema: "zevanory-sales/v1", integrity: "webhook_authenticated", byDay: {} } }, MON);
  assert.deepEqual([zero.estado, zero.aprovadas], ["PENDENTE", 0]); assert.doesNotMatch(zero.texto, /COMPROVADO/);
  const dois = estadoVendasHotmart({ ok: true, v: { schema: "zevanory-sales/v1", integrity: "webhook_authenticated", byDay: { [MON]: { approved: 2 } } } }, MON);
  assert.deepEqual([dois.estado, dois.aprovadas], ["PENDENTE", 2]);
  assert.equal(estadoVendasHotmart({ ok: true, v: { schema: "zevanory-sales/v1", integrity: "reconciled", reconciledDays: [MON], byDay: { [MON]: { approved: 1 } } } }, MON).estado, "COMPROVADO");
  assert.equal(estadoVendasHotmart({ ok: true, v: { schema: "zevanory-sales/v1", integrity: "reconciled", reconciledDays: [], byDay: { [MON]: { approved: 1 } } } }, MON).estado, "PENDENTE");
  // Funil: ausente = não medido; bloco do dia lido; antigo = não fresco.
  assert.equal(funilDoDia({ ok: true, v: null }, MON).medido, false);
  const f = funilDoDia({ ok: true, v: { generatedAt: "2026-10-12T22:30:00Z", porDiaUtc: { [MON]: { views_br: 31, hotmart_view: 4, lead_submit: 2 } }, last7Days: { leadsConfirmed: 3 } } }, MON, Date.parse("2026-10-12T23:10:00Z"));
  assert.deepEqual([f.viewsBr, f.hotmartView, f.leadsFormulario, f.leadsConfirmados7, f.fresco], [31, 4, 2, 3, true]);
  assert.equal(funilDoDia({ ok: true, v: { generatedAt: "2026-10-12T10:00:00Z", porDiaUtc: {} } }, MON, Date.parse("2026-10-12T23:10:00Z")).fresco, false);
});

test("relatório das 20h em uma tela com dados reais; envio grava só o recibo com diagnósticos e autonomia", async () => {
  const x = fake({
    ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "blog", status: "publicado", url: "https://zevanory.api.br/blog/roteiro-2026-10-12", at: "2026-10-12T12:35:00Z" }, { channel: "telegram", status: "erro", code: "telegram_http_403" }] },
    ["zpc:acquisition:daily:" + MON + ":telegram"]: { status: "erro", code: "telegram_http_403" },
    ["zpc:acquisition:daily:" + MON + ":bluesky"]: { status: "publicado", url: "https://bsky.app/profile/zevanoryoficial.bsky.social/post/3abc", provider_post_id: "at://did:plc:x/app.bsky.feed.post/3abc" },
    "zpc-funnel:v1:summary": { generatedAt: "2026-10-12T22:40:00Z", porDiaUtc: { [MON]: { views_br: 37, hotmart_view: 5, lead_submit: 1 } }, last7Days: { leadsConfirmed: 2 } },
  });
  const r = await montarRelatorioDiario({ ZEVANORY_PRIVATE_ARTIFACTS: x.kv }, { day: MON, hour: 20, now: NOW_MON_20H, checklist: CHECKLIST_OK, agendaAmanha: "loja · Vendas na Prática · dor" });
  const t = r.text;
  for (const re of [/PUBLICADO HOJE \(esperado × real\)/, /• blog: esperado 1 × real 1 — https:\/\/zevanory\.api\.br\/blog\/roteiro-2026-10-12/, /• telegram: esperado 1 × real 0 — telegram_http_403/,
    /• bluesky: esperado 1 × real 1 — https:\/\/bsky\.app\//, /• youtube: inativo \(Shorts desligados/, /Views BR \(filtro de robôs e datacenter\): 37/, /Cliques \/hotmart \(hotmart_view\): 5/,
    /Leads: 1 no formulário hoje; 2 confirmados em 7 dias/, /Vendas aprovadas Hotmart: NÃO TESTADO \(webhook Hotmart sem eventos registrados\)/, /FALHAS DETECTADAS\n• telegram: erro — telegram_http_403/,
    /CANAL_PARADO telegram: 0\/1 — motivo: telegram_http_403 — classe B; ação automática: nenhuma/, /DECISÕES PENDENTES \(CLASSE D\)\n• nenhuma/, /Custo do dia: R\$ 0,00/, /Autonomia real: 66,7% \(2 de 3 devidas concluídas sem comando\)/]) assert.match(t, re);
  assert.doesNotMatch(t, /sem dados|100%|0 comprovad/i);
  assert.ok(t.split("\n").length <= 32, "uma tela");
  assert.deepEqual(x.writes, []);
  // Credencial ausente: decisão pendente de classe D; funil ausente: não medido + falha.
  const y = fake({ ["zpc:acquisition:daily:" + MON]: { outcomes: [{ channel: "bluesky", status: "aguardando credencial" }] } });
  const r2 = await montarRelatorioDiario({ ZEVANORY_PRIVATE_ARTIFACTS: y.kv }, { day: MON, hour: 20, now: NOW_MON_20H, checklist: [{ id: "telegram", configured: true }] });
  assert.match(r2.text, /• bluesky: aguardando credencial \(credencial é classe D/);
  assert.match(r2.text, /Views BR \(filtro de robôs e datacenter\): não medido/); assert.match(r2.text, /funil: resumo do dia ausente/);
  // Integração: runOwnerDailyDigest manda o relatório e o recibo leva diagnósticos (NC-01: KV operacional, 2 gravações/dia).
  const sent = [];
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: x.kv, RESEND_API_KEY: "resend-test", OWNER_ALERT_EMAIL: "owner@example.org", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@z", BLUESKY_HANDLE: "z.bsky.social", BLUESKY_APP_PASSWORD: "p" };
  const receipt = await runOwnerDailyDigest(env, NOW_MON_20H, async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: "email-1" }) }; });
  assert.equal(receipt.status, "publicado"); assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "ZEVANORY | Relatório do dia " + MON); assert.match(sent[0].text, /CANAL_PARADO telegram/);
  assert.deepEqual(receipt.diagnosticos.map((d) => d.canal), ["telegram"]);
  assert.deepEqual(receipt.autonomia, { valor: 66.7, devidas: 3, concluidas: 2 }); assert.equal(receipt.vendas_hotmart, "NAO_TESTADO");
  assert.deepEqual(receipt.channels, ["blog", "bluesky"]);
  assert.deepEqual(x.writes.filter((k) => !k.startsWith("zpc-activity")), ["zpc:acquisition:owner-digest:" + MON, "zpc:acquisition:owner-digest:" + MON]);
});

test("funil: resumo horário ganha views BR, hotmart_view e lead_submit por dia UTC, sem dado pessoal; falha = ausente", async () => {
  const rows = [
    { day: "2026-10-12", metric: "cls:mobile_al_br", n: 20 }, { day: "2026-10-12", metric: "cls:desktop_noal_br", n: 3 },
    { day: "2026-10-12", metric: "hotmart_view", n: 4 }, { day: "2026-10-12", metric: "lead_submit", n: 1 }, { day: "2026-10-11", metric: "cls:mobile_noal_br", n: 7 },
    { day: "lixo", metric: "hotmart_view", n: 99 },
  ];
  const s = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => (t.includes("/* relatorio-diario */") ? rows : []) }) });
  assert.deepEqual(s.porDiaUtc, { "2026-10-12": { views_br: 23, hotmart_view: 4, lead_submit: 1 }, "2026-10-11": { views_br: 7, hotmart_view: 0, lead_submit: 0 } });
  const f = await buildFunnelSummary({ DATABASE_URL: "x", MERCADOPAGO_ENV: "sandbox" }, { sqlFactory: () => ({ query: async (t) => { if (t.includes("/* relatorio-diario */")) throw new Error("db"); return []; } }) });
  assert.equal(f.porDiaUtc, null);
});

test("aviso público: hotmart_view separado de legacyMixedClicks numa linha curta; autonomia sem registro = não medido", async () => {
  const store = new Map([["zpc-funnel:v1:summary", JSON.stringify({ generatedAt: "2026-10-13T12:00:00Z", products: {}, last7Days: {}, clean: { since: "2026-10-12", pages: { "lucro-e-caixa": { views: 9, checkout_intent: 1, hotmart_view: 6, subscribe_click: 0 } }, sources: { blog: { views: 9, checkout_intent: 1, hotmart_view: 6, subscribe_click: 2 } }, campaigns: {}, classes: {}, asn: {} } })]]);
  const realFetch = globalThis.fetch, realLog = console.log, logs = [];
  globalThis.fetch = async (u, o = {}) => {
    u = String(u);
    const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u.includes("/storage/kv/")) {
      if (u.includes("/keys?")) return res(200, { result: [] });
      const k = decodeURIComponent(u.match(/values\/([^?]+)/)[1]);
      if ((o.method || "GET") === "PUT") { store.set(k, o.body); return res(200, {}); }
      return store.has(k) ? res(200, store.get(k)) : res(404, "");
    }
    if (u.includes("oauth2") || u.includes("token")) return res(200, { access_token: "x", expires_in: 3600 });
    return res(200, {});
  };
  console.log = (...a) => { logs.push(a.join(" ")); };
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", KV_NAMESPACE_ID: "n" });
  try { const { main } = await import("../scripts/audit/command-center-snapshot.mjs"); await main(); }
  finally { globalThis.fetch = realFetch; console.log = realLog; }
  const hv = logs.find((l) => l.startsWith("::notice title=HOTMART_VIEW::"));
  assert.ok(hv, "linha própria do hotmart_view"); assert.ok(hv.length < 200, "linha curta: " + hv.length);
  assert.deepEqual(JSON.parse(hv.slice("::notice title=HOTMART_VIEW::".length)), { at: "2026-10-13T12:00:00Z", since: "2026-10-12", hotmart_view: 6, legacyMixedClicks: 3 });
  const diag = JSON.parse(logs.find((l) => l.startsWith("::notice title=FUNNEL_DIAG::")).slice("::notice title=FUNNEL_DIAG::".length));
  assert.deepEqual([diag.sources.blog.legacyMixedClicks, diag.sources.blog.hotmartView], [3, 6]);
  assert.deepEqual([diag.pages["lucro-e-caixa"].legacyMixedClicks, diag.pages["lucro-e-caixa"].hotmartView], [1, 6]);
  const cc = JSON.parse(logs.find((l) => l.startsWith("::notice title=COMMAND_CENTER::")).slice("::notice title=COMMAND_CENTER::".length));
  assert.equal(cc.autonomy.pct, "não medido");
  const snap = JSON.parse(store.get("zpc:command:v1:snapshot"));
  assert.deepEqual([snap.autonomy.real.valor, snap.autonomy.real.texto], [null, "não medido"]);
  assert.notEqual(snap.autonomy.runs?.autonomyPct, 100);
});
