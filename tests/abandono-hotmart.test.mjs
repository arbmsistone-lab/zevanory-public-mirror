// Lembrete único de compra não concluída na Hotmart (worker/abandono-hotmart.mjs; plano de abandono, Revisão 5b,
// seção 5.1, casos AB1–AB11) + regressão do /api/webhooks/hotmart atual + condições do GPT-6:
//  (a) reconciliação Resend paginada: percorre as páginas, filtra, confirma cada candidato por ID; resultado ambíguo
//      ou consulta incompleta nunca vira "enviado" (AB4.13–AB4.15, AB4.18–AB4.20);
//  (b) compra concorrente: compra registrada antes da reserva definitiva impede o envio; a gravação impeditiva e a
//      reserva não dependem de leitura em réplica atrasada; sem sessões/read replicas (AB5.1, AB5.3b, AB5.9).
// Só fakes locais: D1 com SQL real (node:sqlite + migrações reais), KV em memória, Resend falso, SELF falso. Sem rede.
// Sem literal de preço: os preços vêm de productBySlug (data/products.json).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { createAbandonoD1, memKv, fakeResend, captureConsole, MIGRATION_0003 } from "./helpers/abandono-fakes.mjs";
import { patchedTree, stagePatch, KIT_INGEST_PATCH } from "./helpers/abandono-tree.mjs";
import * as AB from "../worker/abandono-hotmart.mjs";
import { routeHotmartNc011 } from "../worker/cp-nc011-routing.mjs";
import { handleDigitalHotmartNc012 } from "../worker/cp-nc012-digital-hotmart.mjs";
import { handleCpDoWebhookCandidate } from "../worker/cp-g03-g04-candidate.mjs";
import { resetSalesSwitchCache, resetHotmartSwitchCache } from "../worker/sales-control.mjs";
import { productBySlug } from "../worker/product-prices.mjs";
import { hotmartLockViolations } from "../worker/sales-lock-content.mjs";
import { refreshSalesSummary, SALES_SUMMARY_KEY } from "../worker/sales-ledger.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000, H = 3600_000, D = 86400_000;
// Valores sintéticos gerados em runtime, de baixa entropia (não parecem credenciais para o scanner de segredos).
const HOTTOK = "test-hottok-" + "h".repeat(12);
const SECRET = "test-privacy-" + "p".repeat(36);
const EMAIL = "comprador.teste@example.com";
const KITS = { "8704733": "ia-na-pratica", "8704826": "vendas-na-pratica", "8704851": "lucro-e-caixa", "8704861": "combo-ia-vendas", "8704871": "negocio-completo" };
const SLUGS = Object.values(KITS);
const URL_WEBHOOK = "https://zevanory.api.br/api/webhooks/hotmart";

// Toda linha de console do arquivo fica aqui; AB8.1 (último teste) varre tudo.
const CAPTURED = captureConsole();
const SECRETS_SEEN = new Set([HOTTOK, SECRET]);

const fresh = () => { resetSalesSwitchCache(); resetHotmartSwitchCache(); };
const ownerRecord = (extra = {}) => JSON.stringify({ enabled: true, authorization: "LIBERAR VENDAS", by: "owner-test", at: new Date(Date.now() - MIN).toISOString(), ref: "teste/abandono-hotmart", channel: "hotmart", ...extra });
function makeEnv({ d1 = createAbandonoD1(), kv = memKv(), open = true, extra = {} } = {}) {
  if (open) kv.m.set("sales:hotmart:v1", ownerRecord());
  return { HOTMART_HOTTOK: HOTTOK, LEAD_PRIVACY_SECRET: SECRET, RESEND_API_KEY: "test-resend-" + "r".repeat(4), ZEVANORY_PRIVATE_ARTIFACTS: kv, DIARIO: d1, ...extra };
}
const abandon = ({ product = 8704733, email = EMAIL, iso = "BR", version = "2.0.0", event = "PURCHASE_OUT_OF_SHOPPING_CART", offer = "g9knd34r", country = true } = {}) => ({
  id: "evt-" + Math.random().toString(36).slice(2), creation_date: T0, event, version,
  data: { affiliate: false, product: { id: product, name: "Produto" }, buyer_ip: "203.0.113.9",
    buyer: email == null ? { name: "Fulano Sintetico", phone: "+55 11 90000-0000" } : { name: "Fulano Sintetico", email, phone: "+55 11 90000-0000" },
    ...(offer ? { offer: { code: offer } } : {}), ...(country ? { checkout_country: { name: "Pais", iso } } : {}) },
});
const purchase = (event = "PURCHASE_APPROVED", { product = 8704733, email = EMAIL, txn = "HP-SINT-" + Math.random().toString(36).slice(2, 10) } = {}) => ({
  id: "evt-" + txn, event, version: "2.0.0",
  data: { product: { id: product, name: "Produto" }, buyer: { email, name: "Fulano Sintetico" },
    purchase: { transaction: txn, price: { value: 1 }, approved_date: T0, origin: { src: "teste" }, payment: { type: "PIX" } } },
});
const req = (payload, { hottok = HOTTOK, method = "POST", raw } = {}) => new Request(URL_WEBHOOK, {
  method, headers: hottok == null ? { "content-type": "application/json" } : { "x-hotmart-hottok": hottok, "content-type": "application/json" },
  body: method === "GET" ? undefined : raw ?? JSON.stringify(payload),
});
async function ingest(env, payload, opts = {}, mod = AB) {
  fresh();
  const r = await mod.handleHotmartAbandonment(req(payload, opts.req), env, { now: T0, stage: "ativo", ...opts });
  return { status: r.status, body: await r.json() };
}
async function drain(env, resend, opts = {}, mod = AB) {
  fresh();
  return mod.runAbandonmentDue(env, { now: T0 + 61 * MIN, stage: "ativo", fetchImpl: resend.fetchImpl, ...opts });
}
// Exceção vira valor: com d1() fail-closed nenhuma destas chamadas lança; se lançar, a asserção seguinte falha com marcador.
const safe = (p) => Promise.resolve(p).catch((e) => ({ threw: String(e?.message || e).slice(0, 40), status: "lançou", body: {} }));
const refOf = (email = EMAIL) => AB.abandonoRef({ LEAD_PRIVACY_SECRET: SECRET }, email);
const pendOf = async (env, email = EMAIL) => env.ZEVANORY_PRIVATE_ARTIFACTS.m.get(AB.PEND_PREFIX + (await refOf(email))) ?? null;
const envio = (d1) => d1.rows("abandono_envio_v1");
const abandonoKeys = (kv) => [...kv.m.keys()].filter((k) => k.startsWith("abandono:"));
const d1Touched = (d1) => d1.stats.reads + d1.stats.writes;
// Só as instruções do abandono (o diário P20 em sombra também usa o binding, de forma assíncrona).
const abandonoSql = (d1) => d1.stats.statements.filter((q) => /abandono_/.test(q)).length + d1.stats.sessions;
function shapeLines() { return CAPTURED.lines.filter((l) => l.startsWith("abandono_shape ")); }
async function seedRow(d1, { ref, estado = "reservado", criado = T0, lease = criado, tentativas = 1, sha = "x".repeat(64), dia = new Date(criado).toISOString().slice(0, 10), slug = "ia-na-pratica" }) {
  d1.sql("INSERT INTO abandono_envio_v1 (ref,slug,dia,estado,criado_ms,lease_ms,tentativas,body_sha) VALUES (?,?,?,?,?,?,?,?)", ref, slug, dia, estado, criado, lease, tentativas, sha);
}
async function seedPend(env, { email = EMAIL, slug = "ia-na-pratica", received = T0, due = T0 + H } = {}) {
  const ref = await refOf(email);
  env.ZEVANORY_PRIVATE_ARTIFACTS.m.set(AB.PEND_PREFIX + ref, JSON.stringify({ email, product_id: "8704733", slug, received_at: received, due_at: due }));
  return ref;
}

// Árvores com o estágio trocado no FONTE (o repositório não muda); carregadas sob demanda.
const trees = {};
async function tree(name) {
  if (trees[name]) return trees[name];
  const patches = name === "kit" ? [stagePatch("aquecimento"), KIT_INGEST_PATCH] : [stagePatch(name)];
  const t = patchedTree(patches);
  const [ab, route, sales] = await Promise.all([t.load("worker/abandono-hotmart.mjs"), t.load("worker/cp-nc011-routing.mjs"), t.load("worker/sales-control.mjs")]);
  trees[name] = { t, ab, route, fresh: () => { sales.resetSalesSwitchCache(); sales.resetHotmartSwitchCache(); } };
  return trees[name];
}
test.after(() => { for (const v of Object.values(trees)) v.t.cleanup(); });
async function viaRoute(tr, env, payload) {
  tr.fresh();
  const r = await tr.route.routeHotmartNc011(req(payload), env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ------------------------------------------------------------------------------------------------- AB1 hottok/sonda
test("AB1.1 hottok ausente: 401, nada gravado, sonda não emitida", async () => {
  const env = makeEnv(); const before = shapeLines().length;
  const r = await ingest(env, abandon(), { req: { hottok: null } });
  assert.equal(r.status, 401, "[AB1.1/a] status 401");
  assert.equal(env.ZEVANORY_PRIVATE_ARTIFACTS.writes() + d1Touched(env.DIARIO), 0, "[AB1.1/b] sem gravação nem leitura de D1");
  assert.equal(shapeLines().length, before, "[AB1.1/c] sonda só depois do hottok");
});
test("AB1.2 hottok errado do mesmo tamanho: 401", async () => {
  const env = makeEnv();
  const wrong = HOTTOK.slice(0, -1) + (HOTTOK.endsWith("9") ? "8" : "9");
  const r = await ingest(env, abandon(), { req: { hottok: wrong } });
  assert.equal(r.status, 401, "[AB1.2] mesmo tamanho, valor diferente");
  assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length, 0, "[AB1.2/b] sem pendência");
});
test("AB1.3 hottok de outro tamanho, prefixo ou com sufixo: 401", async () => {
  for (const h of [HOTTOK.slice(0, -3), HOTTOK + "xyz", "x", HOTTOK.toUpperCase()]) {
    const env = makeEnv();
    assert.equal((await ingest(env, abandon(), { req: { hottok: h } })).status, 401, "[AB1.3] " + h.length);
  }
});
test("AB1.4 segredo não configurado (vazio ou < 16): 503, nada gravado", async () => {
  for (const s of ["", "curto-15-chars!", "   "]) {
    const env = makeEnv({ extra: { HOTMART_HOTTOK: s } });
    const r = await ingest(env, abandon(), { req: { hottok: s || "qualquer" } });
    assert.equal(r.status, 503, "[AB1.4] 503 sem segredo");
    assert.equal(env.ZEVANORY_PRIVATE_ARTIFACTS.writes(), 0, "[AB1.4/b] nada gravado");
  }
});
test("AB1.5 hottok só em CHANNEL_CREDENTIALS_JSON: aceito", async () => {
  const env = makeEnv({ extra: { HOTMART_HOTTOK: undefined, CHANNEL_CREDENTIALS_JSON: JSON.stringify({ HOTMART_HOTTOK: HOTTOK }) } });
  assert.equal((await ingest(env, abandon())).status, 202, "[AB1.5]");
});
test("AB1.6 sonda com version 1.0.0: 6 booleanos antes do 422, sem gravação", async () => {
  const env = makeEnv(); const before = shapeLines().length;
  const r = await ingest(env, abandon({ version: "1.0.0" }));
  assert.equal(r.status, 422, "[AB1.6/a] 422");
  const lines = shapeLines().slice(before);
  assert.equal(lines.length, 1, "[AB1.6] uma linha de sonda antes do 422");
  const shape = JSON.parse(lines[0].slice("abandono_shape ".length));
  assert.deepEqual(Object.keys(shape).sort(), ["event_ok", "has_country_iso", "has_email", "has_offer", "product_allowed", "version_ok"], "[AB1.6/b] 6 chaves");
  assert.ok(Object.values(shape).every((v) => typeof v === "boolean"), "[AB1.6/c] só booleanos");
  assert.equal(shape.version_ok, false, "[AB1.6/d]");
  assert.equal(env.ZEVANORY_PRIVATE_ARTIFACTS.writes() + d1Touched(env.DIARIO), 0, "[AB1.6/e] nada gravado");
});
test("AB1.7 sonda com payload completo: tudo true, sem e-mail nem ID", async () => {
  const env = makeEnv(); const before = shapeLines().length;
  await ingest(env, abandon());
  const line = shapeLines().slice(before)[0];
  assert.deepEqual(JSON.parse(line.slice("abandono_shape ".length)), { version_ok: true, event_ok: true, has_country_iso: true, has_email: true, has_offer: true, product_allowed: true }, "[AB1.7]");
  assert.ok(!/@|8704733|g9knd34r|BR/.test(line), "[AB1.7/b] sonda sem valores");
  const partial = shapeLines().length;
  await ingest(makeEnv(), abandon({ email: null, offer: null, country: false, product: 12345 }));
  assert.deepEqual(JSON.parse(shapeLines()[partial].slice(15)), { version_ok: true, event_ok: true, has_country_iso: false, has_email: false, has_offer: false, product_allowed: false }, "[AB1.7/c] campos ausentes");
});

// ------------------------------------------------------------------------------------------------- AB2 produtos
test("AB2.1 produtos fora dos 5 kits (CP, Gestão, desconhecido): 200 product_not_allowed", async () => {
  for (const id of [8704905, 8709787, 12345]) {
    const env = makeEnv();
    const r = await ingest(env, abandon({ product: id }));
    assert.deepEqual([r.status, r.body.code], [200, "product_not_allowed"], "[AB2.1] " + id);
    assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length + d1Touched(env.DIARIO), 0, "[AB2.1/b] sem gravação");
  }
});
test("AB2.2 cada um dos 5 kits abertos: 202 queued com o slug do kit", async () => {
  assert.deepEqual(AB.KIT_BY_PRODUCT_ID, KITS, "[AB2.2/a] mapa ID -> slug da lista P18");
  for (const [id, slug] of Object.entries(KITS)) {
    const env = makeEnv();
    const r = await ingest(env, abandon({ product: Number(id) }));
    assert.deepEqual([r.status, r.body.code], [202, "queued"], "[AB2.2] " + id);
    assert.equal(JSON.parse(await pendOf(env)).slug, slug, "[AB2.2/b] slug");
  }
});

