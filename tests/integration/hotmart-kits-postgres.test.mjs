// Modelo B (Sol ORDEM 313) contra PostgreSQL REAL (cada consulta num processo psql próprio).
//   Z1-Z3  trava da rota ZIP do KV: o SQL REAL da emissão e do consumo (extraído do bundle) recusa compra Hotmart;
//          /entrega/reenviar com pedido Hotmart pago e entregue não chama o emissor.
//   P1-P5  ingestão dos postbacks pelo webhook autenticado: aprovação, duplicata, fora de ordem, PROTEST, chargeback,
//          hottok errado.
//   C1-C9  contingência S313-03 (os 7 requisitos): desligada por padrão; identificação da transação; estado atual
//          (falha => nenhum link); destinatário = comprador; arquivos autorizados com a fronteira do dia 8 (antes, no
//          instante, depois); link individual, curto e revogável; registro sem token nem e-mail; bloqueio depois de
//          reembolso, chargeback ou cancelamento; revogação pelo operador; contingência desligada; validade; teto de usos.
// Rodar: T4_PG_HOST=/var/tmp/pg-kits/sock T4_PG_PORT=55440 node --test tests/integration/hotmart-kits-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { handleHotmartWebhook } from "../../worker/content-service.mjs";
import { handleKitsRequest, day8ReleaseAt, ref } from "../../worker/hotmart-kits.mjs";
import { handleSalesControl } from "../../worker/sales-control.mjs";

const run = promisify(execFile);
const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_hotmart_kits";
const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "true" : "false") : "'" + String(v).replace(/'/g, "''") + "'";
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));
const psql = (sql, db = DB) => execFileSync("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c", sql], { encoding: "utf8" }).trim();
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === "" ? null : r[i]])));
}
const pgQuery = async (statement, params = []) => {
  const { stdout } = await run("psql", ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", inline(statement, params)], { encoding: "utf8" });
  return parseCsv(stdout);
};
const sqlFactory = () => ({ query: pgQuery });

const SECRET = "k".repeat(40), HOTTOK = "hottok-kits-1234567890abcdef", OP = "o".repeat(40);
const T0 = Date.parse("2026-10-28T13:00:00Z"); // aprovação: 28/10/2026 10:00 BRT
const H = 3_600_000;
class MapKV { data = new Map(); async get(k, t) { const v = this.data.get(k); return v === undefined ? null : t === "arrayBuffer" ? v : String(v); } async put(k, v) { this.data.set(k, v); } async delete(k) { this.data.delete(k); } }
// Catálogo sintético (mesma forma do de data/hotmart-kits.json) com bytes conhecidos no KV falso.
const bytes = (s) => new TextEncoder().encode(s).buffer;
const sha = (s) => createHash("sha256").update(s).digest("hex").toUpperCase();
const FILES = [["d1x", "Planilha.xlsx", "dia1"], ["d1d", "Modelo.docx", "dia1"], ["d8p", "Manual.pdf", "dia8"], ["d8z", "Pacote.zip", "dia8"]];
const fid = (k) => createHash("sha256").update(k).digest("hex").slice(0, 16);
const CATALOG = { "ZEV-IA-011": FILES.map(([k, name, lib]) => ({ id: fid(k), arquivo: name, caminho: "IA/" + name, liberacao: lib, content_type: "application/octet-stream", sha256: sha("conteudo " + k), kv_key: "zevanory/club-b/v1.2/ZEV-IA-011/IA/" + name })) };
const KV = new MapKV();
for (const [k, name] of FILES) KV.data.set("zevanory/club-b/v1.2/ZEV-IA-011/IA/" + name, bytes("conteudo " + k));
const ENV = Object.freeze({ DATABASE_URL: "postgres://ci", LEAD_PRIVACY_SECRET: SECRET, HOTMART_HOTTOK: HOTTOK, RESEND_API_KEY: "re_ci", ZEVANORY_PRIVATE_ARTIFACTS: KV });

const hook = (body, token = HOTTOK) => new Request("https://zevanory.api.br/api/webhooks/hotmart", { method: "POST", headers: { "content-type": "application/json", "x-hotmart-hottok": token }, body: JSON.stringify(body) });
const kitEvent = (event, txn, { email = "ana.compradora@example.com", approved = T0, product = 8704733 } = {}) =>
  ({ event, data: { product: { id: product, name: "ZEVANORY IA na Prática" }, buyer: { email, name: "Ana Souza" }, purchase: { transaction: txn, approved_date: approved } } });
const postback = async (event, txn, opts) => {
  const r = await handleHotmartWebhook(hook(kitEvent(event, txn, opts), opts?.token), { ...ENV, ZEVANORY_PRIVATE_ARTIFACTS: new MapKV() }, null, async () => new Response("{}"), { sqlFactory });
  return { status: r.status, body: await r.json() };
};
const purchaseRow = async (txn) => (await pgQuery("select status, (extract(epoch from approved_at)*1000)::bigint::text as approved_ms, protest_at is not null as protest, revoked_at is not null as revoked, last_event from hotmart_kit_purchases where transaction_ref=$1", [await ref(SECRET, "transaction", txn)]))[0];

function mailbox({ fail = false } = {}) {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => { if (!String(url).includes("resend")) throw new Error("rede bloqueada: " + url); const b = JSON.parse(init.body); sent.push(b); return new Response("{}", { status: fail ? 500 : 200 }); } };
}
const isOperator = async (req) => req.headers.get("authorization") === "Bearer " + OP;
const admin = async (path, body, { now = T0, mail = mailbox(), q, sql = sqlFactory } = {}) => {
  const r = await handleKitsRequest(new Request("https://zevanory.api.br/api/admin/kits/contingencia/" + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + OP }, body: JSON.stringify(body) }),
    ENV, { sqlFactory: sql, isOperator, fetchImpl: mail.fetchImpl, now: () => now, catalog: CATALOG, ...(q ? { q } : {}) });
  return { status: r.status, body: await r.json(), mail };
};
const WHO = { operator: "renan-dono", reason: "Hotmart Club fora do ar desde 10h; cliente pediu acesso" };
const tokenOf = (mail) => (mail.sent.at(-1)?.text.match(/entrega\/contingencia\?t=([A-Za-z0-9_-]{43})/) || [])[1];
const viewPage = async (token, now) => { const r = await handleKitsRequest(new Request("https://zevanory.api.br/entrega/contingencia?t=" + token), ENV, { sqlFactory, now: () => now, catalog: CATALOG }); return { status: r.status, html: await r.text() }; };
const download = async (token, key, now) => {
  const r = await handleKitsRequest(new Request("https://zevanory.api.br/entrega/contingencia/arquivo", { method: "POST", body: new URLSearchParams({ t: token, f: fid(key) }) }), ENV, { sqlFactory, now: () => now, catalog: CATALOG });
  return { status: r.status, text: r.status === 200 ? await r.text() : "" };
};
const turnOn = (hours = 4) => admin("estado", { enabled: true, hours, ...WHO });

