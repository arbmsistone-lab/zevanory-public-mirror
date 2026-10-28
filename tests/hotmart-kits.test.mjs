// Modelo B (Sol ORDEM 313): kits vendidos na Hotmart, entregues SOMENTE pelo Hotmart Club.
// Suíte sem banco (roda na suíte Node completa). O comportamento SQL (estado pegajoso, revogação, uso do link, trava
// da rota ZIP por provedor) é provado contra PostgreSQL real em tests/integration/hotmart-kits-postgres.test.mjs.
//   K* trava da rota ZIP do KV (texto do SQL e /entrega/reenviar com compra Hotmart)
//   D* regra do dia 8 (antes, no instante e depois; BRT x UTC; guarda contra horário de verão)
//   W* postback de kit no webhook autenticado (falha de gravação libera a deduplicação; nenhum dado em claro)
//   R* rotas da contingência (operador + motivo, desligada sem banco, link inválido)
//   T* textos do modelo B (fonte única, Termos, /reembolso, variante Hotmart, privacidade)
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import {
  KITS_DATA, day8ReleaseAt, day8Released, brt, authorizedFiles, catalogFor, kitSkuFor, kitProductMap, approvedAtMs,
  handleKitsRequest, contingencyEmail, ref, KITS_ADMIN_PATHS,
} from "../worker/hotmart-kits.mjs";
import { handleHotmartWebhook } from "../worker/content-service.mjs";
import { handleSalesControl } from "../worker/sales-control.mjs";
import { hotmartPage, HOTMART_CHECKOUT } from "../worker/sales-public-worker.mjs";
import { ENTREGA_CLUB, RESUMO_OFERTA, bannedPolicyHits } from "../worker/politica-unica.mjs";

const read = (p) => readTextNormalized(new URL("../" + p, import.meta.url));
const POLICY = JSON.parse(read("data/politica-unica.json"));
const H = 3_600_000;
const SKUS = ["ZEV-IA-011", "ZEV-VEN-011", "ZEV-LCX-011", "ZEV-CMB-011", "ZEV-NGC-011"];

// ---------------- K: trava da rota ZIP do KV ----------------
test("K1 a rota ZIP do KV só aceita o checkout próprio: emissão e consumo exigem provider da lista fechada", () => {
  const src = read("worker/cloudflare-worker.recovered.mjs");
  const issue = src.slice(src.indexOf("async function issueArtifactDownload"), src.indexOf("async function consumeArtifactDownload"));
  const consume = src.slice(src.indexOf("async function consumeArtifactDownload"), src.indexOf("__name(consumeArtifactDownload"));
  assert.match(src, /var OWN_CHECKOUT_PROVIDERS = Object\.freeze\(\["mercadopago", "asaas"\]\);/);
  assert.match(issue, /o\.status='paid' and o\.provider in \$\{OWN_CHECKOUT_PROVIDERS_SQL\}/);
  assert.match(consume, /o\.status='paid' and o\.provider in \$\{OWN_CHECKOUT_PROVIDERS_SQL\}/);
  assert.doesNotMatch(src.match(/var OWN_CHECKOUT_PROVIDERS = [^\n]+/)[0], /hotmart/i);
});