// ------------------------------------------------------------------------------------------------- AB3 vendas
test("AB3.1 sales:hotmart:v1 fechado/ausente/JSON ruim/get lança: 200 sales_closed", async () => {
  const cases = [
    (kv) => kv.m.set("sales:hotmart:v1", ownerRecord({ enabled: false })),
    () => {},
    (kv) => kv.m.set("sales:hotmart:v1", "{"),
    (kv) => { kv.m.set("sales:hotmart:v1", ownerRecord()); kv.mode.failGet = true; },
  ];
  for (const [i, setup] of cases.entries()) {
    const kv = memKv(); setup(kv);
    const env = makeEnv({ kv, open: false });
    const r = await ingest(env, abandon());
    assert.deepEqual([r.status, r.body.code], [200, "sales_closed"], "[AB3.1] caso " + i);
    assert.equal(kv.stats.puts + d1Touched(env.DIARIO), 0, "[AB3.1/b] sem gravação");
  }
});
test("AB3.2 aberto na ingestão, fechado no envio: nada enviado, pendência apagada", async () => {
  const env = makeEnv(); const rs = fakeResend();
  assert.equal((await ingest(env, abandon())).status, 202, "[AB3.2/z] enfileira");
  env.ZEVANORY_PRIVATE_ARTIFACTS.m.delete("sales:hotmart:v1");
  await drain(env, rs);
  assert.equal(rs.posts.length, 0, "[AB3.2] sem POST com vendas fechadas");
  assert.equal(await pendOf(env), null, "[AB3.2/b] pendência apagada");
});