before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  psql(readFileSync(new URL("../t4_sim/schema.sql", import.meta.url), "utf8"));
});

// ---------------- Z: trava da rota ZIP ----------------
const SRC = readFileSync(new URL("../../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const own = SRC.match(/var OWN_CHECKOUT_PROVIDERS = Object\.freeze\((\[[^\]]*\])\);/);
const OWN_SQL = own ? "(" + JSON.parse(own[1]).map((p) => `'${p}'`).join(",") + ")" : null;
const pick = (re) => { const m = SRC.match(re); if (!m) throw new Error("SQL do Worker não encontrado: " + re); return m[1].replaceAll("${OWN_CHECKOUT_PROVIDERS_SQL}", OWN_SQL); };
const ISSUE_SQL = () => pick(/const eligible = await sql\.query\(`([\s\S]*?)`, \[orderId\]\);/);
const CONSUME_SQL = () => pick(/const rows = await sql\.query\(`(update artifact_download_tokens t set used_at=now\(\)[\s\S]*?)`, \[sha2562\(raw\)\]\);/);
function order(provider, status = "paid") {
  const id = randomUUID();
  psql(`insert into orders(order_id,offer_id,amount,provider,external_reference,status) values (${lit(id)},'ZEV-IA-011',197,${lit(provider)},${lit("ext-" + id)},${lit(status)});
        insert into financial_events(provider_event_id,provider,provider_payment_id,normalized_event,order_id) values (${lit("ev-" + id)},${lit(provider)},${lit("pay-" + id)},'payment_confirmed',${lit(id)});
        insert into service_fulfillment(fulfillment_id,order_id,status,evidence_ref) values (${lit(randomUUID())},${lit(id)},'delivered',${lit(JSON.stringify({ email_recipient: "real@cliente.com", email_destination_kind: "payer" }))})`);
  return id;
}

test("Z1 emissão do ZIP (SQL real): compra Hotmart paga e confirmada => nenhuma linha; checkout próprio => 1", { skip: SKIP }, () => {
  assert.ok(OWN_SQL && !/hotmart/i.test(OWN_SQL));
  for (const p of ["hotmart", "hotmart_club", "HOTMART"]) assert.equal(psql(inline(ISSUE_SQL(), [order(p)])), "", p);
  assert.match(psql(inline(ISSUE_SQL(), [order("mercadopago")])), /ZEV-IA-011/);
  assert.equal(psql(inline(ISSUE_SQL(), [order("mercadopago", "refunded")])), "");
});

test("Z2 consumo de link JÁ emitido (SQL real): pedido Hotmart => nada; checkout próprio => 1; estornado => nada", { skip: SKIP }, () => {
  const tok = (oid) => { const h = createHash("sha256").update(oid).digest("hex"); psql(`insert into artifact_download_tokens(token_id,order_id,token_sha256,artifact_key,artifact_sha256,expires_at,issued_by) values (${lit(randomUUID())},${lit(oid)},${lit(h)},'zevanory/v1.1/ZEVANORY_IA_na_Pratica_v1.1.zip','AFB6',now()+interval '1 hour','t')`); return h; };
  const h1 = tok(order("hotmart"));
  assert.equal(psql(inline(CONSUME_SQL(), [h1])), "", "token antigo de pedido Hotmart não entrega");
  const mp = order("mercadopago"), h2 = tok(mp);
  assert.notEqual(psql(inline(CONSUME_SQL(), [h2])), "");
  const mp2 = order("mercadopago"), h3 = tok(mp2);
  psql(`update orders set status='refunded' where order_id=${lit(mp2)}`);
  assert.equal(psql(inline(CONSUME_SQL(), [h3])), "");
});

test("Z3 /entrega/reenviar (handler real + PostgreSQL): pedido Hotmart pago e entregue não chama o emissor; checkout próprio chama", { skip: SKIP }, async () => {
  const calls = [];
  const worker = { fetch: async (req) => { calls.push(JSON.parse(await req.text()).order_id); return new Response(JSON.stringify({ download_url: "https://zevanory.api.br/private/artifacts/download?token=x" }), { status: 201 }); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    const send = (oid, ip) => handleSalesControl(new Request("https://zevanory.api.br/api/support/resend-delivery", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ order_id: oid, email: "real@cliente.com" }) }),
      { DATABASE_URL: "x", FULFILLMENT_OPERATOR_TOKEN: "f".repeat(40), RESEND_API_KEY: "re" }, { sqlFactory, worker });
    const h = order("hotmart"), m = order("mercadopago");
    assert.equal((await send(h, "203.0.113.31")).status, 200);
    assert.deepEqual(calls, [], "nenhum pedido de link para compra Hotmart");
    assert.equal((await send(m, "203.0.113.32")).status, 200);
    assert.deepEqual(calls, [m]);
  } finally { globalThis.fetch = realFetch; }
});

