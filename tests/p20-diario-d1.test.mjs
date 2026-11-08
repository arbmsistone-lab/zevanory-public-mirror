// P20 (Roteiro Mestre v4.7, seção 9.1): diário de eventos críticos no D1 (worker/diario-p20.mjs +
// migrations/d1/0001_diario_v1.sql). O D1 é falso mas executa SQL de verdade (node:sqlite) com a migração real,
// inclusive os triggers. Sem rede, sem segredo, sem Cloudflare. Marcadores [DJn.k] usados pelos mutantes
// (scripts/ci/mutants_p20_diario.py).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { createD1 } from "./helpers/d1-sqlite.mjs";
import {
  TIPOS, GENESIS_HASH, DIARIO_SCHEMA, MAX_TENTATIVAS, eventKey, payloadSha, chainHash, canonicalJson, assertNoPii,
  appendEvent, verifyChain,
} from "../worker/diario-p20.mjs";

const MIGRATION = readTextNormalized(new URL("../migrations/d1/0001_diario_v1.sql", import.meta.url));
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
const EMAIL_SHA = createHash("sha256").update("cliente@example.com").digest("hex");
const sha = (s) => createHash("sha256").update(s).digest("hex");
// Fórmula documentada (docs/p20/diario-d1.md), recalculada aqui SEM o módulo: prova o algoritmo, não só a coerência.
const refChain = (prev, key, psha, ts) => sha([DIARIO_SCHEMA, prev, key, psha, String(ts)].join("\n"));

function sampleEvents(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const tipo = TIPOS[i % TIPOS.length];
    const ord = `ord_${1000 + i}`;
    out.push({
      tipo, ref: ord, ts_ms: T0 + i * 1000,
      event_key: eventKey(tipo, ord, `n${i}`),
      payload: { order_id: ord, valor_centavos: 4990 + i, status: i % 2 ? "approved" : "pending", email_sha: EMAIL_SHA, itens: [{ sku: "kit-a", qtd: 1 }], em: new Date(T0 + i).toISOString() },
    });
  }
  return out;
}

async function filled(n) {
  const db = createD1(MIGRATION);
  const evs = sampleEvents(n);
  for (const ev of evs) {
    const r = await appendEvent(db, ev);
    assert.equal(r.ok, true, "falha ao preparar: " + JSON.stringify(r));
  }
  return { db, evs };
}

test("DJ1 encadeamento: N eventos encadeados na genesis, hash pela fórmula independente, verifyChain ok", async () => {
  assert.deepEqual([...TIPOS], ["order_created", "payment_status", "delivery_sent", "refund", "consent_given", "consent_confirmed", "consent_revoked", "erase", "fiscal_ref"], "[DJ1.1] tipos da seção 9.1");
  assert.equal(eventKey("payment_status", "ord_1", "mp_9", "approved"), "payment_status:ord_1:mp_9:approved", "[DJ1.2] chave determinística");
  assert.equal(await payloadSha({ b: 1, a: { d: [1, 2], c: "x" } }), await payloadSha({ a: { c: "x", d: [1, 2] }, b: 1 }), "[DJ1.3] payload_sha independe da ordem das chaves");
  assert.equal(await payloadSha({ a: 1 }), sha('{"a":1}'), "[DJ1.4] payload_sha = sha256 do JSON canônico");
  const k = "order_created:ord_1:n0";
  assert.equal(await chainHash(GENESIS_HASH, k, sha("{}"), T0), refChain(GENESIS_HASH, k, sha("{}"), T0), "[DJ1.5] chainHash = fórmula documentada");
  assert.notEqual(await chainHash(GENESIS_HASH, k, sha("{}"), T0), await chainHash("1".repeat(64), k, sha("{}"), T0), "[DJ1.6] prev_hash entra no hash");

  const N = 25;
  const { db, evs } = await filled(N);
  const rows = db.rows();
  assert.equal(rows.length, N);
  assert.equal(rows[0].prev_hash, GENESIS_HASH, "[DJ1.7] primeira linha encadeia na genesis");
  let prev = GENESIS_HASH;
  rows.forEach((r, i) => {
    assert.equal(r.seq, i + 1);
    assert.equal(r.event_key, evs[i].event_key);
    assert.equal(r.payload_json, canonicalJson(evs[i].payload));
    assert.equal(r.payload_sha, sha(r.payload_json));
    assert.equal(r.prev_hash, prev, "[DJ1.8] prev_hash = chain_hash da linha anterior");
    assert.equal(r.chain_hash, refChain(prev, r.event_key, r.payload_sha, r.ts_ms), "[DJ1.9] chain_hash recalculado de fora confere");
    prev = r.chain_hash;
  });
  assert.deepEqual(db.head(), { seq: N, chain_hash: prev }, "[DJ1.10] cabeça = última linha");
  const v = await verifyChain(rows, { head: db.head() });
  assert.deepEqual(v, { ok: true, broken_at: null, count: N, head: { seq: N, chain_hash: prev } }, "[DJ1.11]");
  const parcial = await verifyChain(rows.slice(10), { from: { seq: rows[9].seq, chain_hash: rows[9].chain_hash }, head: db.head() });
  assert.equal(parcial.ok, true, "[DJ1.12] verificação a partir de um ponto conferido");
});

