// ZEVANORY | P20 (seção 9.1): ensaio mensal da cópia KV -> Neon (estado comercial: trava, ledger, assinaturas CP).
// Evidência SINTETICA; sem rede, sem banco, sem segredo real. Prova que a lacuna "copia_kv_para_neon" só sai de
// not_covered com a prova COMPLETA: o Worker real grava a cópia a partir das linhas RELIDAS do Neon e o manifesto da
// FONTE (valor + TTL + metadados por chave); o ensaio confere a cópia, a restaura no Postgres efêmero (aqui, dublê da
// ponte que devolve as linhas relidas), reconstrói um KV com a semântica do Cloudflare e confere chave a chave.
// A ponta a ponta num PostgreSQL real está em tests/test_p20_restore_drill.py (testes 8 a 10).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";
import * as W from "../worker/data-backup.mjs";
import {
  NOT_COVERED, COPIA_KV_ID, KV_PREFIXES, KV_COPY_FORMAT, kvCopyKeyFor, kvEntryDigest, sha256, manifestHash, partReportKey, bundleKeyFor,
  buildRecord, validateRecord, notCoveredFor, assessKvCopy, kvProofComplete,
} from "../scripts/p20/restore-drill-lib.mjs";
import { planKvRestore, memKvReplay, kvRestoreDrill as kvRestoreDrillRaw } from "../scripts/p20/kv-memory-replay.mjs";
// Prefixos críticos: sempre a lista oficial (o módulo de reconstrução não tem prefixo de produção próprio).
const kvRestoreDrill = (rows, A, opts = {}) => kvRestoreDrillRaw(rows, A, { prefixes: KV_PREFIXES, ...opts });
import { runDrill as runDrillRaw, CF_ACCOUNT, NAMESPACE } from "../scripts/p20/restore-drill.mjs";
import { parseKeyring } from "../scripts/p20/backup-envelope.mjs";
import { makeBackup, KV_ROWS, kvRowsFull, DAY } from "./helpers/p20-backup-fixture.mjs";

const INVENTORY = JSON.parse(readTextNormalized(new URL("../docs/p20/inventario-estado-critico.json", import.meta.url)));
const ENV = { PGHOST: "localhost", PGDATABASE: "p20_drill", GITHUB_RUN_ID: "9", GITHUB_SHA: "abc" };
const NOW_ISO = "2026-11-02T07:23:00.000Z";
const NOW_S = Math.floor(Date.parse(NOW_ISO) / 1000);
const KV_LACUNA = (r) => r.not_covered.some((s) => s.startsWith(COPIA_KV_ID + ":"));
let tick = 0;
// Dublê da ponte Python: devolve as linhas da cópia "relidas do Postgres" (transform simula o que o banco devolveria).
const okRestore = (calls = [], transform = (rows) => rows) => async ({ tablesJson, kvCopy }) => {
  calls.push({ tables: Object.keys(tablesJson).sort(), kvCopy: !!kvCopy });
  return { ok: true, tables: Object.fromEntries(Object.entries(tablesJson).map(([t, js]) => [t, JSON.parse(js).length])), preserved_without_schema: [], worker_schema_ready: true,
    ...(kvCopy ? { kv_rows: transform(JSON.parse(kvCopy.json)) } : {}) };
};
// runDrill valida o próprio registro (validateRecord) e lança se ele for incoerente: vira asserção [RUN].
const runDrill = async (args) => { try { return await runDrillRaw(args); } catch (e) { assert.fail("[RUN] runDrill lançou: " + String(e?.message || e).slice(0, 80)); } };
const drill = async (kv, extra = {}) => {
  try { return await runDrillRaw({ mode: "sintetica", env: { ...ENV, ...(extra.env || {}) }, fixture: kv, restoreImpl: extra.restoreImpl || okRestore(), now: () => new Date(NOW_ISO), clock: () => (tick += 1000), inventory: INVENTORY }); }
  catch (e) { assert.fail("[RUN] runDrill lançou: " + String(e?.message || e).slice(0, 80)); }
};
const mut = (kv, k, fn) => { const o = JSON.parse(kv[k]); const r = fn(o); kv[k] = JSON.stringify(r === undefined ? o : r); return kv; };
const ck = kvCopyKeyFor(DAY);