// ---------------- P: ingestão ----------------
test("P1 aprovação grava approved + approved_at do postback; duplicata é idempotente (1 evento)", { skip: SKIP }, async () => {
  assert.equal((await postback("PURCHASE_APPROVED", "HP1601P1")).status, 200);
  const row = await purchaseRow("HP1601P1");
  assert.equal(row.status, "approved"); assert.equal(row.protest, "f"); assert.equal(row.revoked, "f");
  assert.equal(Number(row.approved_ms), T0);
  await postback("PURCHASE_COMPLETE", "HP1601P1"); await postback("PURCHASE_APPROVED", "HP1601P1");
  assert.equal((await purchaseRow("HP1601P1")).last_event, "PURCHASE_COMPLETE", "reenvio do mesmo evento não é reprocessado");
  assert.equal(psql(`select count(*) from hotmart_kit_events where transaction_ref=${lit(await ref(SECRET, "transaction", "HP1601P1"))} and event='PURCHASE_APPROVED'`), "1");
  assert.equal(psql(`select count(*) from hotmart_kit_purchases`), "1");
  const stored = psql("select row_to_json(p)::text from hotmart_kit_purchases p");
  assert.doesNotMatch(stored, /HP1601P1|ana\.compradora|Ana/, "sem transação, e-mail ou nome em claro");
});