test("DJ2 adulteração: payload, hash, ordem, remoção e corte do fim são detectados com a linha", async () => {
  const { db } = await filled(8);
  const rows = db.rows();
  const t1 = structuredClone(rows); t1[3].payload_json = t1[3].payload_json.replace('"valor_centavos":4993', '"valor_centavos":1');
  assert.deepEqual(await verifyChain(t1), { ok: false, broken_at: 4, reason: "payload_sha" }, "[DJ2.1] payload adulterado");
  const t2 = structuredClone(rows); t2[3].payload_json = t2[3].payload_json.replace('"valor_centavos":4993', '"valor_centavos":1'); t2[3].payload_sha = sha(t2[3].payload_json);
  assert.deepEqual(await verifyChain(t2), { ok: false, broken_at: 4, reason: "chain_hash" }, "[DJ2.2] payload e payload_sha refeitos, cadeia não");
  const t3 = structuredClone(rows); [t3[2], t3[5]] = [t3[5], t3[2]];
  const v3 = await verifyChain(t3);
  assert.ok(!v3.ok && v3.broken_at === 6, "[DJ2.3] ordem trocada");
  const t4 = structuredClone(rows); t4.splice(4, 1);
  const v4 = await verifyChain(t4);
  assert.ok(!v4.ok && v4.broken_at === 6, "[DJ2.4] linha removida");
  const t5 = structuredClone(rows); t5[6].chain_hash = "f".repeat(64);
  assert.equal((await verifyChain(t5)).broken_at, 7, "[DJ2.5] chain_hash forjado");
  const t6 = structuredClone(rows); for (const r of t6) r.seq = r.seq + 0; t6[0].prev_hash = "1".repeat(64);
  assert.deepEqual(await verifyChain(t6), { ok: false, broken_at: 1, reason: "prev_hash" }, "[DJ2.6] genesis forjada");
  const v7 = await verifyChain(rows.slice(0, 6), { head: db.head() });
  assert.deepEqual(v7, { ok: false, broken_at: 7, reason: "cabeca_divergente" }, "[DJ2.7] fim cortado não passa contra a cabeça");
  const t8 = structuredClone(rows); t8[1].ts_ms = t8[1].ts_ms + 1;
  assert.equal((await verifyChain(t8)).broken_at, 2, "[DJ2.8] ts_ms adulterado");
  const t9 = structuredClone(rows); t9[2].payload_json = JSON.stringify(JSON.parse(t9[2].payload_json), null, 1); t9[2].payload_sha = sha(t9[2].payload_json);
  assert.equal((await verifyChain(t9)).reason, "payload_nao_canonico", "[DJ2.9]");
});