// KV em memória com list devolvendo expiration/metadata (como o Cloudflare) e dublê de SQL que guarda a cópia
// zevanory_kv_backup com TTL e metadados e a devolve na releitura (corrupt: o Neon devolve um valor adulterado).
function fakeKv(seed = {}) {
  const m = new Map(), meta = new Map();
  for (const [k, v] of Object.entries(seed)) { if (v && typeof v === "object") { m.set(k, v.value); meta.set(k, { expiration: v.expiration, metadata: v.metadata }); } else m.set(k, v); }
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, ...(meta.get(name)?.expiration ? { expiration: meta.get(name).expiration } : {}), ...(meta.get(name)?.metadata ? { metadata: meta.get(name).metadata } : {}) })), list_complete: true }; } };
}
function fakeSql({ tables = { orders: [{ id: 1 }], zevanory_leads: [{ id: 2 }], telemetry_events: [] }, corrupt = false, lossyTtl = false } = {}) {
  const backup = [];
  const query = async (text, params = []) => {
    const t = text.trim();
    if (/^insert into zevanory_kv_backup/.test(t)) { const [day, k, v, h, e, md] = params; k.forEach((key, i) => backup.push({ snapshot_day: day, key, value: v[i], sha256: h[i], expiration: e[i] == null ? null : String(e[i]), metadata: md[i] })); return []; }
    if (/key, value, sha256, expiration, metadata from zevanory_kv_backup/.test(t)) return backup.filter((r) => r.snapshot_day === params[0]).sort((a, b) => (a.key < b.key ? -1 : 1)).map((r, i) => (corrupt && i === 0 ? { ...r, value: r.value + "#tampered" } : lossyTtl ? { ...r, expiration: null } : r));
    if (/from information_schema.tables/.test(t)) return Object.entries(tables).map(([n, rows]) => ({ t: n, n: rows.length }));
    if (/^with ins as/.test(t)) { const rows = JSON.parse(params[0]); return [{ n: rows.length, h: "same", hb: "same" }]; }
    if (/json_agg/.test(t)) return params[0].map((n) => ({ t: n, j: JSON.stringify(tables[n]) }));
    if (/string_agg\(r, ''\|''/.test(t)) return params[0].map((n) => ({ t: n, fp: "a".repeat(31) + String(tables[n].length % 10) }));
    return [];
  };
  return { factory: () => ({ query }), backup };
}
const KV_SEED = (nowS) => ({
  "sales:open:v1": JSON.stringify({ enabled: false }),
  "zpc:sales:v1:summary": JSON.stringify({ totals: { approved: 0 } }),
  "zpc:sales:v1:txn:00000000000000a1:approved": { value: "1", expiration: nowS + 400 * 86400 },
  "zpc:cp:sub:x": { value: JSON.stringify({ plan: "cp" }), metadata: { kind: "sub", v: 1 } },
  "zpc:interest:x": "pessoa@example.invalid",
});
const WNOW = Date.parse("2026-11-02T05:10:00Z");
// Executa o CÓDIGO REAL do Worker (3 partes + consolidado) e devolve o KV com o backup do dia.
async function workerBackup({ key = null, corrupt = false, lossyTtl = false } = {}) {
  const kv = fakeKv(KV_SEED(Math.floor(WNOW / 1000)));
  const s = fakeSql({ corrupt, lossyTtl });
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://u:p@h/db", ...(key ? { P20_BACKUP_KEY: key.toString("base64") } : {}) };
  const opts = key ? {} : { encryptionRequired: false };
  const reports = [];
  for (let part = 0; part < 3; part++) reports.push(await W.runDataBackup(env, { sqlFactory: s.factory, now: WNOW, part, parts: 3, ...opts }));
  const final = await W.finalizeBackup(env, { parts: 3, now: WNOW, ...opts });
  return { kv, reports, final, fixture: Object.fromEntries([...kv.m].filter(([k]) => k.startsWith("zpc:backup:v1:"))), backup: s.backup };
}

test("K1 Worker real grava a cópia do KV relida do Neon e o manifesto da fonte; o ensaio prova chave a chave e retira a lacuna", async () => {
  const { reports, final, fixture } = await workerBackup();
  assert.equal(final.ok, true, "[K1.0] " + JSON.stringify(final.failures));
  const kvr = reports[0].kv;
  assert.equal(kvr.keys, 4, "[K1.1] 4 chaves críticas; zpc:interest: (dado pessoal) fora da cópia");
  assert.deepEqual(kvr.copy, { format: KV_COPY_FORMAT, bundleKey: ck, rows: 4, sha: kvr.copy.sha }, "[K1.2]");
  assert.ok(typeof fixture[ck] === "string" && !fixture[ck].includes("pessoa@example.invalid"), "[K1.3] cópia no KV sem a chave de lead");
  const rows = JSON.parse(fixture[ck]);
  assert.ok(rows.find((r) => r.key === "zpc:sales:v1:txn:00000000000000a1:approved").expiration === Math.floor(WNOW / 1000) + 400 * 86400, "[K1.4] TTL absoluto copiado");
  assert.equal(rows.find((r) => r.key === "zpc:cp:sub:x").metadata, JSON.stringify({ kind: "sub", v: 1 }), "[K1.5] metadados copiados");
  const calls = [];
  const rec = await drill(fixture, { restoreImpl: okRestore(calls) });
  assert.equal(rec.verdict, "APROVADO", "[K1.6] " + rec.failures.join(","));
  assert.equal(calls[0].kvCopy, true, "[K1.7] cópia do KV enviada à restauração no Postgres efêmero");
  assert.deepEqual({ keys: rec.kv_copy.keys, restored: rec.kv_copy.restored, expired: rec.kv_copy.expired_at_restore, ttl: rec.kv_copy.with_ttl, meta: rec.kv_copy.with_metadata },
    { keys: 4, restored: 4, expired: 0, ttl: 1, meta: 1 }, "[K1.8]");
  assert.ok(rec.kv_copy.entries_manifest_ok && rec.kv_copy.values_hash_ok && rec.kv_copy.ttl_metadata_ok && rec.kv_copy.pg_rows_ok, "[K1.9]");
  assert.equal(KV_LACUNA(rec), false, "[K1.10] lacuna copia_kv_para_neon retirada só com a prova");
  assert.equal(rec.not_covered.length, NOT_COVERED.length - 1, "[K1.11] só essa lacuna sai (copia_cifrada continua: cópia em claro)");
  assert.doesNotThrow(() => validateRecord(structuredClone(rec)), "[K1.11b]");
  assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(rec)) && !JSON.stringify(rec).includes("approved\":0"), "[K1.12] registro sem hash completo nem valor do KV");
});