// ------------------------------------------------------------------------------------------------- AB4 envio
test("AB4.1 mesmo e-mail e produto, 2 eventos: 1 pendência, 1 envio", async () => {
  const env = makeEnv(); const rs = fakeResend();
  assert.equal((await ingest(env, abandon())).body.code, "queued", "[AB4.1/z] enfileira");
  assert.equal((await ingest(env, abandon())).body.code, "dedupe", "[AB4.1/a] segunda é dedupe");
  await drain(env, rs);
  assert.equal(rs.posts.length, 1, "[AB4.1] um POST");
  assert.equal(rs.delivered.length, 1, "[AB4.1/b] um e-mail");
});
test("AB4.2 mesmo e-mail, outro kit, dentro de 30 dias depois do envio: não enfileira", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  await drain(env, rs);
  const r = await ingest(env, abandon({ product: 8704851 }), { now: T0 + 10 * D });
  assert.equal(r.body.code, "dedupe", "[AB4.2] dedupe global, não por produto");
  assert.equal(await pendOf(env), null, "[AB4.2/b] sem pendência");
});
test("AB4.3 e-mail com caixa ou espaços diferentes: mesmo ref", async () => {
  assert.equal(await refOf("  Comprador.TESTE@Example.COM "), await refOf(EMAIL), "[AB4.3] normalização");
  const env = makeEnv();
  await ingest(env, abandon({ email: " Comprador.Teste@EXAMPLE.com" }));
  assert.equal((await ingest(env, abandon({ email: EMAIL }))).body.code, "dedupe", "[AB4.3/b] mesmo titular");
});
test("AB4.4 concorrência real: 2 drenos em paralelo no mesmo D1, depois um 3º", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  const outs = await Promise.all([drain(env, rs), drain(env, rs)]);
  assert.equal(rs.posts.length, 1, "[AB4.4] exatamente 1 POST");
  assert.equal(outs[0].sent + outs[1].sent, 1, "[AB4.4/b] uma dona do envio");
  assert.deepEqual(envio(env.DIARIO).map((r) => r.estado), ["enviado"], "[AB4.4/c] 1 linha enviado");
  await drain(env, rs, { now: T0 + 3 * H });
  assert.equal(rs.posts.length, 1, "[AB4.4/d] 3ª execução sem POST");
});
test("AB4.5 Resend 500: linha reservado, pendência mantida; retomada com mesma chave e mesmo corpo", async () => {
  const env = makeEnv(); const rs = fakeResend({ script: [{ status: 500 }] });
  await ingest(env, abandon());
  await drain(env, rs);
  const row = envio(env.DIARIO)[0];
  assert.equal(row.estado, "reservado", "[AB4.5/a] continua reservado");
  assert.equal(row.resend_id, null, "[AB4.5/b] sem resend_id");
  assert.notEqual(await pendOf(env), null, "[AB4.5/c] pendência mantida");
  await drain(env, rs, { now: T0 + 61 * MIN + 10 * MIN });
  assert.equal(rs.posts.length, 1, "[AB4.5/d] lease vigente: sem novo POST");
  await drain(env, rs, { now: T0 + 61 * MIN + 31 * MIN });
  assert.equal(rs.posts.length, 2, "[AB4.5/e] retomada após o lease");
  assert.equal(rs.posts[1].key, rs.posts[0].key, "[AB4.5] mesma Idempotency-Key");
  assert.deepEqual(rs.posts[1].body, rs.posts[0].body, "[AB4.5/f] mesmo corpo");
  assert.equal(envio(env.DIARIO)[0].estado, "enviado", "[AB4.5/g] enviado");
});
test("AB4.6 Resend 429: linha reservada e a execução para", async () => {
  const env = makeEnv(); const rs = fakeResend({ script: [{ status: 429, name: "rate_limit_exceeded" }] });
  await ingest(env, abandon());
  await ingest(env, abandon({ email: "outra.pessoa@example.com" }));
  const out = await drain(env, rs);
  assert.equal(rs.posts.length, 1, "[AB4.6] nenhuma chamada depois do 429");
  assert.equal(out.retry, 1, "[AB4.6/b]");
  assert.equal(envio(env.DIARIO).filter((r) => r.estado === "reservado").length, 1, "[AB4.6/c] reservado");
  assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length, 2, "[AB4.6/d] pendências mantidas");
});
test("AB4.7 timeout e depois 200 com o id original: enviado, 1 único e-mail", async () => {
  const env = makeEnv(); const rs = fakeResend({ script: ["accept_then_timeout"] });
  await ingest(env, abandon());
  await drain(env, rs);
  assert.equal(envio(env.DIARIO)[0].estado, "reservado", "[AB4.7/a] reservado após timeout");
  await drain(env, rs, { now: T0 + 2 * H });
  const row = envio(env.DIARIO)[0];
  assert.equal(row.estado, "enviado", "[AB4.7] enviado na retomada");
  assert.equal(row.resend_id, rs.delivered[0].id, "[AB4.7/b] id original");
  assert.equal(rs.delivered.length, 1, "[AB4.7/c] um único e-mail");
});
test("AB4.8 tentativas >= 3 ou reserva com mais de 23 h: nao_confirmado sem POST", async () => {
  for (const [label, seed] of [["tentativas", { tentativas: 3, criado: T0 - 2 * H, lease: T0 - 2 * H }], ["23h", { tentativas: 1, criado: T0 - 23 * H - MIN, lease: T0 - 2 * H }]]) {
    const env = makeEnv(); const rs = fakeResend();
    const ref = await seedPend(env, { received: T0 - 30 * MIN, due: T0 - MIN });
    await seedRow(env.DIARIO, { ref, ...seed });
    await drain(env, rs, { now: T0 });
    assert.equal(rs.posts.length, 0, "[AB4.8] sem POST: " + label);
    assert.equal(envio(env.DIARIO)[0].estado, "nao_confirmado", "[AB4.8/b] " + label);
    assert.equal(await pendOf(env), null, "[AB4.8/c] pendência apagada");
    assert.equal((await ingest(env, abandon(), { now: T0 + D })).body.code, "dedupe", "[AB4.8/d] bloqueia 30 dias");
  }
});
test("AB4.9 teto diário: 20 linhas de hoje, reserva barrada, pendência mantida, execução para", async () => {
  const env = makeEnv(); const rs = fakeResend();
  for (let i = 0; i < AB.ABANDONO_DAILY_CAP; i++) await seedRow(env.DIARIO, { ref: (i.toString(16).padStart(2, "0")).repeat(32), estado: "enviado", criado: T0 });
  await ingest(env, abandon());
  await ingest(env, abandon({ email: "outra.pessoa@example.com" }));
  const out = await drain(env, rs);
  assert.equal(rs.posts.length, 0, "[AB4.9] sem POST no teto");
  assert.equal(out.cap_left, 0, "[AB4.9/b] cap_left 0");
  assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length, 2, "[AB4.9/c] pendências mantidas para o dia seguinte");
  assert.equal(out.due, 1, "[AB4.9/d] a execução para no teto");
});
test("AB4.10 19 linhas + 5 pendências + 2 drenos concorrentes: exatamente 1 envio", async () => {
  const env = makeEnv(); const rs = fakeResend();
  for (let i = 0; i < AB.ABANDONO_DAILY_CAP - 1; i++) await seedRow(env.DIARIO, { ref: (i.toString(16).padStart(2, "0")).repeat(32), estado: "enviado", criado: T0 });
  for (let i = 0; i < 5; i++) await ingest(env, abandon({ email: `pessoa${i}@example.com` }));
  await Promise.all([drain(env, rs), drain(env, rs)]);
  assert.equal(rs.posts.length, 1, "[AB4.10] teto atômico");
  assert.equal(envio(env.DIARIO).length, AB.ABANDONO_DAILY_CAP, "[AB4.10/b] 20 linhas no dia");
});
for (const [id, name] of [["AB4.11", "invalid_idempotent_request"], ["AB4.12", "concurrent_idempotent_requests"]]) {
  test(`${id} 409 ${name}: reconciliar, nunca enviado sem confirmação, sem novo POST`, async () => {
    const env = makeEnv(); const rs = fakeResend({ script: [{ status: 409, name }] });
    await ingest(env, abandon());
    await drain(env, rs);
    let row = envio(env.DIARIO)[0];
    assert.equal(row.estado, "reconciliar", `[${id}] reconciliar`);
    assert.equal(row.resend_id, null, `[${id}/b] sem resend_id`);
    assert.notEqual(await pendOf(env), null, `[${id}/c] pendência mantida`);
    for (const dt of [2 * H, 3 * H]) await drain(env, rs, { now: T0 + dt });
    assert.equal(rs.posts.length, 1, `[${id}/d] nenhum novo POST`);
    row = envio(env.DIARIO)[0];
    assert.notEqual(row.estado, "enviado", `[${id}/e] nunca enviado sem confirmação`);
  });
}
test("AB4.13 reconciliação com sucesso (listagem + GET por id com a tag): enviado, 0 POST novo", async () => {
  const env = makeEnv(); const rs = fakeResend({ script: [{ deliver: true, status: 409, name: "invalid_idempotent_request" }] });
  await ingest(env, abandon());
  await drain(env, rs);
  assert.equal(envio(env.DIARIO)[0].estado, "reconciliar", "[AB4.13/z] reconciliar");
  await drain(env, rs, { now: T0 + 2 * H });
  const row = envio(env.DIARIO)[0];
  assert.equal(row.estado, "enviado", "[AB4.13] reconciliado");
  assert.equal(row.resend_id, rs.delivered[0].id, "[AB4.13/b] id confirmado");
  assert.equal(await pendOf(env), null, "[AB4.13/c] pendência apagada");
  assert.equal(rs.posts.length, 1, "[AB4.13/d] sem POST novo");
  assert.ok(rs.gets.some((g) => g === "/emails/" + rs.delivered[0].id), "[AB4.13/e] confirmação por id");
});
test("AB4.14 reconciliação: item sem tag, fora da janela ou outro to não confirma; outro assunto nem compara o to", async () => {
  const ref = await refOf();
  const subject = AB.abandonmentSubject(productBySlug("ia-na-pratica").name);
  const iso = (ms) => new Date(ms).toISOString();
  for (const [label, item] of [
    ["sem tag", { id: "fx-1", to: [EMAIL], subject, created_at: iso(T0 + 61 * MIN), tags: [] }],
    ["fora da janela", { id: "fx-2", to: [EMAIL], subject, created_at: iso(T0 + 61 * MIN + 30 * H), tags: [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }] }],
    ["outro to", { id: "fx-3", to: ["outra@example.com"], subject, created_at: iso(T0 + 61 * MIN), tags: [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }] }],
  ]) {
    const env = makeEnv(); const rs = fakeResend({ script: [{ status: 409, name: "invalid_idempotent_request" }], listing: { filler: [item] } });
    await ingest(env, abandon());
    await drain(env, rs);
    await drain(env, rs, { now: T0 + 2 * H });
    const row = envio(env.DIARIO)[0];
    assert.equal(row.estado, "reconciliar", "[AB4.14] não confirma: " + label);
    assert.equal(row.tentativas, 1, "[AB4.14/b] tentativas+1: " + label);
  }
  // 100 itens de outro assunto: o "to" nunca é lido (getter espião).
  let toReads = 0;
  const items = Array.from({ length: 100 }, (_, i) => { const o = { id: "ot-" + i, subject: "Outro assunto " + i, created_at: iso(T0 + 61 * MIN - i * 1000) }; Object.defineProperty(o, "to", { enumerable: true, get() { toReads++; return [EMAIL]; } }); return o; });
  const fetchImpl = async (url) => (String(url).includes("/emails?") ? { status: 200, json: async () => ({ object: "list", has_more: false, data: items }) } : { status: 404, json: async () => ({}) });
  const out = await AB.reconcileLookup({ RESEND_API_KEY: "x" }, fetchImpl, { ref, email: EMAIL, subject, criadoMs: T0 + 61 * MIN });
  assert.deepEqual(out, { not_found: true }, "[AB4.14/c] completo e sem candidato");
  assert.equal(toReads, 0, "[AB4.14/d] 0 comparações de to");
});
test("AB4.15 3 reconciliações sem achar, ou listagem 401/403/404: nao_confirmado sem POST, batimento agregado", async () => {
  for (const status of [200, 401, 403, 404]) {
    const env = makeEnv(); const rs = fakeResend({ script: [{ status: 409, name: "invalid_idempotent_request" }], listing: { status } });
    await ingest(env, abandon());
    await drain(env, rs);
    const outs = [];
    for (let i = 1; i <= AB.RECONCILE_MAX; i++) outs.push(await drain(env, rs, { now: T0 + 61 * MIN + i * 31 * MIN }));
    assert.equal(envio(env.DIARIO)[0].estado, "nao_confirmado", "[AB4.15] encerra: " + status);
    assert.equal(await pendOf(env), null, "[AB4.15/b] e-mail em claro apagado");
    assert.equal(rs.posts.length, 1, "[AB4.15/c] 0 POST novo");
    assert.equal(outs.at(-1).nao_confirmado, 1, "[AB4.15/d] contador agregado");
    assert.ok(outs.slice(0, -1).every((o) => o.nao_confirmado === 0), "[AB4.15/e] só depois de RECONCILE_MAX");
    const ref = await refOf();
    const beat = JSON.stringify(outs);
    assert.ok(!beat.includes(ref.slice(0, 16)) && !beat.includes("@") && !beat.includes("re-0"), "[AB4.15/f] batimento sem ref/e-mail/id");
  }
});
test("AB4.16 retomada com corpo recalculado diferente: 0 POST, vai para reconciliar", async () => {
  const env = makeEnv(); const rs = fakeResend({ script: [{ status: 500 }] });
  await ingest(env, abandon());
  await drain(env, rs);
  env.RESEND_FROM_ADDRESS = "ZEVANORY Outro <outro@zevanory.api.br>";
  await drain(env, rs, { now: T0 + 2 * H });
  assert.equal(rs.posts.length, 1, "[AB4.16] sem POST com corpo diferente");
  assert.equal(envio(env.DIARIO)[0].estado, "reconciliar", "[AB4.16/b] reconciliar");
});
test("AB4.17 idempotência da Central além de 24 h: linha enviado com 25 h e 29 dias bloqueia", async () => {
  for (const age of [25 * H, 29 * D]) {
    const env = makeEnv();
    await seedRow(env.DIARIO, { ref: await refOf(), estado: "enviado", criado: T0 - age });
    const r = await ingest(env, abandon());
    assert.equal(r.body.code, "dedupe", "[AB4.17] dedupe com " + age / H + " h");
    assert.equal(await pendOf(env), null, "[AB4.17/b] sem pendência");
  }
});
// Condição (a) do GPT-6: paginação, ambiguidade e consulta incompleta.
test("AB4.18 reconciliação paginada: o item confirmado está na 3ª página", async () => {
  const env = makeEnv();
  const iso = (ms) => new Date(ms).toISOString();
  const filler = Array.from({ length: 250 }, (_, i) => ({ id: "pg-" + String(i).padStart(3, "0"), to: ["x" + i + "@example.com"], subject: "Outro " + i, created_at: iso(T0 + 61 * MIN + 10 * H - i * 1000) }));
  const rs = fakeResend({ script: [{ deliver: true, status: 409, name: "invalid_idempotent_request" }], listing: { filler } });
  await ingest(env, abandon());
  await drain(env, rs);
  await drain(env, rs, { now: T0 + 2 * H });
  assert.equal(envio(env.DIARIO)[0].estado, "enviado", "[AB4.18] achado depois de percorrer as páginas");
  const lists = rs.gets.filter((g) => g.startsWith("/emails?"));
  assert.equal(lists.length, 3, "[AB4.18/b] 3 páginas lidas");
  assert.ok(lists[1].includes("after=") && lists[2].includes("after="), "[AB4.18/c] cursor after");
});
test("AB4.19 reconciliação ambígua (2 confirmações) nunca vira enviado", async () => {
  const ref = await refOf();
  const subject = AB.abandonmentSubject(productBySlug("ia-na-pratica").name);
  const tags = [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }];
  const iso = (ms) => new Date(ms).toISOString();
  const env = makeEnv();
  const rs = fakeResend({ script: [{ status: 409, name: "invalid_idempotent_request" }], listing: { filler: [
    { id: "am-1", to: [EMAIL], subject, created_at: iso(T0 + 62 * MIN), tags }, { id: "am-2", to: [EMAIL], subject, created_at: iso(T0 + 63 * MIN), tags }] } });
  await ingest(env, abandon());
  await drain(env, rs);
  for (let i = 1; i <= AB.RECONCILE_MAX; i++) await drain(env, rs, { now: T0 + 61 * MIN + i * 31 * MIN });
  const row = envio(env.DIARIO)[0];
  assert.equal(row.estado, "nao_confirmado", "[AB4.19] ambíguo encerra sem enviado");
  assert.equal(row.resend_id, null, "[AB4.19/b] sem resend_id");
  const direct = await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs.fetchImpl, { ref, email: EMAIL, subject, criadoMs: T0 + 61 * MIN });
  assert.deepEqual(direct, { ambiguous: 2 }, "[AB4.19/c] resultado ambíguo");
});
test("AB4.20 consulta incompleta nunca vira enviado: limite de páginas, has_more ausente, falha na confirmação", async () => {
  const ref = await refOf();
  const subject = AB.abandonmentSubject(productBySlug("ia-na-pratica").name);
  const iso = (ms) => new Date(ms).toISOString();
  const tags = [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }];
  const target = { id: "alvo-1", to: [EMAIL], subject, created_at: iso(T0 + 62 * MIN), tags };
  const many = Array.from({ length: 100 * AB.RECONCILE_MAX_PAGES + 5 }, (_, i) => ({ id: "mx-" + i, to: ["y@example.com"], subject: "Outro", created_at: iso(T0 + 20 * H - i * 10) }));
  const cases = [
    ["paginas", { listing: { filler: [...many, target] } }, { incomplete: "pages" }],
    ["has_more", { listing: { filler: [target], dropHasMore: true } }, { incomplete: "list" }],
    ["retrieve", { listing: { filler: [target] }, retrieveStatus: 500 }, { incomplete: "retrieve" }],
  ];
  for (const [label, cfg, expected] of cases) {
    const rs = fakeResend(cfg);
    const out = await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs.fetchImpl, { ref, email: EMAIL, subject, criadoMs: T0 + 61 * MIN });
    assert.deepEqual(out, expected, "[AB4.20] " + label);
    const env = makeEnv(); const rs2 = fakeResend({ ...cfg, script: [{ status: 409, name: "invalid_idempotent_request" }] });
    await ingest(env, abandon());
    await drain(env, rs2);
    for (let i = 1; i <= AB.RECONCILE_MAX; i++) await drain(env, rs2, { now: T0 + 61 * MIN + i * 31 * MIN });
    assert.equal(envio(env.DIARIO)[0].estado, "nao_confirmado", "[AB4.20/b] encerra sem enviado: " + label);
    assert.equal(rs2.posts.length, 1, "[AB4.20/c] sem reenvio: " + label);
  }
});

