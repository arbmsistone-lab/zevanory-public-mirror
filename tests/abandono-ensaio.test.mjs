// Ensaios do lembrete de abandono Hotmart (PR-3 do plano de abandono): concorrência, supressão, retenção e
// reconciliação paginada, no SQLite real (node:sqlite) com as migrações reais de migrations/d1. Sem rede.
//  EN1 200 reservas concorrentes no mesmo dia produzem EXATAMENTE 20 (teto atômico na instrução única); o mesmo
//      harness com leitura + gravação separadas passa do teto (prova de que o ensaio detecta a corrida).
//  EN2 200 reservas concorrentes da MESMA pessoa: 1 dona.
//  EN3 supressão: gatilhos impedem UPDATE/DELETE em massa, REPLACE fica proibido em todo worker/ e migrations/,
//      descadastro repetido é idempotente e a retenção nunca toca a supressão.
//  EN4 retenção: 1.000 linhas de idades variadas, fronteira de 30 dias exata, segunda execução idempotente.
//  EN5 reconciliação paginada: alvo em cada página de 1 a RECONCILE_MAX_PAGES é achado; além do limite, incompleta;
//      parada antecipada ao passar do início da janela; o mesmo id repetido em páginas conta uma vez; duplicata em
//      páginas diferentes é ambígua.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { createAbandonoD1, memKv, captureConsole } from "./helpers/abandono-fakes.mjs";
import * as AB from "../worker/abandono-hotmart.mjs";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60_000, D = 86400_000;
const SECRET = "test-privacy-" + "p".repeat(36); // sintético, gerado em runtime
const EMAIL = "comprador.teste@example.com";
const hex64 = (i) => i.toString(16).padStart(64, "0");
const CAPTURED = captureConsole();
test.after(() => CAPTURED.restore());