test("P2 fora de ordem: reembolso antes da aprovação => refunded; aprovação tardia não reativa", { skip: SKIP }, async () => {
  await postback("PURCHASE_REFUNDED", "HP1601P2");
  assert.equal((await purchaseRow("HP1601P2")).status, "refunded");
  await postback("PURCHASE_APPROVED", "HP1601P2");
  const r = await purchaseRow("HP1601P2");
  assert.equal(r.status, "refunded"); assert.equal(r.revoked, "t"); assert.ok(r.approved_ms, "approved_at preenchido, estado continua terminal");
  for (const ev of ["PURCHASE_CHARGEBACK", "PURCHASE_CANCELED"]) { const t = "HP1601P2" + ev.slice(9); await postback("PURCHASE_APPROVED", t); await postback(ev, t); await postback("PURCHASE_COMPLETE", t); assert.equal((await purchaseRow(t)).status, ev === "PURCHASE_CHARGEBACK" ? "chargeback" : "canceled", ev); }
});

test("P3 PURCHASE_PROTEST (reembolso solicitado) não revoga: marca e mantém approved", { skip: SKIP }, async () => {
  await postback("PURCHASE_APPROVED", "HP1601P3"); await postback("PURCHASE_PROTEST", "HP1601P3");
  const r = await purchaseRow("HP1601P3");
  assert.equal(r.status, "approved"); assert.equal(r.protest, "t"); assert.equal(r.revoked, "f");
  await postback("PURCHASE_PROTEST", "HP1601P3B");
  assert.equal((await purchaseRow("HP1601P3B")).status, "unknown", "PROTEST antes da aprovação não cria compra ativa");
});

test("P4 hottok errado => 401 e nada gravado; produto que não é kit não grava estado de kit", { skip: SKIP }, async () => {
  assert.equal((await postback("PURCHASE_APPROVED", "HP1601P4", { token: "errado-errado-errado" })).status, 401);
  assert.equal(await purchaseRow("HP1601P4"), undefined);
  assert.equal((await postback("PURCHASE_APPROVED", "HP1601P4X", { product: 999001 })).status, 200);
  assert.equal(await purchaseRow("HP1601P4X"), undefined);
});

// ---------------- C: contingência ----------------
test("C1 desligada por padrão: nenhum link é emitido e o pedido fica registrado", { skip: SKIP }, async () => {
  await postback("PURCHASE_APPROVED", "HP1601C1");
  const r = await admin("link", { transaction: "HP1601C1", email: "ana.compradora@example.com", ...WHO });
  assert.equal(r.status, 409); assert.equal(r.body.error, "contingency_closed"); assert.equal(r.mail.sent.length, 0);
  assert.equal(psql("select outcome from hotmart_kit_audit where kind='contingency_link' order by id desc limit 1"), "denied:contingency_closed");
  assert.equal((await admin("estado", { enabled: true, hours: 73, ...WHO })).status, 400);
  assert.equal((await admin("estado", { enabled: true, hours: 4, operator: "x", reason: "curto" })).status, 400);
});

test("C2 identificação, estado e destinatário: transação sem registro 404; reembolsada 410; e-mail que não é o do comprador 403", { skip: SKIP }, async () => {
  assert.equal((await turnOn()).status, 200);
  assert.equal((await admin("link", { transaction: "HP1601NAOEXISTE", email: "a@b.co", ...WHO })).status, 404);
  assert.equal((await admin("link", { transaction: "HP1601P2", email: "ana.compradora@example.com", ...WHO })).status, 410);
  const r = await admin("link", { transaction: "HP1601C1", email: "outra.pessoa@example.com", ...WHO });
  assert.equal(r.status, 403); assert.equal(r.body.error, "recipient_not_buyer"); assert.equal(r.mail.sent.length, 0);
});