// ------------------------------------------------------------------------------------------------- AB5 compra
for (const [id, ev] of [["AB5.1", "PURCHASE_APPROVED"], ["AB5.2", "PURCHASE_COMPLETE"]]) {
  test(`${id} ${ev} entre a pendência e o envio: pendência apagada e a reserva atômica barra o envio`, async () => {
    const tr = await tree("ativo");
    const env = makeEnv(); const rs = fakeResend();
    await ingest(env, abandon(), {}, tr.ab);
    const pend = await pendOf(env);
    assert.notEqual(pend, null, `[${id}/z] pendência criada`);
    const r = await viaRoute(tr, env, purchase(ev));
    assert.equal(r.status, 200, `[${id}] compra responde 200`);
    assert.equal(await pendOf(env), null, `[${id}/a] compra apaga a pendência`);
    assert.equal(env.DIARIO.rows("abandono_compra_v1").length, 1, `[${id}/b] marcador de compra`);
    env.ZEVANORY_PRIVATE_ARTIFACTS.m.set(AB.PEND_PREFIX + (await refOf()), pend); // KV eventual: a pendência reaparece
    const out = await drain(env, rs, {}, tr.ab);
    assert.equal(rs.posts.length, 0, `[${id}/c] reserva atômica barra (segundo ponto)`);
    assert.equal(envio(env.DIARIO).length, 0, `[${id}/d] nenhuma reserva`);
    assert.equal(out.canceled, 1, `[${id}/e] cancelado`);
  });
}
test("AB5.3 compra antes do abandono (ordem inversa): ingestão responde buyer, sem pendência", async () => {
  const tr = await tree("ativo");
  const env = makeEnv();
  await viaRoute(tr, env, purchase("PURCHASE_APPROVED"));
  const r = await ingest(env, abandon(), {}, tr.ab);
  assert.equal(r.body.code, "buyer", "[AB5.3] primeiro ponto de consulta");
  assert.equal(await pendOf(env), null, "[AB5.3/b] sem pendência");
});
test("AB5.3b compra gravada depois da leitura da ingestão e antes do put: a reserva barra", async () => {
  const env = makeEnv(); const rs = fakeResend();
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS, ref = await refOf();
  const get = kv.get.bind(kv);
  kv.get = async (k) => { if (k === AB.PEND_PREFIX + ref) env.DIARIO.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", ref, T0); return get(k); };
  assert.equal((await ingest(env, abandon())).body.code, "queued", "[AB5.3b/z] a corrida deixa a pendência ser criada");
  kv.get = get;
  await drain(env, rs);
  assert.equal(rs.posts.length, 0, "[AB5.3b] reserva atômica barra o envio");
  assert.equal(envio(env.DIARIO).length, 0, "[AB5.3b/c] sem reserva");
});
test("AB5.3c marcador de compra com mais de 30 dias não bloqueia", async () => {
  const env = makeEnv(); const rs = fakeResend();
  env.DIARIO.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", await refOf(), T0 - 31 * D);
  assert.equal((await ingest(env, abandon())).body.code, "queued", "[AB5.3c] não bloqueia");
  await drain(env, rs);
  assert.equal(rs.posts.length, 1, "[AB5.3c/d] envia");
});
test("AB5.3d aquecimento: compra grava marcador; abandono sem pendência; dreno sem SELF; depois em ativo é barrado", async () => {
  const aq = await tree("aquecimento");
  const env = makeEnv();
  let selfCalls = 0;
  env.SELF = { fetch: async () => { selfCalls++; return new Response("{}"); } };
  await viaRoute(aq, env, purchase("PURCHASE_APPROVED"));
  assert.equal(env.DIARIO.rows("abandono_compra_v1").length, 1, "[AB5.3d] marcador gravado no aquecimento");
  const r = await viaRoute(aq, env, abandon());
  assert.deepEqual([r.status, r.body.code], [200, "aquecimento"], "[AB5.3d/e] abandono -> aquecimento");
  assert.equal(await pendOf(env), null, "[AB5.3d/f] sem pendência");
  assert.deepEqual(await aq.ab.dispatchAbandonmentDrain(env, { nowMs: T0 }), { skipped: "disabled" }, "[AB5.3d/g] dreno pulado");
  assert.equal(selfCalls, 0, "[AB5.3d/h] SELF não chamado");
  const at = await tree("ativo");
  const later = await viaRoute(at, env, abandon());
  assert.equal(later.body.code, "buyer", "[AB5.3d/i] em ativo, barrado na ingestão");
});
test("AB5.3e gancho aguardado: a resposta da compra só volta depois do INSERT do marcador", async () => {
  const tr = await tree("ativo");
  const env = makeEnv(); const order = [];
  env.DIARIO.mode.delayOn = { re: /INSERT INTO abandono_compra_v1/, ms: 30 };
  env.DIARIO.mode.onWrite = (sql) => { if (/abandono_compra_v1/.test(sql)) order.push("insert"); };
  await viaRoute(tr, env, purchase("PURCHASE_APPROVED")).then(() => order.push("resposta"));
  assert.deepEqual(order, ["insert", "resposta"], "[AB5.3e] INSERT antes da resposta");
});
test("AB5.4 noteHotmartPurchase lança: resposta da compra inalterada", async () => {
  const tr = await tree("ativo");
  const base = await viaRoute(tr, makeEnv(), purchase("PURCHASE_APPROVED", { txn: "HP-SINT-BASE01" }));
  const env = makeEnv();
  Object.defineProperty(env, "LEAD_PRIVACY_SECRET", { get() { throw new Error("falha simulada"); } });
  const r = await viaRoute(tr, env, purchase("PURCHASE_APPROVED", { txn: "HP-SINT-BASE01" }));
  assert.deepEqual(r, base, "[AB5.4] mesma resposta");
});
test("AB5.5 PURCHASE_BILLET_PRINTED: nc012 200, receita e entrega inalteradas, marcador gravado, pendência apagada", async () => {
  const tr = await tree("ativo");
  const env = makeEnv();
  await ingest(env, abandon(), {}, tr.ab);
  const r = await viaRoute(tr, env, purchase("PURCHASE_BILLET_PRINTED", { txn: "HP-SINT-BOLETO1" }));
  assert.equal(r.status, 200, "[AB5.5/a] 200");
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  await refreshSalesSummary(kv, { now: T0 });
  const s = JSON.parse(kv.m.get(SALES_SUMMARY_KEY));
  assert.deepEqual([s.totals.approved, s.totals.grossCents, s.totals.netCents, s.totals.refunded], [0, 0, 0, 0], "[AB5.5/b] receita inalterada");
  assert.equal(s.totals.billet_printed, 1, "[AB5.5/c] contador não financeiro");
  assert.ok(![...kv.m.keys(), ...kv.m.values()].some((v) => /delivery_sent|refund_requested/.test(String(v))), "[AB5.5/d] sem entrega");
  assert.equal(env.DIARIO.rows("diario_v1").length, 0, "[AB5.5/e] sem diário de entrega");
  assert.equal(await pendOf(env), null, "[AB5.5] pendência apagada pelo boleto");
  assert.equal(env.DIARIO.rows("abandono_compra_v1").length, 1, "[AB5.5/f] marcador gravado");
});
test("AB5.6 PURCHASE_DELAYED: 200, sem receita nem entrega; gancho trata como compra", async () => {
  const tr = await tree("ativo");
  const env = makeEnv();
  const r = await viaRoute(tr, env, purchase("PURCHASE_DELAYED", { txn: "HP-SINT-ATRASO1" }));
  assert.equal(r.status, 200, "[AB5.6]");
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  await refreshSalesSummary(kv, { now: T0 });
  const s = JSON.parse(kv.m.get(SALES_SUMMARY_KEY));
  assert.deepEqual([s.totals.approved, s.totals.grossCents], [0, 0], "[AB5.6/b] receita inalterada");
  assert.equal(env.DIARIO.rows("abandono_compra_v1").length, 1, "[AB5.6/c] marcador");
});
test("AB5.7 gancho no ramo KIT_ORDER_INGEST_ENABLED: depois de digital.ok e antes da ingestão, mesmo se ela falhar", async () => {
  const tr = await tree("kit");
  const order = [];
  const env = makeEnv({ extra: { KIT_DEFERRED_192H_ENABLED: "true", HOTMART_KIT_PRODUCT_IDS: "8704733" } });
  env.DIARIO.mode.onWrite = (sql) => { if (/abandono_compra_v1/.test(sql)) order.push("marcador"); };
  Object.defineProperty(env, "PURCHASE_RELEASE_DO", { get() { order.push("ingestao"); return undefined; } });
  const r = await viaRoute(tr, env, purchase("PURCHASE_APPROVED", { txn: "HP-SINT-KIT0001" }));
  assert.equal(r.status, 503, "[AB5.7/z] a ingestão do kit falha (binding ausente)");
  assert.equal(env.DIARIO.rows("abandono_compra_v1").length, 1, "[AB5.7] marcador gravado mesmo com a ingestão falhando");
  assert.deepEqual(order.filter((x, i, a) => a.indexOf(x) === i), ["marcador", "ingestao"], "[AB5.7/b] marcador antes da ingestão");
});
test("AB5.8 BILLET_PRINTED do CP 8704905: não-2xx e sem gravação", async () => {
  const env = makeEnv();
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS; const before = kv.writes();
  fresh();
  const r = await routeHotmartNc011(req(purchase("PURCHASE_BILLET_PRINTED", { product: 8704905, txn: "HP-SINT-CP00001" })), env, {});
  assert.ok(r.status < 200 || r.status >= 300, "[AB5.8] não-2xx: " + r.status);
  assert.equal(kv.writes() - before + d1Touched(env.DIARIO), 0, "[AB5.8/b] sem gravação");
});
// Condição (b) do GPT-6: compra registrada antes da reserva barra o envio mesmo se as leituras viessem de réplica atrasada.
test("AB5.9 compra antes da reserva barra o envio sem depender de leitura atrasada; sem sessões/réplicas", async () => {
  const env = makeEnv({ d1: createAbandonoD1({ lag: true }) }); const rs = fakeResend();
  env.DIARIO.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", await refOf(), T0 - MIN); // só no primário
  const r = await ingest(env, abandon());
  assert.equal(r.body.code, "queued", "[AB5.9/z] a leitura atrasada não vê a compra");
  const out = await drain(env, rs);
  assert.equal(rs.posts.length, 0, "[AB5.9] a reserva (instrução única no primário) barra o envio");
  assert.equal(envio(env.DIARIO).length, 0, "[AB5.9/b] nenhuma reserva");
  assert.equal(env.DIARIO.stats.sessions, 0, "[AB5.9/c] withSession nunca chamado");
  env.DIARIO.replicate();
  await drain(env, rs, { now: T0 + 2 * H });
  assert.equal(rs.posts.length, 0, "[AB5.9/d] continua sem envio");
  assert.ok(out.canceled === 0 && out.sent === 0, "[AB5.9/e] motivo não confirmado na leitura atrasada: mantém, sem POST");
  const src = readTextNormalized(new URL("../worker/abandono-hotmart.mjs", import.meta.url)).replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/withSession|first-primary|first-unconstrained|bookmark/.test(src), "[AB5.9/f] código sem API de sessões");
  // gancho de compra aguardado grava no primário e a reserva seguinte o vê
  const tr = await tree("ativo");
  const env2 = makeEnv({ d1: createAbandonoD1({ lag: true }) }); const rs2 = fakeResend();
  await ingest(env2, abandon(), {}, tr.ab);
  const pend = await pendOf(env2);
  await viaRoute(tr, env2, purchase("PURCHASE_APPROVED"));
  env2.ZEVANORY_PRIVATE_ARTIFACTS.m.set(AB.PEND_PREFIX + (await refOf()), pend);
  await drain(env2, rs2, {}, tr.ab);
  assert.equal(rs2.posts.length, 0, "[AB5.9/g] gravação impeditiva do gancho vale sem replicação");
});