test("K2 a cópia vem do NEON (não da fonte): Neon divergente fica na cópia, o Worker acusa e o ensaio reprova sem retirar a lacuna", async () => {
  const { reports, fixture } = await workerBackup({ corrupt: true });
  assert.ok(reports[0].failures.some((f) => /^kv_copy_integrity:1:0$/.test(f)), "[K2.1] ensaio diário do Worker acusa a divergência");
  assert.match(fixture[ck], /#tampered/, "[K2.2] o bundle carrega o que o Neon devolveu, nunca a fonte");
  const calls = [];
  const rec = await drill(fixture, { restoreImpl: okRestore(calls) });
  assert.equal(rec.verdict, "REPROVADO", "[K2.3]");
  assert.ok(rec.failures.includes("kv_copy_value_hash_mismatch:1"), "[K2.4] " + rec.failures.join(","));
  assert.equal(calls.length, 0, "[K2.5] nada restaurado");
  assert.equal(KV_LACUNA(rec), true, "[K2.6]");
  // O Neon devolve a linha sem o TTL: o Worker confere valor + TTL + metadados relidos contra a fonte e acusa.
  const lossy = await workerBackup({ lossyTtl: true });
  assert.ok(lossy.reports[0].failures.includes("kv_copy_integrity:1:0"), "[K2.7] " + lossy.reports[0].failures.join(","));
});

test("K3 cópia do KV cifrada (AES-256-GCM, AAD própria); rebaixamento para claro e chave ausente reprovam", async () => {
  const key = randomBytes(32);
  const { final, fixture } = await workerBackup({ key });
  assert.equal(final.ok, true, "[K3.0] " + JSON.stringify(final.failures));
  assert.ok(fixture[ck].startsWith('{"$enc":"zevanory-backup-enc/v1"'), "[K3.1] envelope");
  assert.ok(!fixture[ck].includes("enabled") && !fixture[ck].includes("plan"), "[K3.2] nenhum valor do KV em claro");
  assert.equal(JSON.parse(fixture[ck]).aad.key, ck, "[K3.3] AAD presa à chave da cópia do KV");
  const env = { P20_BACKUP_KEYS: key.toString("base64") };
  const rec = await drill(fixture, { env });
  assert.equal(rec.verdict, "APROVADO", "[K3.4] " + rec.failures.join(","));
  assert.equal(rec.kv_copy.copia_cifrada, true, "[K3.5]");
  assert.equal(KV_LACUNA(rec), false, "[K3.6]");
  const down = { ...fixture };
  const p0 = JSON.parse(down[partReportKey(0)]);
  // Rebaixamento: alguém troca o envelope pelo texto claro com o mesmo SHA declarado.
  const { kv: kv2 } = await workerBackup();
  down[ck] = kv2.m.get(ck);
  p0.kv.copy.sha = sha256(down[ck]);
  down[partReportKey(0)] = JSON.stringify(p0);
  const direct = assessKvCopy({ parts: [down[partReportKey(0)]], kv_copy: down[ck] }, { day: DAY, keyring: parseKeyring(key.toString("base64")) });
  assert.deepEqual(direct.failures, ["kv_copy_encryption_downgrade"], "[K3.7] parte 0 cifrada e cópia do KV em claro: rebaixamento recusado");
  const r2 = await drill(down, { env });
  assert.ok(r2.failures.includes("kv_copy_encryption_downgrade"), "[K3.7b] " + r2.failures.join(","));
  assert.equal(KV_LACUNA(r2), true, "[K3.8]");
  const r3 = await drill(fixture, { env: { P20_BACKUP_KEYS: "" } });
  assert.equal(r3.verdict, "REPROVADO", "[K3.9]");
  assert.equal(KV_LACUNA(r3), true, "[K3.10]");
});

test("K4 cópia do KV adulterada no KV: hash do bundle, hash por chave, manifesto da fonte (valor, TTL, metadados), contagem, prefixo, relatório e ausência", async () => {
  const base = () => makeBackup({ kv: { rows: KV_ROWS } });
  const ok = await drill(base());
  assert.equal(ok.verdict, "APROVADO", "[K4.0] " + ok.failures.join(","));
  const cases = [];
  const resign = (kv, rows) => { kv[ck] = JSON.stringify(rows); return mut(kv, partReportKey(0), (p) => { p.kv.copy.sha = sha256(kv[ck]); }); };
  // (1) bundle trocado sem atualizar o SHA declarado
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[0].value = "{}"; kv[ck] = JSON.stringify(rows); cases.push(["kv_copy_hash_mismatch", kv, "[K4.1]"]); }
  // (2) valor trocado e SHA do bundle refeito: hash por chave diverge
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[1].value = "{\"totals\":{\"approved\":9}}"; cases.push(["kv_copy_value_hash_mismatch:1", resign(kv, rows), "[K4.2]"]); }
  // (3) valor e hash da linha trocados juntos: só o manifesto da FONTE acusa
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[0].value = JSON.stringify({ enabled: true }); rows[0].sha256 = sha256(rows[0].value); cases.push(["kv_copy_manifest_mismatch", resign(kv, rows), "[K4.3]"]); }
  // (4) chave a menos
  { const kv = base(); const rows = JSON.parse(kv[ck]).slice(1); cases.push(["kv_copy_row_count_mismatch", resign(kv, rows), "[K4.4]"]); }
  // (5) chave fora dos prefixos críticos (dado de lead) com hash coerente e contagem ajustada
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[3] = { ...rows[3], key: "zpc:interest:x" }; cases.push(["kv_copy_key_outside_prefixes:1", resign(kv, rows), "[K4.5]"]); }
  // (6) TTL perdido na cópia
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[2].expiration = null; cases.push(["kv_copy_manifest_mismatch", resign(kv, rows), "[K4.6]"]); }
  // (7) metadados trocados
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[3].metadata = "{\"kind\":\"x\"}"; cases.push(["kv_copy_manifest_mismatch", resign(kv, rows), "[K4.7]"]); }
  // (8) relatório declara a cópia de outro dia
  cases.push(["kv_copy_report_malformed", mut(base(), partReportKey(0), (p) => { p.kv.copy.bundleKey = kvCopyKeyFor("2026-10-30"); }), "[K4.8]"]);
  // (9) cópia declarada e ausente
  { const kv = base(); delete kv[ck]; cases.push(["kv_copy_bundle_missing", kv, "[K4.9]"]); }
  // (10) linha de outro dia
  { const kv = base(); const rows = JSON.parse(kv[ck]); rows[0].snapshot_day = "2026-11-01"; cases.push(["kv_copy_row_other_day:1", resign(kv, rows), "[K4.10]"]); }
  for (const [want, kv, mark] of cases) {
    const calls = [];
    const r = await drill(kv, { restoreImpl: okRestore(calls) });
    assert.ok(r.verdict === "REPROVADO" && r.failures.includes(want), `${mark} esperado ${want}: ${r.verdict} ${r.failures.join(",")}`);
    assert.ok(calls.length === 0 && KV_LACUNA(r) && r.kv_copy === null, `${mark} nada restaurado, lacuna mantida`);
  }
});