test("C3 link emitido: só ao e-mail do comprador, sem token na resposta, no banco (só hash) ou no registro", { skip: SKIP }, async () => {
  const r = await admin("link", { transaction: "hp1601c1", email: " Ana.Compradora@Example.com ", ...WHO }, { now: T0 + 2 * H });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.mail.sent.length, 1); assert.deepEqual(r.mail.sent[0].to, ["ana.compradora@example.com"]);
  const token = tokenOf(r.mail);
  assert.ok(token);
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(token));
  assert.equal(r.body.files, 2); assert.equal(r.body.day8_released, false);
  assert.equal(r.body.day8_release_at, new Date(T0 + 192 * H).toISOString());
  assert.match(r.mail.sent[0].text, /05\/11\/2026 às 10:00 \(horário de Brasília\)/);
  const dump = psql("select coalesce(string_agg(row_to_json(a)::text, ' '), '') from hotmart_kit_audit a") + psql("select coalesce(string_agg(row_to_json(l)::text, ' '), '') from hotmart_kit_links l");
  assert.doesNotMatch(dump, new RegExp(token)); assert.doesNotMatch(dump, /ana\.compradora|HP1601C1/i);
  assert.match(dump, new RegExp(createHash("sha256").update(token).digest("hex")), "só o hash do token");
  assert.match(psql("select actor || '|' || reason || '|' || outcome from hotmart_kit_audit where kind='contingency_link' order by id desc limit 1"), /^renan-dono\|Hotmart Club fora do ar.*\|issued:dia1$/);
  const exp = Number(psql(`select (extract(epoch from expires_at)*1000)::bigint from hotmart_kit_links order by created_at desc limit 1`));
  assert.ok(exp - Date.now() <= 121 * 60_000 && exp - Date.now() > 100 * 60_000, "curto: 120 min por padrão");
  C3.token = token;
});
const C3 = {};

test("C4 fronteira do dia 8 (aprovação 10:00 BRT de 28/10): 05/11 09:59:59.999 BRT nega PDF/ZIP; 10:00:00.000 libera; depois libera", { skip: SKIP }, async () => {
  const t = C3.token, rel = day8ReleaseAt(T0);
  assert.equal(new Date(rel).toISOString(), "2026-11-05T13:00:00.000Z");
  const before = await viewPage(t, rel - 1);
  assert.equal(before.status, 200);
  assert.match(before.html, /Planilha\.xlsx/); assert.match(before.html, /Modelo\.docx/);
  assert.doesNotMatch(before.html, /Manual\.pdf|Pacote\.zip/);
  assert.match(before.html, /a partir de 05\/11\/2026 às 10:00/);
  assert.equal((await download(t, "d8p", rel - 1)).status, 403);
  assert.equal((await download(t, "d8z", rel - 1)).status, 403);
  assert.equal((await download(t, "d8p", T0 + 168 * H)).status, 403, "7 dias (168 h) ainda não");
  const d1 = await download(t, "d1x", rel - 1);
  assert.equal(d1.status, 200); assert.equal(d1.text, "conteudo d1x");
  const at = await download(t, "d8p", rel);
  assert.equal(at.status, 200); assert.equal(at.text, "conteudo d8p");
  assert.equal((await download(t, "d8z", rel + 60_000)).status, 200);
  assert.match((await viewPage(t, rel)).html, /Manual\.pdf[\s\S]*Pacote\.zip|Pacote\.zip[\s\S]*Manual\.pdf/);
  assert.equal(psql("select count(*) from hotmart_kit_audit where kind='contingency_download' and outcome='denied:file_not_authorized'"), "3");
});

test("C5 reembolso, chargeback ou cancelamento depois do link: página e download bloqueados na hora; links marcados revogados", { skip: SKIP }, async () => {
  for (const ev of ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_CANCELED"]) {
    const txn = "HP1601C5" + ev.slice(9, 12);
    await postback("PURCHASE_APPROVED", txn);
    const r = await admin("link", { transaction: txn, email: "ana.compradora@example.com", ...WHO });
    assert.equal(r.status, 201, ev);
    const t = tokenOf(r.mail);
    assert.equal((await download(t, "d1x", T0 + 3 * H)).status, 200, ev + " antes");
    await postback(ev, txn);
    assert.equal((await viewPage(t, T0 + 3 * H)).status, 410, ev);
    assert.equal((await download(t, "d1x", T0 + 3 * H)).status, 410, ev);
    assert.equal(psql(`select bool_and(revoked_at is not null)::text from hotmart_kit_links where transaction_ref=${lit(await ref(SECRET, "transaction", txn))}`), "true", ev);
    assert.equal((await admin("link", { transaction: txn, email: "ana.compradora@example.com", ...WHO })).status, 410, ev + ": novo link recusado");
  }
  // O download revalida o estado da compra mesmo que a revogação dos links não tenha sido gravada (defesa em profundidade).
  await postback("PURCHASE_APPROVED", "HP1601C5DB");
  const t = tokenOf((await admin("link", { transaction: "HP1601C5DB", email: "ana.compradora@example.com", ...WHO })).mail);
  assert.equal((await download(t, "d1x", T0 + 3 * H)).status, 200);
  psql(`update hotmart_kit_purchases set status='refunded' where transaction_ref=${lit(await ref(SECRET, "transaction", "HP1601C5DB"))}`);
  assert.equal((await download(t, "d1x", T0 + 3 * H)).status, 410, "estado reembolsado sem revogação gravada");
  assert.equal((await viewPage(t, T0 + 3 * H)).status, 410);
});