// ------------------------------------------------------------------------------------------------- AB6 descadastro
const optReq = async (method = "GET", { ref, t } = {}) => {
  const r = ref ?? (await refOf());
  const tok = t ?? (await AB.optOutToken({ LEAD_PRIVACY_SECRET: SECRET }, r));
  return new Request(`https://zevanory.api.br/abandono/sair?r=${r}&t=${tok}`, { method, ...(method === "POST" ? { body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });
};
for (const [id, method] of [["AB6.1", "GET"], ["AB6.2", "POST"]]) {
  test(`${id} descadastro ${method} com token válido: supressão, pendência apagada, reservado -> cancelado`, async () => {
    const env = makeEnv();
    const ref = await seedPend(env);
    await seedRow(env.DIARIO, { ref, estado: "reservado" });
    const r = await AB.handleAbandonmentOptOut(await optReq(method), env, { now: T0, stage: "ativo" });
    assert.equal(r.status, 200, `[${id}] 200`);
    assert.equal(env.DIARIO.rows("abandono_supressao_v1").length, 1, `[${id}/a] supressão`);
    assert.equal(await pendOf(env), null, `[${id}/b] pendência apagada`);
    assert.equal(envio(env.DIARIO)[0].estado, "cancelado", `[${id}/c] cancelado`);
  });
}
test("AB6.3 token inválido, ref malformado ou t de outro tamanho: 400 sem gravação", async () => {
  const ref = await refOf();
  for (const [label, q] of [["token", { t: "0".repeat(32) }], ["ref", { ref: "zz" + ref.slice(2) }], ["t curto", { t: "abc" }], ["t longo", { t: (await AB.optOutToken({ LEAD_PRIVACY_SECRET: SECRET }, ref)) + "00" }]]) {
    const env = makeEnv();
    const r = await AB.handleAbandonmentOptOut(await optReq("GET", q), env, { now: T0, stage: "ativo" });
    assert.equal(r.status, 400, "[AB6.3] " + label);
    assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length + env.DIARIO.stats.writes, 0, "[AB6.3/b] nada gravado: " + label);
  }
});
test("AB6.4 suprimido + novo abandono: não enfileira; supressão só no D1 também barra a reserva", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await AB.handleAbandonmentOptOut(await optReq(), env, { now: T0, stage: "ativo" });
  assert.equal((await ingest(env, abandon())).body.code, "suppressed", "[AB6.4] não enfileira");
  const env2 = makeEnv();
  const ref = await seedPend(env2);
  env2.DIARIO.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", ref, T0);
  await drain(env2, rs);
  assert.equal(rs.posts.length, 0, "[AB6.4/b] supressão dentro da instrução de reserva");
});
test("AB6.5 e-mail com List-Unsubscribe, List-Unsubscribe-Post e link no corpo", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  await drain(env, rs);
  const body = rs.posts[0].body, url = await AB.optOutUrl(env, await refOf());
  assert.equal(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "[AB6.5] One-Click");
  assert.ok(body.headers["List-Unsubscribe"].includes(url), "[AB6.5/b] List-Unsubscribe");
  assert.ok(body.text.includes(url) && body.html.includes(url.replace(/&/g, "&amp;")), "[AB6.5/c] link no corpo");
  assert.deepEqual(body.tags[0], AB.RESEND_TAG, "[AB6.5/d] tag flow");
});
test("AB6.6 comparação do t usa timingSafeEqual sobre digests", async () => {
  const subtle = globalThis.crypto.subtle;
  const calls = [];
  const had = Object.prototype.hasOwnProperty.call(subtle, "timingSafeEqual");
  subtle.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); let v = a.length ^ b.length; for (let i = 0; i < a.length; i++) v |= a[i] ^ b[i]; return v === 0; };
  try {
    const env = makeEnv();
    const r = await AB.handleAbandonmentOptOut(await optReq(), env, { now: T0, stage: "ativo" });
    assert.equal(r.status, 200, "[AB6.6/z] descadastro 200");
    assert.ok(calls.length >= 1 && calls.every(([a, b]) => a === 32 && b === 32), "[AB6.6] timingSafeEqual sobre digests de 32 bytes");
  } finally { if (!had) delete subtle.timingSafeEqual; }
  const src = readTextNormalized(new URL("../worker/abandono-hotmart.mjs", import.meta.url));
  assert.ok(!/\bt\s*[!=]==?\s*expected|expected\s*[!=]==?\s*t\b/.test(src), "[AB6.6/b] sem === entre t e o esperado");
});

// Supressão manual (oposição recebida em suporte@): token de operador, só o pseudônimo.
const OPERATOR = "test-operator-" + "o".repeat(24); // sintético, gerado em runtime
const manualReq = (body, { token = OPERATOR, method = "POST", type = "application/json" } = {}) => new Request("https://zevanory.api.br" + AB.MANUAL_SUPPRESSION_PATH, {
  method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(type ? { "content-type": type } : {}) }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
});
test("AB6.7 supressão manual com token de operador: grava só o pseudônimo, apaga pendência, cancela reserva", async () => {
  const env = makeEnv({ extra: { ZEVANORY_OPERATOR_TOKEN: OPERATOR } });
  const ref = await seedPend(env);
  await seedRow(env.DIARIO, { ref, estado: "reservado" });
  const before = CAPTURED.lines.length;
  const r = await AB.handleAbandonmentManualSuppression(manualReq({ email: "  Comprador.Teste@Example.com " }), env, { now: T0, stage: "ativo" });
  assert.equal(r.status, 200, "[AB6.7] 200");
  assert.deepEqual(await r.json(), { ok: true, kv: true, d1: true }, "[AB6.7/a] resposta sem e-mail nem ref");
  assert.deepEqual(env.DIARIO.rows("abandono_supressao_v1").map((x) => x.ref), [ref], "[AB6.7/b] supressão pelo pseudônimo normalizado");
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(AB.SUPKV_PREFIX + ref), "[AB6.7/c] supkv gravado");
  assert.equal(await pendOf(env), null, "[AB6.7/d] pendência apagada");
  assert.equal(envio(env.DIARIO)[0].estado, "cancelado", "[AB6.7/e] reserva cancelada");
  const stored = JSON.stringify([...env.ZEVANORY_PRIVATE_ARTIFACTS.m.entries()].filter(([k]) => k.startsWith("abandono:"))) + JSON.stringify(env.DIARIO.rows("abandono_supressao_v1"));
  assert.ok(!/example\.com|comprador/i.test(stored), "[AB6.7/f] e-mail nunca gravado");
  assert.ok(!/example\.com|comprador/i.test(CAPTURED.lines.slice(before).join("\n")), "[AB6.7/g] e-mail nunca logado");
  assert.equal((await ingest(env, abandon())).body.code, "suppressed", "[AB6.7/h] novo abandono suprimido");
});
test("AB6.8 supressão manual: sem token/errado 401, GET 405, e-mail inválido 400, desligado 503 sem gravar", async () => {
  const env = makeEnv({ extra: { ZEVANORY_OPERATOR_TOKEN: OPERATOR } });
  const st = async (req, stage = "ativo") => (await AB.handleAbandonmentManualSuppression(req, env, stage === null ? { now: T0 } : { now: T0, stage })).status;
  assert.equal(await st(manualReq({ email: EMAIL }, { token: null })), 401, "[AB6.8] sem token");
  assert.equal(await st(manualReq({ email: EMAIL }, { token: OPERATOR.slice(0, -1) + "x" })), 401, "[AB6.8/a] token errado");
  assert.equal(await st(manualReq({ email: EMAIL }, { method: "GET" })), 405, "[AB6.8/b] GET");
  assert.equal(await st(manualReq({ email: "sem-arroba" })), 400, "[AB6.8/c] e-mail inválido");
  assert.equal(await st(manualReq("{", {})), 400, "[AB6.8/d] JSON inválido");
  assert.equal(await st(manualReq({ email: EMAIL }, { type: "text/plain" })), 415, "[AB6.8/e] só JSON");
  assert.equal(await st(manualReq({ email: EMAIL }), "desligado"), 503, "[AB6.8/f] desligado");
  assert.equal(await st(manualReq({ email: EMAIL }), null), 503, "[AB6.8/g] estágio do fonte (desligado)");
  assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length + env.DIARIO.stats.writes, 0, "[AB6.8/h] nada gravado");
  const noTok = makeEnv();
  assert.equal((await AB.handleAbandonmentManualSuppression(manualReq({ email: EMAIL }), noTok, { now: T0, stage: "ativo" })).status, 401, "[AB6.8/i] sem token configurado: fail-closed");
});
test("AB6.9 supressão manual com D1 fora grava supkv; com KV e D1 fora, 503", async () => {
  const env = makeEnv({ extra: { ZEVANORY_OPERATOR_TOKEN: OPERATOR } }); env.DIARIO.mode.failAll = true;
  const r = await safe(AB.handleAbandonmentManualSuppression(manualReq({ email: EMAIL }), env, { now: T0, stage: "ativo" }));
  assert.equal(r.status, 200, "[AB6.9] 200 com supkv");
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(AB.SUPKV_PREFIX + (await refOf())), "[AB6.9/a] supkv");
  const both = makeEnv({ extra: { ZEVANORY_OPERATOR_TOKEN: OPERATOR } }); both.DIARIO.mode.failAll = true; both.ZEVANORY_PRIVATE_ARTIFACTS.mode.failPut = true;
  assert.equal((await safe(AB.handleAbandonmentManualSuppression(manualReq({ email: EMAIL }), both, { now: T0, stage: "ativo" }))).status, 503, "[AB6.9/b] 503");
});