test("K5 restauração no Postgres efêmero: releitura ausente, com TTL perdido, metadados perdidos ou linha a menos reprova", async () => {
  const kv = makeBackup({ kv: { rows: KV_ROWS } });
  const noRows = await drill(kv, { restoreImpl: async (a) => { const o = await okRestore()(a); delete o.kv_rows; return o; } });
  assert.ok(noRows.verdict === "REPROVADO" && noRows.failures.includes("kv_restore_not_run") && KV_LACUNA(noRows), "[K5.1] " + noRows.failures.join(","));
  const lostTtl = await drill(kv, { restoreImpl: okRestore([], (rows) => rows.map((r) => ({ ...r, expiration: null }))) });
  assert.ok(lostTtl.verdict === "REPROVADO" && lostTtl.failures.includes("kv_restore_pg_manifest_mismatch") && KV_LACUNA(lostTtl), "[K5.2] " + lostTtl.failures.join(","));
  const lostMeta = await drill(kv, { restoreImpl: okRestore([], (rows) => rows.map((r) => ({ ...r, metadata: null }))) });
  assert.ok(lostMeta.failures.includes("kv_restore_pg_manifest_mismatch") && KV_LACUNA(lostMeta), "[K5.3]");
  const lostRow = await drill(kv, { restoreImpl: okRestore([], (rows) => rows.slice(0, 3)) });
  assert.ok(lostRow.failures.includes("kv_restore_pg_row_count_mismatch") && KV_LACUNA(lostRow), "[K5.4]");
  const changed = await drill(kv, { restoreImpl: okRestore([], (rows) => rows.map((r, i) => (i ? r : { ...r, value: "{}" }))) });
  assert.ok(changed.failures.includes("kv_restore_pg_value_hash_mismatch:1") && KV_LACUNA(changed), "[K5.5]");
  assert.equal(changed.kv_copy.pg_rows_ok, false, "[K5.6]");
});