test("C6 revogação pelo operador, contingência desligada e validade vencida bloqueiam o link", { skip: SKIP }, async () => {
  await postback("PURCHASE_APPROVED", "HP1601C6");
  const issue = async () => tokenOf((await admin("link", { transaction: "HP1601C6", email: "ana.compradora@example.com", ...WHO })).mail);
  const a = await issue();
  assert.equal((await admin("revogar", { transaction: "HP1601C6", ...WHO })).body.revoked, 1);
  assert.equal((await download(a, "d1x", T0 + H)).status, 410, "revogado pelo operador");
  const b = await issue();
  assert.equal((await download(b, "d1x", T0 + H)).status, 200);
  assert.equal((await admin("estado", { enabled: false, ...WHO })).status, 200);
  assert.equal((await download(b, "d1x", T0 + H)).status, 410, "contingência desligada");
  assert.equal((await viewPage(b, T0 + H)).status, 410);
  await turnOn();
  const c = await issue();
  psql(`update hotmart_kit_links set expires_at = now() - interval '1 second' where token_sha256=${lit(createHash("sha256").update(c).digest("hex"))}`);
  assert.equal((await download(c, "d1x", T0 + H)).status, 410, "vencido");
  psql(`update hotmart_kit_contingency set until = now() - interval '1 second'`);
  assert.equal((await admin("link", { transaction: "HP1601C6", email: "ana.compradora@example.com", ...WHO })).status, 409, "janela de 72 h expirada = desligada");
  await turnOn();
});

test("C7 leitura do estado falha (banco caiu entre as etapas) => nenhum link, nenhum e-mail; e-mail falha => link revogado", { skip: SKIP }, async () => {
  let n = 0;
  const flaky = () => ({ query: async (text, p) => { if (/kits:purchase/.test(text)) { n++; throw new Error("connection reset"); } return pgQuery(text, p); } });
  const r = await admin("link", { transaction: "HP1601C6", email: "ana.compradora@example.com", ...WHO }, { sql: flaky });
  assert.equal(r.status, 503); assert.equal(r.body.error, "purchase_state_unavailable"); assert.equal(r.mail.sent.length, 0); assert.equal(n, 1);
  const before = Number(psql("select count(*) from hotmart_kit_links where revoked_at is null"));
  const f = await admin("link", { transaction: "HP1601C6", email: "ana.compradora@example.com", ...WHO }, { mail: mailbox({ fail: true }) });
  assert.equal(f.status, 502);
  assert.equal(Number(psql("select count(*) from hotmart_kit_links where revoked_at is null")), before, "link do e-mail que falhou ficou revogado");
});

test("C8 teto de usos por link e link de outra compra não serve (isolamento entre compradores)", { skip: SKIP }, async () => {
  await postback("PURCHASE_APPROVED", "HP1601C8", { email: "bia@example.com" });
  const t = tokenOf((await admin("link", { transaction: "HP1601C8", email: "bia@example.com", ...WHO })).mail);
  psql(`update hotmart_kit_links set uses = max_uses where token_sha256=${lit(createHash("sha256").update(t).digest("hex"))}`);
  assert.equal((await download(t, "d1x", T0 + H)).status, 410);
  assert.equal((await admin("link", { transaction: "HP1601C8", email: "ana.compradora@example.com", ...WHO })).status, 403, "e-mail de outra compradora");
});

test("C9 PROTEST não bloqueia o link (só sinaliza ao operador; Q3 do Sol)", { skip: SKIP }, async () => {
  const r = await admin("link", { transaction: "HP1601P3", email: "ana.compradora@example.com", ...WHO });
  assert.equal(r.status, 201); assert.equal(r.body.refund_requested, true);
  assert.match(psql("select outcome from hotmart_kit_audit where kind='contingency_link' order by id desc limit 1"), /:refund_requested$/);
});