test("DJ3 idempotência: mesma event_key com o mesmo payload é duplicada sem gravar nada", async () => {
  const { db, evs } = await filled(3);
  const before = db.head();
  const again = await appendEvent(db, { ...evs[1], payload: Object.fromEntries(Object.entries(evs[1].payload).reverse()) });
  assert.deepEqual(again, { ok: true, duplicate: true }, "[DJ3.1] duplicada idempotente");
  assert.deepEqual(await appendEvent(db, evs[2]), { ok: true, duplicate: true }, "[DJ3.2]");
  assert.equal(db.rows().length, 3, "[DJ3.3] nenhuma linha nova");
  assert.deepEqual(db.head(), before, "[DJ3.4] cabeça intacta");
});

test("DJ4 conflito: mesma event_key com payload diferente é recusada e nunca sobrescreve", async () => {
  const { db, evs } = await filled(3);
  const before = db.rows();
  const r = await appendEvent(db, { ...evs[0], payload: { ...evs[0].payload, valor_centavos: 1 } });
  assert.deepEqual(r, { ok: false, code: "diario_conflito" }, "[DJ4.1] conflito");
  assert.deepEqual(db.rows(), before, "[DJ4.2] nada alterado");
  assert.equal((await verifyChain(db.rows(), { head: db.head() })).ok, true, "[DJ4.3]");
});

test("DJ5 corrida: cabeça muda entre a leitura e a escrita; nova tentativa sem quebrar a cadeia", async () => {
  const db = createD1(MIGRATION);
  const [a, b, c] = sampleEvents(3);
  assert.equal((await appendEvent(db, a)).ok, true);
  db.hooks.beforeBatch = async (n) => { if (n === 2) { db.hooks.beforeBatch = null; assert.equal((await appendEvent(db, b)).ok, true); } };
  const r = await appendEvent(db, c);
  assert.equal(r.ok, true, "[DJ5.1] corrida resolvida");
  assert.equal(r.duplicate, false);
  assert.equal(r.tentativas, 2, "[DJ5.2] segunda tentativa");
  const rows = db.rows();
  assert.deepEqual(rows.map((x) => x.event_key), [a.event_key, b.event_key, c.event_key], "[DJ5.3] as duas escritas existem, em ordem");
  assert.equal(r.seq, 3);
  assert.deepEqual(await verifyChain(rows, { head: db.head() }), { ok: true, broken_at: null, count: 3, head: db.head() }, "[DJ5.4] cadeia íntegra após a corrida");

  // corrida persistente: esgota as tentativas e não grava a própria linha
  const extra = sampleEvents(3 + MAX_TENTATIVAS + 1).slice(3);
  let k = 0;
  db.hooks.beforeBatch = async () => {
    const h = db.hooks.beforeBatch; db.hooks.beforeBatch = null;
    assert.equal((await appendEvent(db, extra[1 + k++])).ok, true);
    db.hooks.beforeBatch = h;
  };
  const lost = await appendEvent(db, extra[0]);
  db.hooks.beforeBatch = null;
  assert.deepEqual(lost, { ok: false, code: "diario_corrida" }, "[DJ5.5] corrida persistente falha fechada");
  assert.equal(k, MAX_TENTATIVAS, "[DJ5.6] exatamente MAX_TENTATIVAS tentativas");
  assert.ok(!db.rows().some((x) => x.event_key === extra[0].event_key), "[DJ5.7] nada gravado da escrita perdida");
  assert.equal((await verifyChain(db.rows(), { head: db.head() })).ok, true, "[DJ5.8]");

  // corrida com a MESMA chave: outro escritor grava a mesma event_key -> duplicada; payload diferente -> conflito
  const [d] = sampleEvents(40).slice(30);
  db.hooks.beforeBatch = async () => { db.hooks.beforeBatch = null; assert.equal((await appendEvent(db, d)).ok, true); };
  assert.deepEqual(await appendEvent(db, d), { ok: true, duplicate: true }, "[DJ5.9] mesma chave em corrida = duplicada");
  const [e] = sampleEvents(41).slice(40);
  db.hooks.beforeBatch = async () => { db.hooks.beforeBatch = null; assert.equal((await appendEvent(db, e)).ok, true); };
  assert.deepEqual(await appendEvent(db, { ...e, payload: { ...e.payload, status: "refunded" } }), { ok: false, code: "diario_conflito" }, "[DJ5.10] mesma chave e payload diferente em corrida = conflito");
  assert.equal((await verifyChain(db.rows(), { head: db.head() })).ok, true, "[DJ5.11]");
});