test("K6 KV reconstruído: TTL e metadados recriados, chave expirada não recriada e contada, KV com defeito reprova", async () => {
  const rows = kvRowsFull(KV_ROWS);
  const A = assessKvCopy({ parts: [JSON.stringify({ kv: (() => { const k = JSON.parse(makeBackup({ kv: { rows: KV_ROWS } })[partReportKey(0)]).kv; return k; })() })], kv_copy: JSON.stringify(rows) }, { day: DAY });
  assert.deepEqual(A.failures, [], "[K6.0] " + A.failures.join(","));
  const plan = planKvRestore(rows, { nowSec: NOW_S });
  assert.deepEqual(plan.entries.find((p) => p.key.includes(":txn:")).opts, { expiration: 1800000000 }, "[K6.1] TTL absoluto na entrada");
  assert.deepEqual(plan.entries.find((p) => p.key === "zpc:cp:sub:sintetico").opts, { metadata: { kind: "sub", v: 1 } }, "[K6.2] metadados na entrada");
  const good = await kvRestoreDrill(rows, A, { nowSec: NOW_S });
  assert.deepEqual(good.failures, [], "[K6.3]");
  assert.ok(kvProofComplete(good.proof, DAY) && good.proof.with_ttl === 1 && good.proof.with_metadata === 1, "[K6.4]");
  const late = await kvRestoreDrill(rows, A, { nowSec: 1800000000 - 30 });
  assert.ok(late.failures.length === 0 && late.proof.expired_at_restore === 1 && late.proof.restored === 3 && late.proof.entries_manifest_ok, "[K6.5] expirada não recriada, contada e o manifesto confere");
  const inner = memKvReplay({ nowSec: NOW_S });
  const dropTtl = { ...inner, async set(k, v, o = {}) { const { expiration, ...rest } = o; void expiration; return inner.set(k, v, rest); } };
  const bad = await kvRestoreDrill(rows, A, { nowSec: NOW_S, mem: dropTtl });
  assert.ok(bad.failures.includes("kv_restore_ttl_metadata_mismatch:1") && !bad.proof.entries_manifest_ok && !kvProofComplete(bad.proof, DAY), "[K6.6] restauração sem TTL reprova");
  const inner2 = memKvReplay({ nowSec: NOW_S });
  const dropMeta = { ...inner2, async set(k, v, o = {}) { const { metadata, ...rest } = o; void metadata; return inner2.set(k, v, rest); } };
  assert.ok((await kvRestoreDrill(rows, A, { nowSec: NOW_S, mem: dropMeta })).failures.includes("kv_restore_ttl_metadata_mismatch:1"), "[K6.7] restauração sem metadados reprova");
  const inner3 = memKvReplay({ nowSec: NOW_S });
  const lossy = { ...inner3, async set(k, v, o) { if (k.startsWith(KV_PREFIXES[1])) return; return inner3.set(k, v, o); } };
  const l = await kvRestoreDrill(rows, A, { nowSec: NOW_S, mem: lossy });
  assert.ok(l.failures.includes("kv_restore_key_count_mismatch") && l.failures.includes("kv_restore_manifest_mismatch"), "[K6.8] chave não recriada reprova");
  await assert.rejects(memKvReplay({ nowSec: NOW_S }).set("zpc:sales:x", "1", { expiration: NOW_S + 10 }), /kv_expiration_invalid/, "[K6.9] semântica do Cloudflare: TTL mínimo de 60 s");
  assert.deepEqual((await kvRestoreDrillRaw(rows, A, { nowSec: NOW_S })).failures, ["kv_restore_prefixes_missing"], "[K6.10] sem a lista oficial de prefixos, a prova não roda");
  const replaySrc = readTextNormalized(new URL("../scripts/p20/kv-memory-replay.mjs", import.meta.url));
  assert.ok(!KV_PREFIXES.some((p) => replaySrc.includes(p)) && !/\.put\s*\(/.test(replaySrc), "[K6.11] reconstrução em memória: sem prefixo de produção literal e sem método de escrita da API do KV");
});

test("K7 registro estrito: a lacuna só sai com prova completa, num ensaio APROVADO; mutantes de remoção sem prova morrem", async () => {
  const legacy = await drill(makeBackup());
  assert.ok(KV_LACUNA(legacy) && legacy.kv_copy === null && legacy.verdict === "APROVADO", "[K7.1] Worker anterior (sem cópia): lacuna mantida, sem reprovar");
  const ok = await drill(makeBackup({ kv: { rows: KV_ROWS } }));
  assert.equal(KV_LACUNA(ok), false, "[K7.1b] prova completa retira a lacuna");
  const forged = structuredClone(legacy); forged.not_covered = forged.not_covered.filter((s) => !s.startsWith(COPIA_KV_ID + ":"));
  assert.throws(() => validateRecord(forged), /copia_kv_unproven/, "[K7.2] lacuna retirada sem kv_copy");
  for (const [k, v] of [["entries_manifest_ok", false], ["values_hash_ok", false], ["ttl_metadata_ok", false], ["pg_rows_ok", false], ["restored", 3], ["day", "2026-11-01"], ["keys", 0]]) {
    const f = structuredClone(ok); f.kv_copy[k] = v;
    assert.throws(() => validateRecord(f), /copia_kv_unproven/, "[K7.3] prova incompleta: " + k);
  }
  const rep = structuredClone(ok); rep.verdict = "REPROVADO"; rep.failures = ["x"]; rep.rto_seconds = null;
  assert.throws(() => validateRecord(rep), /copia_kv_unproven/, "[K7.4] lacuna nunca sai num ensaio reprovado");
  const na = buildRecord({ mode: "producao", sourceRead: false, assessment: null, restore: null, startedAt: "2026-11-02T07:00:00Z", finishedAt: "2026-11-02T07:00:01Z", notAvailableReason: "x" });
  assert.ok(KV_LACUNA(na), "[K7.5]");
  const na2 = structuredClone(na); na2.not_covered = na2.not_covered.filter((s) => !s.startsWith(COPIA_KV_ID + ":"));
  assert.throws(() => validateRecord(na2), /copia_kv_unproven/, "[K7.6] NOT_AVAILABLE nunca retira a lacuna");
  // Prova do KV completa, mas o ensaio reprova por outro motivo (restauração das tabelas): lacuna fica.
  const restoreFail = await drill(makeBackup({ kv: { rows: KV_ROWS } }), { restoreImpl: async () => ({ ok: false, error: "count_mismatch orders" }) });
  assert.ok(restoreFail.verdict === "REPROVADO" && KV_LACUNA(restoreFail), "[K7.7]");
  const enc = structuredClone(ok); enc.backup.copia_cifrada = true; enc.backup.parts.forEach((p) => { p.copia_cifrada = true; });
  enc.not_covered = enc.not_covered.filter((s) => !s.startsWith("copia_cifrada:"));
  assert.throws(() => validateRecord(enc), /copia_kv_unproven/, "[K7.8] backup cifrado com cópia do KV em claro não retira a lacuna");
  assert.deepEqual(notCoveredFor(false, false), [...NOT_COVERED], "[K7.9]");
  assert.equal(notCoveredFor(false, true).length, NOT_COVERED.length - 1, "[K7.9b]");
  assert.equal(notCoveredFor(false, "sim").length, NOT_COVERED.length, "[K7.10] só true estrito retira");
});

test("K8 contrato Worker x ensaio: prefixos, digest por chave, chave e formato da cópia; produção lê só GET 8 chaves do backup", async () => {
  assert.deepEqual([...KV_PREFIXES], [...W.KV_PREFIXES], "[K8.1] mesmos prefixos críticos");
  for (const e of [{ sha: "a".repeat(64), expiration: null, metadata: null }, { sha: "b".repeat(64), expiration: 1800000000, metadata: "{\"k\":1}" }]) {
    assert.equal(await W.kvEntryDigest(e), kvEntryDigest(e), "[K8.2] digest por chave idêntico nas duas implementações");
  }
  assert.equal(W.kvCopyKeyFor(DAY), kvCopyKeyFor(DAY), "[K8.3]");
  assert.equal(W.KV_COPY_FORMAT, KV_COPY_FORMAT, "[K8.3b]");
  assert.equal(await W.manifestHash({ a: "1" }), manifestHash({ a: "1" }), "[K8.3c]");
  const kv = makeBackup({ kv: { rows: KV_ROWS } });
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method });
    const key = decodeURIComponent(String(url).split("/values/")[1] || "");
    return kv[key] == null ? new Response("{}", { status: 404 }) : new Response(kv[key], { status: 200 });
  };
  const rec = await runDrill({ mode: "producao", env: { ...ENV, CLOUDFLARE_API_TOKEN: "t".repeat(40) }, fetchImpl, restoreImpl: okRestore(), now: () => new Date(NOW_ISO), clock: () => (tick += 1000), inventory: INVENTORY });
  assert.equal(rec.label, "ENSAIO_EM_PRODUCAO", "[K8.4a]");
  assert.equal(KV_LACUNA(rec), false, "[K8.4]");
  assert.equal(seen.length, 8, "[K8.5] 1 consolidado + 3 manifestos + 3 bundles + 1 cópia do KV");
  assert.ok(seen.every((c) => c.method === "GET" && c.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/zpc%3Abackup%3Av1%3A`)), "[K8.6] só GET, só zpc:backup:v1:*");
  // Relatório apontando a cópia para fora do namespace do backup: nunca lida.
  const evil = mut(makeBackup({ kv: { rows: KV_ROWS } }), partReportKey(0), (p) => { p.kv.copy.bundleKey = "zpc:sales:v1:summary"; });
  seen.length = 0;
  const kv2 = evil;
  const r2 = await runDrill({ mode: "producao", env: { ...ENV, CLOUDFLARE_API_TOKEN: "t".repeat(40) }, fetchImpl: async (url, init) => { seen.push(String(url)); const key = decodeURIComponent(String(url).split("/values/")[1] || ""); return kv2[key] == null ? new Response("{}", { status: 404 }) : new Response(kv2[key], { status: 200 }); }, restoreImpl: okRestore(), now: () => new Date(NOW_ISO), clock: () => (tick += 1000), inventory: INVENTORY });
  assert.ok(!seen.some((u) => u.includes("zpc%3Asales")) && r2.failures.includes("kv_copy_report_malformed") && KV_LACUNA(r2), "[K8.7] chave fora do backup nunca lida");
  void bundleKeyFor;
});