test("EN1 200 reservas concorrentes no mesmo dia: exatamente 20 donas e 20 linhas", async () => {
  const d1 = createAbandonoD1();
  const env = { DIARIO: d1 };
  const outs = await Promise.all(Array.from({ length: 200 }, (_, i) => AB.reserveSend(env, { ref: hex64(i + 1), slug: "ia-na-pratica", now: T0 + i, bodySha: "s".repeat(64) })));
  assert.ok(outs.every((o) => o.ok === true), "[EN1/.0] D1 disponível em todas");
  assert.equal(outs.filter((o) => o.value === 1).length, AB.ABANDONO_DAILY_CAP, "[EN1] exatamente 20 com changes 1");
  assert.equal(d1.rows("abandono_envio_v1").length, AB.ABANDONO_DAILY_CAP, "[EN1/b] 20 linhas");
  assert.ok(d1.stats.writes >= 200, "[EN1/c] as 200 instruções chegaram ao banco");
  // Controle: o mesmo harness com leitura e gravação separadas fura o teto (a corrida é real no ensaio).
  const naive = createAbandonoD1();
  await Promise.all(Array.from({ length: 200 }, async (_, i) => {
    const n = await naive.prepare("SELECT count(*) AS n FROM abandono_envio_v1 WHERE dia=?1").bind("2026-11-09").first("n");
    if (n < AB.ABANDONO_DAILY_CAP) await naive.prepare("INSERT INTO abandono_envio_v1 (ref,slug,dia,estado,criado_ms,lease_ms,tentativas,body_sha) VALUES (?1,'ia-na-pratica','2026-11-09','reservado',?2,?2,1,'s')").bind(hex64(i + 1), T0).run();
  }));
  assert.ok(naive.rows("abandono_envio_v1").length > AB.ABANDONO_DAILY_CAP, "[EN1/d] controle: leitura + gravação separadas passam do teto");
});
test("EN2 200 reservas concorrentes da mesma pessoa: uma única dona", async () => {
  const d1 = createAbandonoD1();
  const outs = await Promise.all(Array.from({ length: 200 }, (_, i) => AB.reserveSend({ DIARIO: d1 }, { ref: hex64(7), slug: "ia-na-pratica", now: T0 + i, bodySha: "s".repeat(64) })));
  assert.equal(outs.filter((o) => o.value === 1).length, 1, "[EN2] 1 dona");
  assert.equal(d1.rows("abandono_envio_v1").length, 1, "[EN2/b] 1 linha");
});
test("EN2b compra e supressão gravadas no meio das 200 reservas: nenhuma reserva depois delas", async () => {
  const d1 = createAbandonoD1();
  const env = { DIARIO: d1 };
  const ref = hex64(9);
  const order = [];
  const tasks = Array.from({ length: 200 }, (_, i) => (async () => {
    if (i === 50) { d1.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", ref, T0); order.push("compra"); }
    const r = await AB.reserveSend(env, { ref, slug: "ia-na-pratica", now: T0 + i, bodySha: "s".repeat(64) });
    if (r.value === 1) order.push("reserva");
  })());
  await Promise.all(tasks);
  assert.deepEqual(order, ["compra"], "[EN2b/c] a compra (gravada antes da primeira reserva executar) barra todas");
});
test("EN3 supressão: gatilhos, REPLACE proibido no repositório, descadastro idempotente, retenção não toca", async () => {
  const d1 = createAbandonoD1();
  for (let i = 0; i < 100; i++) d1.sql("INSERT OR IGNORE INTO abandono_supressao_v1 (ref, criado_ms) VALUES (?, ?)", hex64(i + 1), T0 - i * 40 * D);
  assert.throws(() => d1.sql("UPDATE abandono_supressao_v1 SET criado_ms = criado_ms + 1"), /abandono_supressao_v1_permanente/, "[EN3] UPDATE em massa aborta");
  assert.throws(() => d1.sql("DELETE FROM abandono_supressao_v1 WHERE criado_ms < ?", T0), /abandono_supressao_v1_permanente/, "[EN3/b] DELETE em massa aborta");
  assert.equal(d1.rows("abandono_supressao_v1").length, 100, "[EN3/c] 100 linhas intactas");
  const env = { LEAD_PRIVACY_SECRET: SECRET, DIARIO: d1, ZEVANORY_PRIVATE_ARTIFACTS: memKv() };
  const ref = await AB.abandonoRef(env, EMAIL), t = await AB.optOutToken(env, ref);
  for (let i = 0; i < 3; i++) {
    const r = await AB.handleAbandonmentOptOut(new Request(`https://zevanory.api.br/abandono/sair?r=${ref}&t=${t}`), env, { now: T0 + i, stage: "ativo" });
    assert.equal(r.status, 200, "[EN3/d] descadastro repetido: " + i);
  }
  assert.equal(d1.rows("abandono_supressao_v1").filter((r) => r.ref === ref).map((r) => r.criado_ms).join(), String(T0), "[EN3/e] INSERT OR IGNORE mantém a primeira");
  const ret = await AB.runAbandonmentRetention(env, { now: T0 + 400 * D, stage: "ativo" });
  assert.equal(ret.ok, true, "[EN3/h] retenção ok");
  assert.equal(d1.rows("abandono_supressao_v1").length, 101, "[EN3/f] retenção não apaga supressão");
  const files = [...readdirSync(new URL("../worker/", import.meta.url)).filter((f) => f.endsWith(".mjs")).map((f) => "../worker/" + f), ...readdirSync(new URL("../migrations/d1/", import.meta.url)).map((f) => "../migrations/d1/" + f)];
  for (const f of files) {
    const src = readTextNormalized(new URL(f, import.meta.url));
    assert.ok(!/(?:REPLACE\s+INTO|INSERT\s+OR\s+REPLACE\s+INTO)\s+abandono_supressao_v1|abandono_supressao_v1[^;`"]*ON\s+CONFLICT[^;`"]*DO\s+UPDATE/i.test(src), "[EN3/g] REPLACE/UPSERT na supressão: " + f);
  }
});
test("EN4 retenção: 1.000 linhas, fronteira de 30 dias exata, segunda execução idempotente", async () => {
  const d1 = createAbandonoD1({ yieldEach: false });
  const now = T0, cut = now - 30 * D;
  let expEnvio = 0, expCompra = 0;
  for (let i = 0; i < 500; i++) {
    const age = (i % 60) * D + (i % 7) * MIN; // 0 a 59 dias
    const criado = now - age;
    d1.sql("INSERT INTO abandono_envio_v1 (ref,slug,dia,estado,criado_ms,lease_ms,tentativas,body_sha) VALUES (?,?,?,?,?,?,?,?)", hex64(i + 1), "ia-na-pratica", new Date(criado).toISOString().slice(0, 10), ["enviado", "nao_confirmado", "cancelado", "reconciliar", "reservado"][i % 5], criado, criado, 1, "s");
    d1.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", hex64(10_000 + i), criado);
    if (criado < cut) { expEnvio++; expCompra++; }
  }
  d1.sql("INSERT INTO abandono_compra_v1 (ref, criado_ms) VALUES (?, ?)", hex64(99_999), cut); // exatamente 30 dias: fica
  const env = { DIARIO: d1, ZEVANORY_PRIVATE_ARTIFACTS: memKv() };
  const first = await AB.runAbandonmentRetention(env, { now, stage: "aquecimento" });
  assert.deepEqual([first.ok, first.apagadas_envio, first.apagadas_compra], [true, expEnvio, expCompra], "[EN4] apaga só o que passou de 30 dias");
  assert.ok(d1.rows("abandono_envio_v1").every((r) => r.criado_ms >= cut) && d1.rows("abandono_compra_v1").every((r) => r.criado_ms >= cut), "[EN4/b] nada mais velho que 30 dias");
  assert.ok(d1.rows("abandono_compra_v1").some((r) => r.criado_ms === cut), "[EN4/c] fronteira exata preservada");
  assert.ok(first.idade_max_envio_dias <= 30 && first.idade_max_compra_dias <= 30, "[EN4/d] idade máxima <= 30");
  assert.equal(first.alerta, undefined, "[EN4/e] sem alerta");
  const second = await AB.runAbandonmentRetention(env, { now, stage: "ativo" });
  assert.deepEqual([second.apagadas_envio, second.apagadas_compra], [0, 0], "[EN4/f] idempotente");
});

const SUBJECT = AB.abandonmentSubject("IA na Prática");
const iso = (ms) => new Date(ms).toISOString();
function pagedResend(items, { retrieve = {} } = {}) {
  const gets = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    gets.push(u.pathname + u.search);
    if (u.pathname === "/emails") {
      const after = u.searchParams.get("after"), limit = Number(u.searchParams.get("limit"));
      const from = after ? items.findIndex((x) => x.id === after) + 1 : 0;
      return Response.json({ object: "list", has_more: from + limit < items.length, data: items.slice(from, from + limit) });
    }
    const id = decodeURIComponent(u.pathname.slice("/emails/".length));
    const hit = retrieve[id];
    return hit ? Response.json({ id, ...hit }) : Response.json({ name: "not_found" }, { status: 404 });
  };
  return { fetchImpl, gets };
}
test("EN5 reconciliação paginada: alvo em cada página até o limite; além dele, incompleta", async () => {
  const ref = await AB.abandonoRef({ LEAD_PRIVACY_SECRET: SECRET }, EMAIL);
  const criadoMs = T0;
  const tags = [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }];
  for (let page = 1; page <= AB.RECONCILE_MAX_PAGES + 1; page++) {
    const n = page * 100;
    const items = Array.from({ length: n }, (_, i) => ({ id: "it-" + i, to: ["x" + i + "@example.com"], subject: "Outro", created_at: iso(criadoMs + 20 * 3600_000 - i * 1000) }));
    items[n - 1] = { id: "alvo", to: [EMAIL], subject: SUBJECT, created_at: iso(criadoMs + 20 * 3600_000 - (n - 1) * 1000) };
    const rs = pagedResend(items, { retrieve: { alvo: { to: [EMAIL], subject: SUBJECT, tags } } });
    const out = await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs.fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs });
    if (page <= AB.RECONCILE_MAX_PAGES) assert.deepEqual(out, { found: "alvo" }, "[EN5] achado na página " + page);
    else assert.deepEqual(out, { incomplete: "pages" }, "[EN5/b] além do limite de páginas: incompleta");
  }
});
test("EN5c parada antecipada, id repetido conta uma vez, duplicata em páginas diferentes é ambígua", async () => {
  const ref = await AB.abandonoRef({ LEAD_PRIVACY_SECRET: SECRET }, EMAIL);
  const criadoMs = T0;
  const tags = [AB.RESEND_TAG, { name: "abandono_ref", value: ref.slice(0, 40) }];
  // 1.000 itens, o alvo na 1ª página e itens anteriores à janela a partir da 2ª: lê só 2 páginas.
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: "ok-" + i, to: ["z@example.com"], subject: "Outro", created_at: iso(i < 150 ? criadoMs + 60_000 * (150 - i) : criadoMs - 120_000 - i * 1000) }));
  items[3] = { id: "alvo", to: [EMAIL], subject: SUBJECT, created_at: iso(criadoMs + 60_000) };
  const rs = pagedResend(items, { retrieve: { alvo: { to: [EMAIL], subject: SUBJECT, tags } } });
  assert.deepEqual(await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs.fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs }), { found: "alvo" }, "[EN5c] achado");
  assert.equal(rs.gets.filter((g) => g.startsWith("/emails?")).length, 2, "[EN5c/d] para ao passar do início da janela");
  // O mesmo id em duas páginas (lista instável): uma confirmação.
  const rep = Array.from({ length: 150 }, (_, i) => ({ id: "rp-" + i, to: ["z@example.com"], subject: "Outro", created_at: iso(criadoMs + 3600_000 - i * 1000) }));
  rep[10] = { id: "alvo", to: [EMAIL], subject: SUBJECT, created_at: iso(criadoMs + 3600_000 - 10_000) };
  rep[120] = { ...rep[10] };
  const rs2 = pagedResend(rep, { retrieve: { alvo: { to: [EMAIL], subject: SUBJECT, tags } } });
  assert.deepEqual(await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs2.fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs }), { found: "alvo" }, "[EN5c/e] id repetido conta uma vez");
  // Duas confirmações em páginas diferentes: ambígua, nunca found.
  const dup = rep.map((x) => ({ ...x }));
  dup[120] = { id: "alvo2", to: [EMAIL], subject: SUBJECT, created_at: iso(criadoMs + 3600_000 - 120_000) };
  const rs3 = pagedResend(dup, { retrieve: { alvo: { to: [EMAIL], subject: SUBJECT, tags }, alvo2: { to: [EMAIL], subject: SUBJECT, tags } } });
  assert.deepEqual(await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs3.fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs }), { ambiguous: 2 }, "[EN5c/f] ambígua");
  // Segundo candidato sem a tag abandono_ref: só um confirma -> found (o outro não é deste titular).
  const rs4 = pagedResend(dup, { retrieve: { alvo: { to: [EMAIL], subject: SUBJECT, tags }, alvo2: { to: [EMAIL], subject: SUBJECT, tags: [AB.RESEND_TAG] } } });
  assert.deepEqual(await AB.reconcileLookup({ RESEND_API_KEY: "x" }, rs4.fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs }), { found: "alvo" }, "[EN5c/g] confirmação por id filtra");
  // Página com data ilegível em item do mesmo assunto: incompleta.
  const bad = rep.map((x) => ({ ...x })); bad[5] = { id: "ruim", to: [EMAIL], subject: SUBJECT, created_at: "ontem" };
  assert.deepEqual(await AB.reconcileLookup({ RESEND_API_KEY: "x" }, pagedResend(bad).fetchImpl, { ref, email: EMAIL, subject: SUBJECT, criadoMs }), { incomplete: "date" }, "[EN5c/h] data ilegível: incompleta");
});