test("DJ6 LGPD: e-mail, CPF, telefone e chaves de dado pessoal recusados antes de gravar", async () => {
  const db = createD1(MIGRATION);
  const [base] = sampleEvents(1);
  const bad = [
    ["email", { contato: "cliente@example.com" }],
    ["email", { a: { b: ["ok", "x <Cliente.Nome+tag@mail.example.com.br>"] } }],
    ["cpf", { doc: "123.456.789-09" }],
    ["cpf", { doc: "12345678909" }],
    ["telefone", { contato: "(11) 98765-4321" }],
    ["telefone", { contato: "+55 11 98765 4321" }],
    ["telefone", { contato: "1132654321" }],
    ["chave", { email: "x" }],
    ["chave", { customerEmail: "x" }],
    ["chave", { nome: "Fulano" }],
    ["chave", { comprador: { first_name: "x" } }],
    ["chave", { cpf: "x" }],
    ["chave", { telefone: "x" }],
  ];
  for (const [kind, payload] of bad) {
    assert.throws(() => assertNoPii(payload), (e) => e.code === "diario_pii", `[DJ6.1] ${kind} ${JSON.stringify(Object.keys(payload))}`);
    const r = await appendEvent(db, { ...base, payload });
    assert.deepEqual(r, { ok: false, code: "diario_pii" }, `[DJ6.2] ${kind} recusado por appendEvent`);
  }
  assert.throws(() => assertNoPii({ doc: "529.982.247-25" }), (e) => /cpf/.test(e.message), "[DJ6.3] CPF identificado como CPF");
  assert.equal(db.rows().length, 0, "[DJ6.4] nada gravado");
  assert.deepEqual(db.head(), { seq: 0, chain_hash: GENESIS_HASH }, "[DJ6.5] cabeça genesis intacta");
  assert.equal(db.batches, 0, "[DJ6.6] recusado antes de qualquer escrita no D1");
  // permitido: hash do e-mail, datas ISO, valores, namespace, ids com letras
  assert.equal(assertNoPii({ email_sha: EMAIL_SHA, emailHash: EMAIL_SHA, em: new Date(T0).toISOString(), valor_centavos: 12345678909, namespace: "p", order_id: "ord_9f3a", ts_ms: T0 }), true, "[DJ6.7] substitutos permitidos");
  assert.throws(() => eventKey("consent_given", "a@b.co"), (e) => e.code === "diario_chave_invalida", "[DJ6.8] e-mail nunca na chave");
  assert.throws(() => eventKey("consent_given", "11987654321"), (e) => e.code === "diario_pii", "[DJ6.9] telefone nunca na chave");
  assert.deepEqual(await appendEvent(db, { ...base, ref: "11987654321" }), { ok: false, code: "diario_ref_invalida" }, "[DJ6.10] ref com telefone recusada");
  assert.deepEqual(await appendEvent(db, { ...base, tipo: "pedido_qualquer" }), { ok: false, code: "diario_tipo_invalido" }, "[DJ6.11]");
});