// ------------------------------------------------------------------------------------------------- AB7 retenção
test("AB7.1 retenção: pend TTL <= 72 h; apaga envio e compra > 30 dias; não toca a supressão", async () => {
  const env = makeEnv();
  await ingest(env, abandon());
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.ttl.get(AB.PEND_PREFIX + (await refOf())) <= 72 * 3600, "[AB7.1/a] TTL da pendência");
  const d1 = env.DIARIO;
  await seedRow(d1, { ref: "a".repeat(64), estado: "enviado", criado: T0 - 31 * D });
  await seedRow(d1, { ref: "b".repeat(64), estado: "enviado", criado: T0 - 29 * D });
  d1.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?), (?, ?)", "c".repeat(64), T0 - 31 * D, "d".repeat(64), T0 - D);
  d1.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", "e".repeat(64), T0 - 400 * D);
  const out = await AB.runAbandonmentRetention(env, { now: T0, stage: "ativo" });
  assert.equal(out.ok, true, "[AB7.1/e] retenção ok");
  assert.deepEqual(envio(d1).map((r) => r.ref[0]), ["b"], "[AB7.1] envio > 30 dias apagado");
  assert.deepEqual(d1.rows("abandono_compra_v1").map((r) => r.ref[0]), ["d"], "[AB7.1/b] compra > 30 dias apagada");
  assert.equal(d1.rows("abandono_supressao_v1").length, 1, "[AB7.1/c] supressão intacta");
  assert.deepEqual([out.apagadas_envio, out.apagadas_compra], [1, 1], "[AB7.1/d] contagens");
});
test("AB7.2 received_at com mais de 24 h: apagado, não enviado", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await seedPend(env, { received: T0 - 25 * H, due: T0 - 24 * H });
  await drain(env, rs, { now: T0 });
  assert.equal(rs.posts.length, 0, "[AB7.2] não envia");
  assert.equal(await pendOf(env), null, "[AB7.2/b] apagado");
});
test("AB7.3 due_at no futuro: não enviado nesta execução", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  await drain(env, rs, { now: T0 + 30 * MIN });
  assert.equal(rs.posts.length, 0, "[AB7.3]");
  assert.notEqual(await pendOf(env), null, "[AB7.3/b] pendência mantida");
});
test("AB7.4 gatilhos da 0003: UPDATE e DELETE na supressão abortam; INSERT OR IGNORE repetido não falha", async () => {
  const d1 = createAbandonoD1();
  d1.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", "f".repeat(64), T0);
  assert.throws(() => d1.sql("UPDATE abandono_supressao_v1 SET criado_ms = 1"), /abandono_supressao_v1_permanente/, "[AB7.4] UPDATE aborta");
  assert.throws(() => d1.sql("DELETE FROM abandono_supressao_v1"), /abandono_supressao_v1_permanente/, "[AB7.4/b] DELETE aborta");
  assert.doesNotThrow(() => d1.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", "f".repeat(64), T0 + 1), "[AB7.4/c] INSERT OR IGNORE");
  assert.deepEqual(d1.rows("abandono_supressao_v1").map((r) => r.criado_ms), [T0], "[AB7.4/d] linha intacta");
});
test("AB7.4b regra estática: só INSERT OR IGNORE na supressão; sem REPLACE nem DO UPDATE", () => {
  for (const f of ["worker/abandono-hotmart.mjs", "migrations/d1/0003_abandono_v1.sql"]) {
    const src = readTextNormalized(new URL("../" + f, import.meta.url)).replace(/^\s*(?:\/\/|--).*$/gm, "");
    const stmts = src.split(/[;`"]/).filter((s) => /abandono_supressao_v1/.test(s));
    for (const s of stmts) {
      assert.ok(!/INSERT\s+OR\s+REPLACE|REPLACE\s+INTO|ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(s), "[AB7.4b] proibido em " + f + ": " + s.trim().slice(0, 80));
      if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+abandono_supressao_v1/i.test(s)) assert.match(s, /INSERT\s+OR\s+IGNORE\s+INTO\s+abandono_supressao_v1/i, "[AB7.4b/2] INSERT OR IGNORE em " + f);
    }
  }
});
test("AB7.4c demonstração: INSERT OR REPLACE escapa do gatilho com recursive_triggers desligado", () => {
  const d1 = createAbandonoD1();
  d1.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", "f".repeat(64), T0);
  d1.primary.exec("PRAGMA recursive_triggers = OFF");
  d1.sql("INSERT OR REPLACE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", "f".repeat(64), T0 + 5);
  assert.deepEqual(d1.rows("abandono_supressao_v1").map((r) => r.criado_ms), [T0 + 5], "[AB7.4c] o REPLACE muda a linha sem disparar o gatilho");
});
test("AB7.4d regra estática: em worker/** nenhum DDL das tabelas do abandono e nenhum DELETE/UPDATE na supressão", () => {
  const { readdirSync, statSync } = process.getBuiltinModule("node:fs");
  const base = fileURLToPath(new URL("../worker/", import.meta.url));
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = d + "/" + n; if (statSync(f).isDirectory()) walk(f); else if (/\.(mjs|js|cjs)$/.test(n)) files.push(f); } };
  walk(base.replace(/\/$/, ""));
  assert.ok(files.length > 50, "[AB7.4d/a] varredura de worker/**");
  const hits = [];
  for (const f of files) {
    const src = readTextNormalized(f);
    if (!/abandono_/.test(src)) continue;
    const rel = f.slice(base.length);
    if (/\b(?:CREATE|DROP|ALTER)\s+(?:TABLE|TRIGGER|INDEX|VIEW)\b[^;`"]*abandono_/i.test(src)) hits.push(rel + ": DDL");
    if (/\b(?:DROP|ALTER)\s+(?:TABLE|TRIGGER)\b/i.test(src) && rel === "abandono-hotmart.mjs") hits.push(rel + ": DROP/ALTER");
    if (/\bDELETE\s+FROM\s+abandono_supressao_v1\b|\bUPDATE\s+abandono_supressao_v1\b/i.test(src)) hits.push(rel + ": DELETE/UPDATE na supressão");
    if (/PRAGMA\s+recursive_triggers/i.test(src)) hits.push(rel + ": PRAGMA");
  }
  assert.deepEqual(hits, [], "[AB7.4d] esquema só por migrations/d1; supressão só INSERT OR IGNORE");
});
const selfFor = (env, stage, handler) => ({ calls: [], async fetch(r) { this.calls.push(new URL(r.url).pathname); return handler(r, env, { stage, nowMs: T0 + 6 * H }); } });
test("AB7.5 retenção isolada às 06 UTC em aquecimento e ativo, via SELF com token; desligado sem SELF", async () => {
  for (const stage of ["aquecimento", "ativo"]) {
    const env = makeEnv();
    await seedRow(env.DIARIO, { ref: "a".repeat(64), estado: "enviado", criado: T0 - 31 * D });
    env.SELF = selfFor(env, stage, AB.handleAbandonmentRetentionRequest);
    const beat = await AB.dispatchAbandonmentRetention(env, { nowMs: T0 + 6 * H, stage });
    assert.deepEqual(env.SELF.calls, [AB.RETENTION_PATH], "[AB7.5] SELF na rota de retenção: " + stage);
    assert.equal(beat.ok, true, "[AB7.5/b] ok: " + stage);
    assert.equal(beat.apagadas_envio, 1, "[AB7.5/c] apagou só a linha velha");
    for (const k of ["apagadas_envio", "apagadas_compra", "supkv_fundidas", "idade_max_envio_dias", "idade_max_compra_dias"]) assert.equal(typeof beat[k], "number", "[AB7.5/d] " + k);
    assert.ok(!JSON.stringify(beat).includes("a".repeat(16)), "[AB7.5/e] sem ref");
  }
  const env = makeEnv(); env.SELF = selfFor(env, "desligado", AB.handleAbandonmentRetentionRequest);
  assert.deepEqual(await AB.dispatchAbandonmentRetention(env, { nowMs: T0 + 6 * H, stage: "desligado" }), { skipped: "disabled" }, "[AB7.5/f] desligado");
  assert.equal(env.SELF.calls.length + d1Touched(env.DIARIO), 0, "[AB7.5/g] desligado sem SELF nem D1");
});
test("AB7.6 retenção: token errado 401, GET 405, SELF falhando sem inline, D1 indisponível", async () => {
  const env = makeEnv();
  await seedRow(env.DIARIO, { ref: "a".repeat(64), estado: "enviado", criado: T0 - 31 * D });
  const bad = new Request("https://zevanory.api.br" + AB.RETENTION_PATH, { method: "POST", headers: { "x-abandono-token": "0".repeat(64), "x-abandono-minute": String(Math.floor(T0 / MIN)) } });
  assert.equal((await AB.handleAbandonmentRetentionRequest(bad, env, { nowMs: T0, stage: "ativo" })).status, 401, "[AB7.6] 401");
  assert.equal((await AB.handleAbandonmentRetentionRequest(new Request("https://zevanory.api.br" + AB.RETENTION_PATH), env, { nowMs: T0, stage: "ativo" })).status, 405, "[AB7.6/b] 405");
  env.SELF = { async fetch() { throw new Error("self down"); } };
  const beat = await safe(AB.dispatchAbandonmentRetention(env, { nowMs: T0, stage: "ativo" }));
  assert.deepEqual([beat.ok, beat.motivo], [false, "self_failed"], "[AB7.6/c] self_failed");
  assert.equal(envio(env.DIARIO).length, 1, "[AB7.6/d] não roda inline");
  const off = makeEnv({ d1: createAbandonoD1({ migrations: null }) });
  const out = await safe(AB.runAbandonmentRetention(off, { now: T0, stage: "ativo" }));
  assert.deepEqual([out.ok, out.motivo], [false, "d1_unavailable"], "[AB7.6/e] d1_unavailable");
});
test("AB7.7 compra com 32 dias não apagada (falha anterior): alerta só com contagens", async () => {
  const env = makeEnv();
  const ref = "c".repeat(64);
  env.DIARIO.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", ref, T0 - 32 * D);
  env.DIARIO.mode.failOn = /DELETE FROM abandono_compra_v1/;
  const before = CAPTURED.lines.length;
  const out = await safe(AB.runAbandonmentRetention(env, { now: T0, stage: "ativo" }));
  assert.equal(out.idade_max_compra_dias, 32, "[AB7.7/a] idade máxima");
  const errs = CAPTURED.lines.slice(before).filter((l) => l.startsWith("abandono_retencao_atrasada"));
  assert.equal(errs.length, 1, "[AB7.7] console.error de retenção atrasada");
  const alert = [...env.ZEVANORY_PRIVATE_ARTIFACTS.m.entries()].find(([k]) => k.startsWith("zpc-alert:v1:abandono-retencao:"));
  assert.ok(alert && JSON.parse(alert[1]).category === "abandono_retencao_atrasada", "[AB7.7/b] entra no resumo de alertas");
  assert.ok(!errs[0].includes(ref.slice(0, 12)) && !alert[1].includes(ref.slice(0, 12)), "[AB7.7/c] sem ref");
});
test("AB7.8 fusão da supressão de reserva: supkv no KV com D1 fora, respeitado antes, inserido no D1 antes de apagar", async () => {
  const env = makeEnv(); const rs = fakeResend();
  env.DIARIO.mode.failAll = true;
  const r = await safe(AB.handleAbandonmentOptOut(await optReq(), env, { now: T0, stage: "ativo" }));
  assert.equal(r.status, 200, "[AB7.8/a] Pronto com supkv");
  const ref = await refOf(), key = AB.SUPKV_PREFIX + ref;
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(key), "[AB7.8/b] supkv gravado");
  env.DIARIO.mode.failAll = false;
  assert.equal((await safe(ingest(env, abandon()))).body.code, "suppressed", "[AB7.8/g] ingestão respeita supkv antes da fusão");
  env.DIARIO.mode.failOn = /abandono_supressao_v1/;
  await seedPend(env);
  await safe(drain(env, rs));
  assert.equal(rs.posts.length, 0, "[AB7.8/c] dreno respeita supkv não fundido");
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(key), "[AB7.8] supkv só sai depois de inserir no D1");
  env.DIARIO.mode.failOn = null;
  const order = [];
  env.DIARIO.mode.onWrite = (sql) => { if (/abandono_supressao_v1/.test(sql)) order.push("d1"); };
  const del = env.ZEVANORY_PRIVATE_ARTIFACTS.delete.bind(env.ZEVANORY_PRIVATE_ARTIFACTS);
  env.ZEVANORY_PRIVATE_ARTIFACTS.delete = async (k) => { if (k === key) order.push("kv"); return del(k); };
  const out = await safe(AB.runAbandonmentRetention(env, { now: T0, stage: "ativo" }));
  assert.equal(out.supkv_fundidas, 1, "[AB7.8/d] fundida");
  assert.deepEqual(order, ["d1", "kv"], "[AB7.8/e] D1 antes de apagar o KV");
  assert.equal(env.DIARIO.rows("abandono_supressao_v1").length, 1, "[AB7.8/f] supressão no D1");
});

// ------------------------------------------------------------------------------------------------- AB9 texto
test("AB9.1 texto: nome e preço de productBySlug, link /hotmart/<slug>, filtro sem violação nos 5 kits", () => {
  for (const slug of SLUGS) {
    const p = productBySlug(slug), mail = AB.abandonmentEmail(slug, { optOutUrl: "https://zevanory.api.br/abandono/sair?r=x&t=y" });
    assert.ok(mail.text.includes(`${p.name} (R$ ${p.price}, pagamento único)`), "[AB9.1] nome e preço: " + slug);
    assert.equal(mail.subject, `Sua compra do ${p.name} não foi concluída`, "[AB9.1/b] assunto");
    assert.ok(mail.text.includes(`https://vendas.zevanory.api.br/hotmart/${slug}?utm_source=email-abandono`), "[AB9.1/c] link");
    assert.deepEqual(AB.abandonmentLockViolations(mail), [], "[AB9.1/d] filtro: " + slug);
    assert.ok(hotmartLockViolations(mail.text, slug).every((v) => v === "checkout_link"), "[AB9.1/e] só a menção literal à Hotmart como origem é mascarada");
  }
});
test("AB9.2 texto sem urgência, escassez, outro kit, irreversível ou Brasil/titulares", () => {
  for (const slug of SLUGS) {
    const t = AB.abandonmentEmail(slug, { optOutUrl: "u" }).text.toLowerCase();
    for (const bad of ["últimas vagas", "só hoje", "expira", "desconto", "garanta já", "compre agora", "irreversível", "brasil", "titulares", "fulano"]) assert.ok(!t.includes(bad), "[AB9.2] " + bad);
    for (const other of SLUGS.filter((s) => s !== slug)) assert.ok(!t.includes("/hotmart/" + other), "[AB9.2/b] outro kit");
  }
});
test("AB9.3 rodapé: razão social, CNPJ, motivo, único lembrete, apagado, derivado com chave, Resend", () => {
  const t = AB.abandonmentEmail("ia-na-pratica", { optOutUrl: "u" }).text;
  for (const s of ["A. RENAN ALVES MOREIRA BITU LTDA", "69.077.233/0001-99", "Por que você recebeu este e-mail", "Este é o único lembrete sobre este pedido", "apagado da nossa base", "derivado do e-mail com chave secreta", "Resend", "legítimo interesse"]) assert.ok(t.includes(s), "[AB9.3] " + s);
});
test("AB9.4 productBySlug lança (slug desconhecido): sem envio, pendência apagada", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await seedPend(env, { slug: "kit-inexistente" });
  await drain(env, rs);
  assert.equal(rs.posts.length, 0, "[AB9.4]");
  assert.equal(await pendOf(env), null, "[AB9.4/b]");
});
test("AB9.5 preço de HOTMART_KITS divergente de products.json: o filtro acusa e não envia", async () => {
  const p = productBySlug("ia-na-pratica");
  const t = patchedTree([stagePatch("ativo"), ["worker/sales-lock-content.mjs", `name: "${p.name}", price: ${p.price} })`, `name: "${p.name}", price: ${p.price + 1} })`]]);
  try {
    const ab = await t.load("worker/abandono-hotmart.mjs"), sales = await t.load("worker/sales-control.mjs");
    const mail = ab.abandonmentEmail("ia-na-pratica", { optOutUrl: "u" });
    assert.ok(ab.abandonmentLockViolations(mail).includes("price"), "[AB9.5] divergência acusada");
    const env = makeEnv(); const rs = fakeResend();
    await seedPend(env);
    sales.resetSalesSwitchCache(); sales.resetHotmartSwitchCache();
    await ab.runAbandonmentDue(env, { now: T0 + 61 * MIN, fetchImpl: rs.fetchImpl });
    assert.equal(rs.posts.length, 0, "[AB9.5/b] não envia");
  } finally { t.cleanup(); }
});
test("AB9.6 regra estática de preço: nenhum literal de preço no módulo; productBySlug obrigatório", () => {
  const src = readTextNormalized(new URL("../worker/abandono-hotmart.mjs", import.meta.url));
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /import\s*\{\s*productBySlug\s*\}\s*from\s*"\.\/product-prices\.mjs"/, "[AB9.6] importa productBySlug");
  assert.match(code, /export function abandonmentEmail\(slug[^)]*\)\s*\{\s*\n\s*const p = productBySlug\(slug\);/, "[AB9.6/b] o texto deriva de productBySlug(slug)");
  assert.ok(!/R\$\s*\d|\bBRL\s*\d|\d+\s*reais\b|(?<![{\d])\d+,\d{2}(?![\d}])/i.test(code), "[AB9.6/c] sem valor em reais literal");
  assert.ok(!/\b(?:price|preco|preço|valor|amount)\s*[:=]\s*-?\d/i.test(code), "[AB9.6/d] sem campo de preço literal");
  assert.ok(!/\b(?:price|preco|valor)\s*[+\-*/%]\s*\d|\d\s*[+\-*/%]\s*\w*\.price\b/i.test(code), "[AB9.6/e] sem aritmética de preço");
  const official = new Set(SLUGS.map((s) => String(productBySlug(s).price)));
  const literals = [...code.matchAll(/(?<![\w.$])\d+(?![\w.])/g)].map((m) => m[0]).filter((n) => official.has(n));
  assert.deepEqual(literals, [], "[AB9.6/f] nenhum número igual a um preço oficial");
  assert.ok(!/HOTMART_KITS|PRICE_BY_SKU|priceBySku|priceBySlug/.test(code), "[AB9.6/g] só productBySlug como fonte");
});