test("K2 /entrega/reenviar: compra Hotmart (mesmo com pedido pago e entregue) nunca pede link do ZIP", async () => {
  const order = "11111111-1111-4111-8111-111111111111";
  const evidence = JSON.stringify({ email_recipient: "real@cliente.com", email_destination_kind: "payer" });
  for (const provider of ["hotmart", "hotmart_club", "", null]) {
    const calls = [];
    const sqlFactory = () => ({ query: async (text, args) => {
      calls.push(text);
      if (/from orders/.test(text)) return /o\.provider in \('mercadopago', 'asaas'\)/.test(text) ? [] : [{ order_id: order, provider, status: "paid", fulfillment_status: "delivered", evidence_ref: evidence }];
      return [];
    } });
    let issued = 0;
    const worker = { fetch: async () => { issued++; return new Response(JSON.stringify({ download_url: "https://x/y" }), { status: 201 }); } };
    const r = await handleSalesControl(new Request("https://zevanory.api.br/api/support/resend-delivery", { method: "POST", headers: { "cf-connecting-ip": "198.51.100." + Math.floor(Math.random() * 250) }, body: JSON.stringify({ order_id: order, email: "real@cliente.com" }) }),
      { DATABASE_URL: "x", FULFILLMENT_OPERATOR_TOKEN: "t".repeat(40), RESEND_API_KEY: "re" }, { sqlFactory, worker });
    assert.equal(r.status, 200, String(provider));
    assert.equal(issued, 0, `provider=${provider}: nenhum pedido de link ao emissor`);
  }
  // Mesmo que o SQL devolva a linha (filtro removido), a checagem em JS recusa.
  const sqlFactory = () => ({ query: async (text) => (/from orders/.test(text) ? [{ order_id: order, provider: "hotmart", status: "paid", fulfillment_status: "delivered", evidence_ref: evidence }] : []) });
  let issued = 0;
  await handleSalesControl(new Request("https://zevanory.api.br/api/support/resend-delivery", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.251" }, body: JSON.stringify({ order_id: order, email: "real@cliente.com" }) }),
    { DATABASE_URL: "x", FULFILLMENT_OPERATOR_TOKEN: "t".repeat(40) }, { sqlFactory, worker: { fetch: async () => { issued++; return new Response("{}", { status: 201 }); } } });
  assert.equal(issued, 0);
  // Código de transação Hotmart não é código de pedido: 400, sem consulta.
  const r = await handleSalesControl(new Request("https://zevanory.api.br/api/support/resend-delivery", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.252" }, body: JSON.stringify({ order_id: "HP16015479281022", email: "real@cliente.com" }) }), { DATABASE_URL: "x" }, { sqlFactory });
  assert.equal(r.status, 400);
});

test("K3 o webhook Hotmart de kit nunca toca a rota ZIP (sem emissão de token, sem e-mail de download)", () => {
  const cs = read("worker/content-service.mjs"), kits = read("worker/hotmart-kits.mjs");
  for (const s of [cs, kits]) assert.doesNotMatch(s, /issueArtifactDownload|artifact_download_tokens|\/private\/artifacts|zevanory\/v1\.1\//);
});

// ---------------- D: regra do dia 8 ----------------
test("D1 dia 8 = 8 dias inteiros (192 h) desde a aprovação: antes, no instante e depois", () => {
  for (const iso of ["2026-10-28T13:00:00.000Z", "2026-10-29T02:59:00.000Z", "2026-10-28T03:01:00.000Z", "2026-12-31T23:59:59.999Z"]) {
    const a = Date.parse(iso), rel = day8ReleaseAt(a);
    assert.equal(rel, a + 192 * H, iso);
    assert.equal(day8Released(a, rel - 1), false, iso + " -1 ms");
    assert.equal(day8Released(a, rel), true, iso + " no instante");
    assert.equal(day8Released(a, rel + 1), true, iso + " +1 ms");
    assert.equal(day8Released(a, a + 168 * H), false, iso + " 7 dias (168 h) ainda não");
    assert.equal(day8Released(a, a + 191 * H + 59 * 60_000), false, iso + " 7 dias e 23:59");
  }
});

test("D2 fuso America/Sao_Paulo: aprovação 23:59 BRT (02:59 UTC do dia seguinte) libera no 8º dia às 23:59 BRT", () => {
  const a = Date.parse("2026-10-28T23:59:00-03:00");
  assert.equal(new Date(a).toISOString(), "2026-10-29T02:59:00.000Z");
  assert.equal(brt(day8ReleaseAt(a)), "05/11/2026 às 23:59");
  const b = Date.parse("2026-10-28T00:01:00-03:00");
  assert.equal(brt(day8ReleaseAt(b)), "05/11/2026 às 00:01");
  assert.equal(day8Released(b, Date.parse("2026-11-04T23:59:59-03:00")), false, "virada do 7º para o 8º dia não libera");
  assert.equal(day8Released(b, Date.parse("2026-11-05T00:00:59-03:00")), false, "início do dia civil do 8º dia, antes das 192 h");
  assert.equal(day8Released(b, Date.parse("2026-11-05T00:01:00-03:00")), true);
});

test("D3 horário de verão nunca antecipa: com um fuso que muda de relógio, vale o mais tardio (192 h ou mesmo horário de parede)", () => {
  // Fim do horário de verão (EUA, 01/11/2026): 192 h cairiam 1 h antes do mesmo horário de parede.
  const a = Date.parse("2026-10-28T14:00:00Z"); // 10:00 EDT
  const rel = day8ReleaseAt(a, { tz: "America/New_York" });
  assert.equal(new Date(rel).toISOString(), "2026-11-05T15:00:00.000Z"); // 10:00 EST
  // Início do horário de verão (14/03/2027): o mesmo horário de parede cairia 1 h ANTES de 192 h; vale 192 h.
  const b = Date.parse("2027-03-10T15:00:00Z"); // 10:00 EST
  assert.equal(day8ReleaseAt(b, { tz: "America/New_York" }), b + 192 * H);
  for (let t = Date.parse("2026-01-01T00:00:00Z"); t < Date.parse("2027-01-01T00:00:00Z"); t += 7 * 3600_000 + 13 * 60_000) {
    assert.ok(day8ReleaseAt(t, { tz: "America/New_York" }) >= t + 192 * H);
    assert.equal(day8ReleaseAt(t), t + 192 * H, "America/Sao_Paulo sem horário de verão: exatamente 192 h");
  }
});

test("D4 arquivos autorizados: dia 1 = planilhas, modelos e textos; dia 8 = PDFs e pacote completo; nada do dia 8 antes da liberação", () => {
  const a = Date.parse("2026-10-28T13:00:00Z");
  for (const sku of SKUS) {
    const all = catalogFor(sku);
    assert.ok(all.some((f) => /\.xlsx$/.test(f.caminho)) && all.some((f) => /\.docx$/.test(f.caminho)), sku + ": planilha e modelo no dia 1");
    assert.ok(all.some((f) => f.liberacao === "dia8" && /\.zip$/.test(f.caminho)), sku + ": pacote completo no dia 8");
    for (const f of all) assert.equal(f.liberacao, /\.(pdf|zip)$/.test(f.caminho) ? "dia8" : "dia1", f.caminho);
    const early = authorizedFiles(sku, a, a + 192 * H - 1);
    assert.ok(early.length > 0 && early.every((f) => f.liberacao === "dia1" && !/\.(pdf|zip)$/.test(f.caminho)), sku);
    assert.equal(authorizedFiles(sku, a, a + 192 * H).length, all.length, sku);
    for (const f of all) assert.match(f.kv_key, new RegExp(`^zevanory/club-b/v1\\.2/${sku}/`), "nunca a chave do ZIP legado zevanory/v1.1/");
  }
});

test("D5 approved_date ausente, inválido ou no futuro => horário de chegada (nunca antecipa)", () => {
  const now = Date.parse("2026-10-28T13:00:00Z");
  assert.equal(approvedAtMs({ purchase: { approved_date: now - 5000 } }, now), now - 5000);
  assert.equal(approvedAtMs({ purchase: {} }, now), now);
  assert.equal(approvedAtMs({ purchase: { approved_date: "x" } }, now), now);
  assert.equal(approvedAtMs({ purchase: { approved_date: now + 3600_000 } }, now), now);
  assert.equal(approvedAtMs({ purchase: { approved_date: 1000 } }, now), now);
});

// ---------------- W: postback de kit ----------------
class MapKV { data = new Map(); async get(k) { return this.data.get(k) ?? null; } async put(k, v) { this.data.set(k, String(v)); } async delete(k) { this.data.delete(k); } }
const HOTTOK = "hottok-test-1234567890abcdef";
const hook = (body) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": HOTTOK }, body: JSON.stringify(body) });
const kitEvent = (event, txn = "HP0001KIT", extra = {}) => ({ event, data: { product: { id: 8704733, name: "ZEVANORY IA na Prática" }, buyer: { email: "Comprador@Example.com", name: "Ana Souza" }, purchase: { transaction: txn, approved_date: Date.parse("2026-10-28T13:00:00Z") }, ...extra } });

test("W1 mapa produto -> SKU vem de data/hotmart-kits.json e pode ser estendido por HOTMART_KIT_PRODUCT_IDS", () => {
  assert.equal(kitSkuFor({ product: { id: 8704733 } }), "ZEV-IA-011");
  assert.equal(kitSkuFor({ product: { id: 8704905 } }), null, "Conteúdo Pronto não é kit");
  assert.equal(kitSkuFor({ product: { id: 123 } }, { HOTMART_KIT_PRODUCT_IDS: "123=ZEV-NGC-011, 77=NAO-EXISTE, x=ZEV-IA-011" }), "ZEV-NGC-011");
  assert.equal(kitProductMap({ HOTMART_KIT_PRODUCT_IDS: "77=NAO-EXISTE" }).has("77"), false);
});

test("W2 postback de kit sem banco => 503 e a deduplicação é liberada (a Hotmart reenvia e o reenvio é processado)", async () => {
  const kv = new MapKV();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, HOTMART_HOTTOK: HOTTOK, LEAD_PRIVACY_SECRET: "s".repeat(40) };
  const r = await handleHotmartWebhook(hook(kitEvent("PURCHASE_APPROVED")), env, null, async () => new Response("{}"), {});
  assert.equal(r.status, 503);
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith("zpc:cp:txn:")).length, 0, "chave de deduplicação removida");
  const queries = [];
  const sqlFactory = () => ({ query: async (text, args) => { queries.push({ text, args }); return /kits:ingest/.test(text) ? [{ status: "approved" }] : []; } });
  const ok = await handleHotmartWebhook(hook(kitEvent("PURCHASE_APPROVED")), { ...env, DATABASE_URL: "postgres://x" }, null, async () => new Response("{}"), { sqlFactory });
  assert.equal(ok.status, 200);
  const ingest = queries.find((q) => /kits:ingest/.test(q.text));
  assert.ok(ingest, "estado gravado no PostgreSQL");
  const flat = JSON.stringify(ingest.args);
  assert.doesNotMatch(flat, /comprador@example\.com|HP0001KIT|Ana/i, "transação, e-mail e nome nunca em claro");
  assert.equal(ingest.args[3], "ZEV-IA-011");
  assert.equal(ingest.args[4], "approved");
  assert.equal(ingest.args[5], "2026-10-28T13:00:00.000Z");
});

test("W3 eventos: reembolso, chargeback e cancelamento revogam links; PROTEST não revoga; sem segredo de privacidade => 503", async () => {
  for (const [event, state, revokes] of [["PURCHASE_REFUNDED", "refunded", true], ["PURCHASE_CHARGEBACK", "chargeback", true], ["PURCHASE_CANCELED", "canceled", true], ["PURCHASE_PROTEST", "protest", false], ["PURCHASE_COMPLETE", "approved", false]]) {
    const queries = [];
    const sqlFactory = () => ({ query: async (text, args) => { queries.push({ text, args }); return /kits:ingest/.test(text) ? [{ status: state }] : []; } });
    const r = await handleHotmartWebhook(hook(kitEvent(event)), { ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, LEAD_PRIVACY_SECRET: "s".repeat(40), DATABASE_URL: "x" }, null, async () => new Response("{}"), { sqlFactory });
    assert.equal(r.status, 200, event);
    assert.equal(queries.find((q) => /kits:ingest/.test(q.text)).args[4], state, event);
    assert.equal(queries.some((q) => /kits:revoke-links/.test(q.text)), revokes, event);
  }
  const r = await handleHotmartWebhook(hook(kitEvent("PURCHASE_APPROVED")), { ZEVANORY_PRIVATE_ARTIFACTS: new MapKV(), HOTMART_HOTTOK: HOTTOK, DATABASE_URL: "x" }, null, async () => new Response("{}"), { sqlFactory: () => ({ query: async () => [] }) });
  assert.equal(r.status, 503);
});

// ---------------- R: rotas ----------------
const adminReq = (path, body, auth = true) => new Request("https://zevanory.api.br" + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer op" } : {}) }, body: JSON.stringify(body) });
const isOperator = async (req) => req.headers.get("authorization") === "Bearer op";

test("R1 rotas do operador: credencial obrigatória, operador e motivo obrigatórios, sem banco => 503 (fail-closed)", async () => {
  const body = { transaction: "HP0001KIT", email: "a@b.co", operator: "renan", reason: "Club fora do ar desde 10h" };
  for (const p of KITS_ADMIN_PATHS) {
    assert.equal((await handleKitsRequest(adminReq(p, body, false), { DATABASE_URL: "x" }, { sqlFactory: () => ({ query: async () => [] }), isOperator })).status, 401, p);
    assert.equal((await handleKitsRequest(adminReq(p, body), { DATABASE_URL: "x" }, { sqlFactory: () => ({ query: async () => [] }) })).status, 401, p + " sem verificador");
    assert.equal((await handleKitsRequest(new Request("https://zevanory.api.br" + p), {}, { isOperator })).status, 405, p);
    assert.equal((await handleKitsRequest(adminReq(p, body), {}, { isOperator })).status, 503, p);
  }
  const sqlFactory = () => ({ query: async () => [] });
  assert.equal((await handleKitsRequest(adminReq(KITS_ADMIN_PATHS[1], { ...body, operator: "" }), { DATABASE_URL: "x" }, { sqlFactory, isOperator })).status, 400);
  assert.equal((await handleKitsRequest(adminReq(KITS_ADMIN_PATHS[1], { ...body, reason: "curto" }), { DATABASE_URL: "x" }, { sqlFactory, isOperator })).status, 400);
  assert.equal((await handleKitsRequest(adminReq(KITS_ADMIN_PATHS[0], { enabled: true, hours: 73, operator: "renan", reason: "Club fora do ar desde 10h" }), { DATABASE_URL: "x" }, { sqlFactory, isOperator })).status, 400, "no máximo 72 h");
  assert.equal(await handleKitsRequest(new Request("https://zevanory.api.br/outra"), {}, {}), null);
});

test("R2 leitura do estado da compra falha => nenhum link (503), nenhum e-mail", async () => {
  let mails = 0;
  const sqlFactory = () => ({ query: async (text) => { if (/kits:schema/.test(text)) return []; throw new Error("neon down"); } });
  const r = await handleKitsRequest(adminReq(KITS_ADMIN_PATHS[1], { transaction: "HP0001KIT", email: "a@b.co", operator: "renan", reason: "Club fora do ar desde 10h" }),
    { DATABASE_URL: "x", LEAD_PRIVACY_SECRET: "s".repeat(40), RESEND_API_KEY: "re" }, { sqlFactory, isOperator, fetchImpl: async () => { mails++; return new Response("{}"); } });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "purchase_state_unavailable");
  assert.equal(mails, 0);
});

test("R3 rota do comprador: link malformado => 404; método errado => 405", async () => {
  const sqlFactory = () => ({ query: async () => [] });
  assert.equal((await handleKitsRequest(new Request("https://zevanory.api.br/entrega/contingencia?t=curto"), { DATABASE_URL: "x" }, { sqlFactory })).status, 404);
  assert.equal((await handleKitsRequest(new Request("https://zevanory.api.br/entrega/contingencia", { method: "POST" }), { DATABASE_URL: "x" }, { sqlFactory })).status, 405);
  assert.equal((await handleKitsRequest(new Request("https://zevanory.api.br/entrega/contingencia/arquivo"), { DATABASE_URL: "x" }, { sqlFactory })).status, 405);
});

test("R4 e-mail de contingência: link, validade e liberação do dia 8 em horário de Brasília; aviso de licença; sem DRM", async () => {
  const a = Date.parse("2026-10-28T23:59:00-03:00");
  const m = contingencyEmail({ sku: "ZEV-NGC-011", link: "https://zevanory.api.br/entrega/contingencia?t=X", expiresMs: Date.parse("2026-10-30T12:00:00-03:00"), approvedMs: a, nowMs: Date.parse("2026-10-30T10:00:00-03:00") });
  assert.match(m.subject, /Negócio Completo/);
  assert.match(m.text, /vale até 30\/10\/2026 às 12:00 \(horário de Brasília\)/);
  assert.match(m.text, /serão liberados a partir de 05\/11\/2026 às 23:59 \(horário de Brasília\)/);
  assert.ok(m.text.includes(ENTREGA_CLUB.aviso_licenca));
  assert.doesNotMatch(m.text, /DRM|marca d.água/i);
  const later = contingencyEmail({ sku: "ZEV-IA-011", link: "L", expiresMs: a, approvedMs: a, nowMs: a + 192 * H });
  assert.ok(later.text.includes(ENTREGA_CLUB.dia8_liberado));
  assert.equal(await ref("s".repeat(40), "email", "x@y.z"), await ref("s".repeat(40), "email", "x@y.z"));
  assert.notEqual(await ref("s".repeat(40), "email", "x@y.z"), await ref("s".repeat(40), "transaction", "x@y.z"), "separação de domínio");
});

// ---------------- T: textos ----------------
const visible = (html) => html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const TIMELINE = [/área de membros/, /1º dia/, /8º dia/, /planilhas/, /modelos/, /PDF/];

test("T1 fonte única: resumo da oferta Hotmart = entrega_club; aviso de licença exato; linha canônica do modelo B", () => {
  const E = POLICY.entrega_club;
  assert.equal(RESUMO_OFERTA.hotmart.entrega, E.resumo_entrega);
  assert.equal(RESUMO_OFERTA.hotmart.restricoes, E.restricoes);
  assert.equal(E.aviso_licenca, "Material licenciado para uso individual do comprador. É proibida sua revenda ou redistribuição não autorizada, respeitados os direitos previstos em lei.");
  assert.ok(E.restricoes.endsWith(E.aviso_licenca));
  assert.equal(E.linha_canonica, "Acesso online imediato pela área de membros; planilhas e modelos para baixar desde o 1º dia; PDFs e pacote completo para baixar a partir do 8º dia.");
  for (const k of ["resumo_entrega", "faq_resposta", "termos_paragrafo", "email_boas_vindas", "oferta_condicao", "fato_compra", "resumo_politica"])
    for (const re of TIMELINE.slice(1, 3)) assert.match(E[k], re, k);
});

test("T2 CDC: nenhum texto do modelo B promete tudo no 1º dia, recusa reembolso por consumo, usa frase proibida ou chama o aviso de DRM", () => {
  // A "nota" é para a equipe (diz que o aviso NÃO é DRM); os demais campos são texto ao cliente.
  const all = Object.entries(POLICY.entrega_club).filter(([k]) => k !== "nota").map(([, v]) => v).join("\n");
  assert.deepEqual(bannedPolicyHits(all), []);
  assert.doesNotMatch(all, /baixar todo o material|download imediato|tudo de uma vez/i);
  assert.doesNotMatch(all, /reembolso (será |é )?(negado|recusado)|não (há|haverá) reembolso|perde o direito/i);
  assert.match(POLICY.entrega_club.termos_paragrafo, /sem recusa por acesso ou consumo do conteúdo/);
  assert.match(POLICY.entrega_club.reembolso_paragrafo, /não recusamos reembolso por acesso ou consumo do conteúdo/);
  assert.doesNotMatch(all.replace(/não é um mecanismo técnico de proteção \(DRM\)/, ""), /DRM|marca d.água individual|protegido contra cópia/i);
});

test("T3 Termos e /reembolso (fonte e site de vendas) trazem o texto do modelo B; declarações P23 e sol_text intactos", () => {
  const E = POLICY.entrega_club;
  for (const p of ["termos/index.html", "sales-public/termos.html"]) {
    const v = visible(read(p));
    assert.ok(v.includes(E.termos_paragrafo), p + ": parágrafo de entrega Hotmart");
    assert.ok(v.includes(E.termos_licenca.replace(/&/g, "&")), p + ": aviso de licença");
    assert.ok(v.includes("Nas compras pela Hotmart (seção 4): " + E.linha_canonica), p + ": resumo");
    assert.ok(v.includes(POLICY.sol_text), p + ": sol_text (seção 6) sem alteração");
    assert.ok(v.includes("comunicará imediatamente o Mercado Pago para impedir o lançamento ou iniciar o estorno"), p + ": D7962-5-3 intacta");
  }
  for (const p of ["reembolso/index.html", "sales-public/reembolso.html"]) {
    const v = visible(read(p));
    assert.ok(v.includes(E.reembolso_paragrafo), p);
    assert.ok(v.includes(POLICY.sol_text), p + ": sol_text intacto");
  }
});

test("T4 variante /hotmart/<kit>: linha do tempo do modelo B, aviso de licença, nenhum 72 h, reenvio ou 'todo o material'", () => {
  for (const slug of Object.keys(HOTMART_CHECKOUT)) {
    const out = hotmartPage(read(`sales-public/${slug}.html`), slug, "https://pay.hotmart.com/X123ABC");
    const v = visible(out.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, ""));
    for (const s of [ENTREGA_CLUB.fato_compra, ENTREGA_CLUB.faq_pergunta, ENTREGA_CLUB.faq_resposta, ENTREGA_CLUB.resumo_entrega, ENTREGA_CLUB.restricoes, ENTREGA_CLUB.resumo_politica, ENTREGA_CLUB.confianca_titulo])
      assert.ok(v.includes(s), `${slug}: ${s.slice(0, 50)}`);
    assert.doesNotMatch(v, /72 horas|um download|entrega\/reenviar|baixar todo o material|Mercado Pago|arquivo \.zip com todo/, slug);
    const ld = JSON.parse(out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const faq = ld["@graph"].find((n) => n["@type"] === "FAQPage");
    assert.ok(faq.mainEntity.some((q) => q.name === ENTREGA_CLUB.faq_pergunta && q.acceptedAnswer.text === ENTREGA_CLUB.faq_resposta), slug + ": FAQPage");
  }
});

test("T5 checkout e IDs dos kits em data/hotmart-kits.json (mesmos links publicados antes), sem segredo", () => {
  assert.deepEqual(HOTMART_CHECKOUT, {
    "ia-na-pratica": "https://pay.hotmart.com/F107979716H?off=g9knd34r",
    "vendas-na-pratica": "https://pay.hotmart.com/Y107979937I?off=8mg88sdd",
    "lucro-e-caixa": "https://pay.hotmart.com/L107979973K?off=ksb5di36",
    "combo-ia-vendas": "https://pay.hotmart.com/H107979990T?off=b3ytmah4",
    "negocio-completo": "https://pay.hotmart.com/U107980005X?off=weo47apk",
  });
  assert.deepEqual(KITS_DATA.kits.map((k) => k.sku), SKUS);
  assert.doesNotMatch(read("data/hotmart-kits.json"), /hottok|token|secret|senha|password|Bearer/i);
});

test("T6 privacidade: papel real da Hotmart (controladora para finalidades próprias), sem dizer que é só operadora", () => {
  for (const p of ["privacidade/index.html", "sales-public/privacidade.html"]) {
    const raw = read(p), v = visible(raw);
    assert.match(v, /2\.3\. Compras pela Hotmart/);
    assert.match(v, /A Hotmart não age apenas em nome da ZEVANORY: para o pagamento, a prevenção a fraudes e o cumprimento de obrigações legais e regulatórias, ela trata os seus dados para finalidades próprias, como controladora/);
    assert.doesNotMatch(v, /Hotmart[^.]{0,120}\boperadora?\b|\boperadora?\b[^.]{0,40}Hotmart/i, p);
    const operators = (raw.match(/<h2>2\. Com quem compartilhamos \(operadores\)<\/h2><p>([\s\S]*?)<\/p>/) || [])[1] || "";
    assert.ok(operators.length > 50 && !/Hotmart/.test(operators), p + ": Hotmart fora da lista de operadores");
    assert.match(v, /sem o e-mail em claro/);
    assert.match(v, /não levam marca individual do comprador/);
  }
});