test("DJ7 somente inclusão: triggers da migração bloqueiam UPDATE e DELETE; a cabeça só avança", async () => {
  const { db } = await filled(3);
  const rows = db.rows();
  assert.throws(() => db.raw.exec("update diario_v1 set payload_json = '{}' where seq = 2"), /diario_v1_somente_inclusao/, "[DJ7.1] UPDATE bloqueado");
  assert.throws(() => db.raw.exec("delete from diario_v1 where seq = 3"), /diario_v1_somente_inclusao/, "[DJ7.2] DELETE bloqueado");
  assert.throws(() => db.raw.exec("delete from diario_v1"), /diario_v1_somente_inclusao/, "[DJ7.3] DELETE em massa bloqueado");
  assert.throws(() => db.raw.exec("update diario_head set seq = 1 where id = 1"), /diario_head_so_avanca/, "[DJ7.4] cabeça não volta");
  assert.throws(() => db.raw.exec("delete from diario_head"), /diario_head_sem_delete/, "[DJ7.5]");
  assert.throws(() => db.raw.exec("insert into diario_head (id, seq, chain_hash) values (2, 0, 'x')"), /CHECK/, "[DJ7.6] uma cabeça só");
  assert.throws(() => db.raw.exec(`insert into diario_v1 (event_key, tipo, ts_ms, payload_json, payload_sha, prev_hash, chain_hash) values ('${rows[0].event_key}', 'refund', 1, '{}', 'x', 'y', 'z')`), /UNIQUE/, "[DJ7.7] event_key única");
  assert.deepEqual(db.rows(), rows, "[DJ7.8] nada mudou");
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS diario_v1 \(\n  seq INTEGER PRIMARY KEY AUTOINCREMENT,\n  event_key TEXT UNIQUE NOT NULL,/, "[DJ7.9] esquema");
  assert.match(MIGRATION, /VALUES \(1, 0, '0{64}'\)/, "[DJ7.10] genesis de 64 zeros");
});

test("DJ8 falhas do D1 e isolamento: indisponível e sem cabeça falham fechado; Worker de produção não importa o módulo", async () => {
  const db = createD1(MIGRATION);
  const [ev] = sampleEvents(1);
  db.hooks.failBatch = true;
  assert.deepEqual(await appendEvent(db, ev), { ok: false, code: "diario_indisponivel" }, "[DJ8.1] D1 indisponível");
  assert.equal(db.batches, MAX_TENTATIVAS, "[DJ8.2] tenta MAX_TENTATIVAS vezes");
  assert.equal(db.rows().length, 0);
  const sem = createD1(MIGRATION.replace(/INSERT OR IGNORE INTO diario_head[^;]*;/, ""));
  assert.deepEqual(await appendEvent(sem, ev), { ok: false, code: "diario_sem_cabeca" }, "[DJ8.3]");
  assert.deepEqual(await appendEvent(db, { ...ev, ts_ms: 1.5 }), { ok: false, code: "diario_ts_invalido" }, "[DJ8.4]");
  assert.deepEqual(await appendEvent(db, { ...ev, event_key: "refund:ord_1" }), { ok: false, code: "diario_chave_invalida" }, "[DJ8.5] chave de outro tipo");
  const src = readTextNormalized(new URL("../worker/diario-p20.mjs", import.meta.url));
  assert.doesNotMatch(src, /^\s*import\s/m, "[DJ8.6] módulo puro, sem dependência");
  const workerDir = new URL("../worker/", import.meta.url);
  const importers = readdirSync(workerDir).filter((f) => /\.m?js$/.test(f) && f !== "diario-p20.mjs")
    .filter((f) => /diario-p20/.test(readTextNormalized(new URL(f, workerDir))));
  // PR 3 (docs/p20/diario-d1.md, "Gravação em modo sombra"): só o adaptador de sombra importa o módulo puro.
  // PR 4 ("Reconciliação diária"): a reconciliação importa só verifyChain (leitura); nenhum outro módulo usa o diário.
  assert.deepEqual(importers, ["diario-reconcilia.mjs", "diario-sombra.mjs"], "[DJ8.7] só worker/diario-sombra.mjs e worker/diario-reconcilia.mjs usam o diário");
  assert.match(readTextNormalized(new URL("diario-reconcilia.mjs", workerDir)), /^import \{ verifyChain \} from "\.\/diario-p20\.mjs";$/m, "[DJ8.8] a reconciliação só lê (verifyChain)");
});