// ------------------------------------------------------------------------------------------------- AB10 estágio, falhas
test("AB10.1 ABANDONO_STAGE do fonte é desligado: evento 200 disabled com sonda; dreno skipped; nada gravado", async () => {
  assert.equal(AB.ABANDONO_STAGE, "desligado", "[AB10.1] constante do fonte");
  const env = makeEnv(); const rs = fakeResend(); const before = shapeLines().length;
  fresh();
  const r = await AB.handleHotmartAbandonment(req(abandon()), env, { now: T0 });
  assert.deepEqual([r.status, (await r.json()).code], [200, "disabled"], "[AB10.1/a] disabled");
  assert.equal(shapeLines().length, before + 1, "[AB10.1/b] sonda emitida");
  const out = await AB.runAbandonmentDue(env, { now: T0 + 2 * H, fetchImpl: rs.fetchImpl });
  assert.equal(out.skipped, "disabled", "[AB10.1/c] dreno skipped");
  assert.equal(rs.posts.length + env.ZEVANORY_PRIVATE_ARTIFACTS.writes() + d1Touched(env.DIARIO), 0, "[AB10.1/d] 0 KV, 0 D1, 0 envio");
  const sair = await AB.handleAbandonmentOptOut(await optReq(), env, { now: T0 });
  assert.equal(sair.status, 503, "[AB10.1/e] descadastro inativo sem gravar");
  assert.equal(env.ZEVANORY_PRIVATE_ARTIFACTS.writes() + d1Touched(env.DIARIO), 0, "[AB10.1/f] nada gravado");
  assert.deepEqual(await AB.runAbandonmentRetention(env, { now: T0 }), { ok: false, motivo: "disabled" }, "[AB10.1/g] retenção desligada");
});
test("AB10.1b desligado + compra/boleto com e-mail: gancho sem leitura nem gravação no D1 e no KV do abandono", async () => {
  for (const ev of ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_BILLET_PRINTED"]) {
    const env = makeEnv();
    fresh();
    const r = await routeHotmartNc011(req(purchase(ev)), env, {});
    assert.equal(r.status, 200, "[AB10.1b/z] compra 200: " + ev);
    assert.equal(abandonoSql(env.DIARIO), 0, "[AB10.1b] 0 leituras/gravações do abandono no D1: " + ev);
    const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
    assert.ok(![...kv.stats.getKeys, ...kv.stats.putKeys, ...kv.stats.deleteKeys].some((k) => k.startsWith("abandono:")), "[AB10.1b/2] 0 acessos ao KV do abandono");
  }
  assert.deepEqual(await AB.noteHotmartPurchase(makeEnv(), purchase().data, { now: T0 }), { skipped: "disabled" }, "[AB10.1b/3]");
});
test("AB10.2 roteamento: abandono sem purchase chega ao módulo novo, nunca 422", async () => {
  const env = makeEnv();
  fresh();
  const r = await routeHotmartNc011(req(abandon()), env, {});
  assert.deepEqual([r.status, (await r.json()).code], [200, "disabled"], "[AB10.2] módulo novo (desligado)");
  const tr = await tree("ativo");
  const a = await viaRoute(tr, makeEnv(), abandon());
  assert.deepEqual([a.status, a.body.code], [202, "queued"], "[AB10.2/b] ativo enfileira");
  const cp = await viaRoute(tr, makeEnv(), abandon({ product: 8704905 }));
  assert.deepEqual([cp.status, cp.body.code], [200, "product_not_allowed"], "[AB10.2/c] CP: 200, não vai ao handler do CP");
});
test("AB10.3 e-mail inválido ou ausente: 200 ignorado, sem gravação", async () => {
  for (const email of [null, "", "sem-arroba", "a@b", "x y@example.com"]) {
    const env = makeEnv();
    const r = await ingest(env, abandon({ email }));
    assert.deepEqual([r.status, r.body.code], [200, "no_email"], "[AB10.3] " + String(email));
    assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length + d1Touched(env.DIARIO), 0, "[AB10.3/b]");
  }
});
test("AB10.3b país: PT -> non_br; BR -> enfileira; ausente -> enfileira", async () => {
  assert.equal((await ingest(makeEnv(), abandon({ iso: "PT" }))).body.code, "non_br", "[AB10.3b] PT");
  assert.equal((await ingest(makeEnv(), abandon({ iso: "br" }))).body.code, "queued", "[AB10.3b/c] BR");
  assert.equal((await ingest(makeEnv(), abandon({ country: false }))).body.code, "queued", "[AB10.3b/d] ausente");
});
test("AB10.4 LEAD_PRIVACY_SECRET ausente: 503 sem gravação", async () => {
  const env = makeEnv({ extra: { LEAD_PRIVACY_SECRET: "" } });
  const r = await ingest(env, abandon());
  assert.equal(r.status, 503, "[AB10.4]");
  assert.equal(abandonoKeys(env.ZEVANORY_PRIVATE_ARTIFACTS).length + d1Touched(env.DIARIO), 0, "[AB10.4/b]");
});
test("AB10.5 orçamento de KV >= 70%: 200 kv_budget", async () => {
  const env = makeEnv();
  env.ZEVANORY_PRIVATE_ARTIFACTS.m.set("zpc:kv:v1:budget", JSON.stringify({ day: new Date(T0).toISOString().slice(0, 10), pct: 70 }));
  assert.equal((await ingest(env, abandon())).body.code, "kv_budget", "[AB10.5]");
});
test("AB10.6 sem env.DIARIO (binding fora do deploy): tudo d1_unavailable/skipped", async () => {
  const env = makeEnv(); delete env.DIARIO;
  const rs = fakeResend();
  const r = await ingest(env, abandon());
  assert.deepEqual([r.status, r.body.code], [200, "d1_unavailable"], "[AB10.6] ingestão");
  assert.equal(await pendOf(env), null, "[AB10.6/b] sem pendência");
  await seedPend(env);
  const out = await drain(env, rs);
  assert.equal(out.skipped, "d1_unavailable", "[AB10.6/c] dreno");
  assert.equal(rs.posts.length, 0, "[AB10.6/d] sem envio");
  assert.deepEqual(await AB.noteHotmartPurchase(env, purchase().data, { now: T0, stage: "ativo" }), { skipped: "d1_unavailable" }, "[AB10.6/e] gancho");
  assert.deepEqual(await AB.dispatchAbandonmentDrain(env, { nowMs: T0, stage: "ativo" }), { skipped: "d1_unavailable" }, "[AB10.6/f] sem SELF");
  const ret = await AB.dispatchAbandonmentRetention(env, { nowMs: T0, stage: "ativo" });
  assert.deepEqual([ret.ok, ret.motivo], [false, "d1_unavailable"], "[AB10.6/g] retenção");
  const sair = await AB.handleAbandonmentOptOut(await optReq(), env, { now: T0, stage: "ativo" });
  assert.equal(sair.status, 200, "[AB10.6/h] descadastro grava supkv (Revisão 5b)");
});
test("AB10.7 binding sem a tabela 0003, prepare que lança e resultado sem meta: fail-closed sem log do erro", async () => {
  const variants = [
    ["sem_tabela", () => createAbandonoD1({ migrations: readTextNormalized(new URL("../migrations/d1/0001_diario_v1.sql", import.meta.url)) })],
    ["prepare_lanca", () => { const d = createAbandonoD1(); d.mode.failAll = true; return d; }],
    ["sem_meta", () => { const d = createAbandonoD1(); d.mode.noMeta = true; return d; }],
  ];
  const tr = await tree("ativo");
  for (const [label, mk] of variants) {
    const before = CAPTURED.lines.length;
    const env = makeEnv({ d1: mk() }); const rs = fakeResend();
    const r = await safe(ingest(env, abandon()));
    if (label !== "sem_meta") assert.deepEqual([r.status, r.body.code], [200, "d1_unavailable"], "[AB10.7] ingestão: " + label);
    if (label !== "sem_meta") assert.equal(await pendOf(env), null, "[AB10.7/b] sem pendência: " + label);
    await seedPend(env);
    const out = await safe(drain(env, rs));
    assert.equal(rs.posts.length, 0, "[AB10.7/c] sem POST: " + label);
    if (label !== "sem_meta") assert.equal(out.skipped, "d1_unavailable", "[AB10.7/d] dreno: " + label);
    const base = await safe(viaRoute(tr, makeEnv(), purchase("PURCHASE_APPROVED", { txn: "HP-SINT-D1FALHA" })));
    const hooked = await safe(viaRoute(tr, makeEnv({ d1: mk() }), purchase("PURCHASE_APPROVED", { txn: "HP-SINT-D1FALHA" })));
    assert.deepEqual(hooked, base, "[AB10.7/e] resposta da compra inalterada: " + label);
    const sair = await safe(AB.handleAbandonmentOptOut(await optReq(), makeEnv({ d1: mk() }), { now: T0, stage: "ativo" }));
    assert.equal(sair.status, 200, "[AB10.7/f] supkv e Pronto: " + label);
    const kvDown = makeEnv({ d1: mk() }); kvDown.ZEVANORY_PRIVATE_ARTIFACTS.mode.failPut = true;
    if (label !== "sem_meta") assert.equal((await safe(AB.handleAbandonmentOptOut(await optReq(), kvDown, { now: T0, stage: "ativo" }))).status, 503, "[AB10.7/g] KV e D1 falhando: " + label);
    const ret = await safe(AB.runAbandonmentRetention(makeEnv({ d1: mk() }), { now: T0, stage: "ativo" }));
    assert.equal(ret.ok, false, "[AB10.7/h] retenção: " + label);
    const logs = CAPTURED.lines.slice(before).join("\n");
    assert.ok(!/no such table|D1_ERROR|d1_sem_meta/.test(logs), "[AB10.7/i] sem texto do erro no log: " + label);
  }
});
test("AB10.7b descadastro: D1 fora e KV gravando -> 200 Pronto; D1 e KV falhando -> 503", async () => {
  const env = makeEnv(); env.DIARIO.mode.failAll = true;
  const ok = await safe(AB.handleAbandonmentOptOut(await optReq(), env, { now: T0, stage: "ativo" }));
  assert.equal(ok.status, 200, "[AB10.7b] Pronto com supkv");
  assert.ok(env.ZEVANORY_PRIVATE_ARTIFACTS.m.has(AB.SUPKV_PREFIX + (await refOf())), "[AB10.7b/2] supkv gravado");
  const both = makeEnv(); both.DIARIO.mode.failAll = true; both.ZEVANORY_PRIVATE_ARTIFACTS.mode.failPut = true;
  const fail = await safe(AB.handleAbandonmentOptOut(await optReq(), both, { now: T0, stage: "ativo" }));
  assert.equal(fail.status, 503, "[AB10.7b/3] 503 sem nenhuma gravação");
  assert.match(await fail.text(), /suporte@zevanory\.api\.br/, "[AB10.7b/4] com o suporte");
});
test("AB10.8 regra estática: todo acesso ao D1 passa por d1(); sem withSession", () => {
  const code = readTextNormalized(new URL("../worker/abandono-hotmart.mjs", import.meta.url)).replace(/^\s*\/\/.*$/gm, "");
  const prepares = [...code.matchAll(/\.prepare\(/g)].length;
  assert.equal(prepares, 3, "[AB10.8] prepare só nos 3 auxiliares run/first/allRows");
  assert.equal([...code.matchAll(/=\s*env\?\.DIARIO;/g)].length, 1, "[AB10.8/b] binding lido só em d1()");
  assert.ok(!/env\??\.DIARIO\??\.|DIARIO\.prepare|DIARIO\.batch/.test(code), "[AB10.8/d] nenhum uso direto do binding fora de d1()");
  assert.ok(!/withSession/.test(code), "[AB10.8/c] sem withSession");
});

// ------------------------------------------------------------------------------------------------- AB11 SELF
const drainSelf = (env, stage, nowMs = T0 + 61 * MIN, fetchImpl) => ({ calls: [], async fetch(r) { this.calls.push(new URL(r.url).pathname); return AB.handleAbandonmentDrainRequest(r, env, { stage, nowMs, fetchImpl }); } });
test("AB11.1 cron horário chama o SELF na rota de dreno com token válido; o dreno roda só dentro da rota", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  env.SELF = drainSelf(env, "ativo", T0 + 61 * MIN, rs.fetchImpl);
  fresh();
  const beat = await AB.dispatchAbandonmentDrain(env, { nowMs: T0 + 61 * MIN, stage: "ativo" });
  assert.deepEqual(env.SELF.calls, [AB.DRAIN_PATH], "[AB11.1] SELF no dreno");
  assert.equal(beat.via, "self", "[AB11.1/b] via self");
  assert.equal(beat.sent, 1, "[AB11.1/c] enviado dentro da rota");
  assert.ok(!JSON.stringify(beat).includes("@"), "[AB11.1/d] batimento sem e-mail");
});
test("AB11.2 rota de dreno: token errado, minuto fora da janela, GET -> 401/401/405 sem envio", async () => {
  const env = makeEnv(); const rs = fakeResend();
  await ingest(env, abandon());
  const now = T0 + 61 * MIN, minute = Math.floor(now / MIN);
  const mk = (h) => new Request("https://zevanory.api.br" + AB.DRAIN_PATH, { method: "POST", headers: h });
  let captured = null;
  const spy = { async fetch(r) { captured = r; return new Response("{}"); } };
  await AB.dispatchAbandonmentDrain({ ...env, SELF: spy }, { nowMs: now - 5 * MIN, stage: "ativo" });
  const stale = mk({ "x-abandono-token": captured.headers.get("x-abandono-token"), "x-abandono-minute": captured.headers.get("x-abandono-minute") });
  const res = [
    await AB.handleAbandonmentDrainRequest(mk({ "x-abandono-token": "0".repeat(64), "x-abandono-minute": String(minute) }), env, { stage: "ativo", nowMs: now, fetchImpl: rs.fetchImpl }),
    await AB.handleAbandonmentDrainRequest(stale, env, { stage: "ativo", nowMs: now, fetchImpl: rs.fetchImpl }),
    await AB.handleAbandonmentDrainRequest(new Request("https://zevanory.api.br" + AB.DRAIN_PATH), env, { stage: "ativo", nowMs: now, fetchImpl: rs.fetchImpl }),
    await AB.handleAbandonmentDrainRequest(mk({}), env, { stage: "ativo", nowMs: now, fetchImpl: rs.fetchImpl }),
  ].map((r) => r.status);
  assert.deepEqual(res, [401, 401, 405, 401], "[AB11.2] 401/401/405/401");
  assert.equal(rs.posts.length, 0, "[AB11.2/b] nada enviado");
});
test("AB11.3 SELF ausente ou lança: não roda inline, via self_failed", async () => {
  for (const self of [undefined, { async fetch() { throw new Error("down"); } }]) {
    const env = makeEnv(); const rs = fakeResend();
    await ingest(env, abandon());
    if (self) env.SELF = self;
    const beat = await AB.dispatchAbandonmentDrain(env, { nowMs: T0 + 61 * MIN, stage: "ativo", fetchImpl: rs.fetchImpl });
    assert.equal(beat.via, "self_failed", "[AB11.3] self_failed");
    assert.equal(rs.posts.length + envio(env.DIARIO).length, 0, "[AB11.3/b] sem dreno inline");
  }
});
test("AB11.4 estágio diferente de ativo (desligado, aquecimento): dreno sem SELF", async () => {
  for (const stage of ["desligado", "aquecimento", undefined]) {
    const env = makeEnv();
    env.SELF = drainSelf(env, "ativo");
    assert.deepEqual(await AB.dispatchAbandonmentDrain(env, { nowMs: T0, ...(stage ? { stage } : {}) }), { skipped: "disabled" }, "[AB11.4] " + stage);
    assert.equal(env.SELF.calls.length, 0, "[AB11.4/b] SELF não chamado: " + stage);
  }
});

// ------------------------------------------------------------------------------------------------- regressão webhook
const strip = (kv) => new Map([...kv.m.entries()].filter(([k]) => k !== "sales:hotmart:v1"));
for (const [id, events] of [["REG.1", ["PURCHASE_APPROVED"]], ["REG.2", ["PURCHASE_APPROVED", "PURCHASE_COMPLETE", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK"]]]) {
  test(`${id} /api/webhooks/hotmart ${events.join("+")}: mesma resposta e mesmo razão/atividade que o nc012 direto, D1 intocado`, async () => {
    const envA = makeEnv(), envB = makeEnv();
    for (const ev of events) {
      const p = purchase(ev, { txn: "HP-SINT-REG0001" });
      fresh();
      const a = await routeHotmartNc011(req(p), envA, {});
      const b = await handleDigitalHotmartNc012(req(p), envB, {});
      assert.deepEqual([a.status, await a.json()], [b.status, await b.json()], `[${id}] mesma resposta: ${ev}`);
    }
    const norm = (m) => JSON.stringify([...m.keys()].map((k) => k.replace(/:\d{13}:/, ":T:")).sort());
    assert.equal(norm(strip(envA.ZEVANORY_PRIVATE_ARTIFACTS)), norm(strip(envB.ZEVANORY_PRIVATE_ARTIFACTS)), `[${id}/b] mesmas chaves de razão e atividade`);
    assert.equal(abandonoSql(envA.DIARIO), 0, `[${id}/c] o desvio não toca as tabelas do abandono`);
    assert.equal(envA.DIARIO.rows("abandono_compra_v1").length, 0, `[${id}/d] sem marcador em desligado`);
  });
}
test("REG.3 CP e erros: mesma resposta do roteamento anterior (CP no DO, hottok errado, JSON inválido, 405)", async () => {
  const p = purchase("PURCHASE_APPROVED", { product: 8704905, txn: "HP-SINT-CP00002" });
  fresh();
  const a = await routeHotmartNc011(req(p), makeEnv(), {});
  const b = await handleCpDoWebhookCandidate(req(p), { ...makeEnv(), HOTMART_SERVICE_PRODUCT_IDS: "8704905" });
  assert.equal(a.status, b.status, "[REG.3] CP: mesmo status");
  assert.equal((await routeHotmartNc011(req(purchase(), { hottok: "errado-errado-errado" }), makeEnv(), {})).status, 401, "[REG.3/b] 401");
  assert.equal((await routeHotmartNc011(req(null, { raw: "{" }), makeEnv(), {})).status, 400, "[REG.3/c] 400");
  assert.equal((await routeHotmartNc011(new Request(URL_WEBHOOK), makeEnv(), {})).status, 405, "[REG.3/d] 405");
});
test("REG.4 Worker central real (compat): abandono 200 disabled; cron às 06 UTC sem SELF do abandono, D1/KV do abandono intocados", () => {
  const p = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/abandono-worker-probe.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 150000 });
  const line = String(p.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  assert.ok(line, "[REG.4/z] sonda sem resultado: " + String(p.stderr || "").slice(-400));
  const out = JSON.parse(line.slice("PROBE_RESULT ".length));
  assert.deepEqual([out.webhook?.status, out.webhook?.body?.code], [200, "disabled"], "[REG.4] webhook real");
  assert.equal(out.optout, 503, "[REG.4/b] descadastro inativo");
  assert.ok(!out.selfPaths.some((s) => s.includes("abandono")), "[REG.4/c] sem SELF do abandono: " + out.selfPaths.join(","));
  assert.deepEqual([out.abandonoD1, out.abandonoKv], [[], []], "[REG.4/d] D1 e KV do abandono intocados");
});

// ------------------------------------------------------------------------------------------------- AB8 logs
test("AB8.2 pendência sem nome, telefone, IP ou país", async () => {
  const env = makeEnv();
  await ingest(env, abandon());
  const pend = JSON.parse(await pendOf(env));
  assert.deepEqual(Object.keys(pend).sort(), ["due_at", "email", "product_id", "received_at", "slug"], "[AB8.2]");
  assert.ok(!/Fulano|9000|203\.0\.113|Pais/.test(JSON.stringify(pend)), "[AB8.2/b]");
});
test("AB8.1 nenhum log com e-mail, ref, hottok, token, nome ou corpo em todos os casos acima", async () => {
  const refs = await Promise.all([EMAIL, "outra.pessoa@example.com", ...Array.from({ length: 5 }, (_, i) => `pessoa${i}@example.com`)].map((e) => refOf(e)));
  const forbidden = [...SECRETS_SEEN, EMAIL, "example.com", "Fulano", "Olá!", "Por que você recebeu", ...refs.map((r) => r.slice(0, 24)), "test-resend-"];
  const lines = CAPTURED.lines;
  assert.ok(lines.length > 50, "[AB8.1/z] captura ativa: " + lines.length);
  for (const l of lines) {
    for (const f of forbidden) assert.ok(!l.includes(f), "[AB8.1] log com valor proibido: " + l.slice(0, 80));
    if (/^abandono_/.test(l)) assert.ok(!/@|[0-9a-f]{32,}/i.test(l), "[AB8.1/b] log do abandono com e-mail ou hex: " + l.slice(0, 80));
  }
});
