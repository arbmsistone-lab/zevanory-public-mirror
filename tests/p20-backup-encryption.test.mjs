// ZEVANORY | P20 (seção 9.1): cifragem AES-256-GCM da cópia Neon -> KV (docs/p20/cifragem-backup.md).
// Duas implementações independentes do mesmo envelope: Worker (WebCrypto, worker/backup-crypto.mjs) e ensaio
// (node:crypto, scripts/p20/backup-envelope.mjs); cada teste cifra com uma e decifra com a outra quando faz sentido.
// Chaves 100% sintéticas geradas no próprio teste. Sem rede, sem banco. Marcadores [En.k] são usados pelos mutantes
// (scripts/ci/mutants_p20_restore_drill.py).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readTextNormalized } from "./helpers/text.mjs";
import * as W from "../worker/backup-crypto.mjs";
import { runDataBackup, finalizeBackup } from "../worker/data-backup.mjs";
import { parseKeyring, openBundleText, sealBundleText, kidOf } from "../scripts/p20/backup-envelope.mjs";
import { validateRecord, buildRecord, assessBackup, bundleKeyFor, COPIA_CIFRADA_ID } from "../scripts/p20/restore-drill-lib.mjs";
import { runDrill, readBackup, kvReader } from "../scripts/p20/restore-drill.mjs";
import { makeBackup, DAY, SEGREDO } from "./helpers/p20-backup-fixture.mjs";

const INVENTORY = JSON.parse(readTextNormalized(new URL("../docs/p20/inventario-estado-critico.json", import.meta.url)));
const KEY = randomBytes(32), KEY_B64 = KEY.toString("base64");
const OTHER = randomBytes(32), OTHER_B64 = OTHER.toString("base64");
const CTX = { day: DAY, part: 1, bundleKey: bundleKeyFor(DAY, 1) };
const PLAIN = JSON.stringify({ orders: JSON.stringify([{ id: 1, email: SEGREDO }]) });
const code = (re) => (e) => re.test(String(e?.code || e?.message));
const ENV = { PGHOST: "localhost", PGDATABASE: "p20_drill", GITHUB_RUN_ID: "9", GITHUB_SHA: "abc" };
const okRestore = (calls = []) => async ({ tablesJson }) => { calls.push(Object.keys(tablesJson).sort()); return { ok: true, tables: Object.fromEntries(Object.entries(tablesJson).map(([t, js]) => [t, JSON.parse(js).length])), preserved_without_schema: [], worker_schema_ready: true }; };
let tick = 0;
// runDrill valida o próprio registro (validateRecord) e lança se ele for incoerente: vira asserção [RUN].
const drill = async (kv, extra = {}) => { try { return await runDrillRaw(kv, extra); } catch (e) { assert.fail("[RUN] runDrill lançou: " + String(e?.message || e).slice(0, 80)); } };
const runDrillRaw = (kv, extra = {}) => runDrill({ mode: "sintetica", env: { ...ENV, ...(extra.env || {}) }, fixture: kv, restoreImpl: extra.restoreImpl || okRestore(), now: () => new Date("2026-11-02T07:23:00.000Z"), clock: () => (tick += 1000), inventory: INVENTORY });
const flip = (b64, at) => { const b = Buffer.from(b64, "base64"); const i = at < 0 ? b.length + at : at; b[i] ^= 0x01; return b.toString("base64"); };
const edit = (env, fn) => { const o = JSON.parse(env); fn(o); return JSON.stringify(o); };

// KV em memória com ganchos de escrita e dublê de SQL que responde pelo formato de cada consulta do backup.
function fakeKv(seed = {}, { onPut } = {}) {
  const m = new Map(Object.entries(seed));
  return { m, async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, onPut ? onPut(k, String(v)) : String(v)); }, async delete(k) { m.delete(k); } };
}
function fakeSql(tables = { orders: [{ id: 1, email: SEGREDO }], zevanory_leads: [{ id: 2 }] }) {
  const backup = [], calls = { dumped: [] };
  const query = async (text, params = []) => {
    const t = text.trim();
    if (/^insert into zevanory_kv_backup/.test(t)) { const [, k, v, h] = params; k.forEach((key, i) => backup.push({ key, value: v[i], sha256: h[i] })); return []; }
    if (/select key, value, sha256 from zevanory_kv_backup/.test(t)) return backup;
    if (/from information_schema.tables/.test(t)) return Object.entries(tables).map(([n, rows]) => ({ t: n, n: rows.length }));
    if (/^with ins as/.test(t)) { const rows = JSON.parse(params[0]); return [{ n: rows.length, h: "same", hb: "same" }]; }
    if (/json_agg/.test(t)) { calls.dumped.push(...params[0]); return params[0].map((n) => ({ t: n, j: JSON.stringify(tables[n]) })); }
    if (/string_agg\(r, ''\|''/.test(t)) return params[0].map((n) => ({ t: n, fp: "a".repeat(31) + String(tables[n].length % 10) }));
    return [];
  };
  return { factory: () => ({ query }), calls };
}
const wenv = (kv, key) => ({ ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://u:p@h/db", ...(key ? { P20_BACKUP_KEY: key } : {}) });
const NOW = Date.parse("2026-11-02T05:10:00Z");

test("E1 round-trip entre implementações: Worker (WebCrypto) cifra e o ensaio (node:crypto) decifra, e vice-versa", async () => {
  const k = await W.loadBackupKey(KEY_B64);
  assert.equal(k.state, "present");
  assert.equal(k.kid, kidOf(KEY), "[E1.1] kid derivado igual nas duas implementações");
  const env = await W.sealBundle(PLAIN, CTX, k);
  const o = JSON.parse(env);
  assert.deepEqual(Object.keys(o), ["$enc", "v", "alg", "kid", "nonce", "aad", "ct"], "[E1.2] envelope versionado com todos os campos");
  assert.equal(o.$enc, "zevanory-backup-enc/v1"); assert.equal(o.v, 1); assert.equal(o.alg, "A256GCM");
  assert.equal(Buffer.from(o.nonce, "base64").length, 12, "[E1.3] nonce de 96 bits");
  assert.deepEqual(o.aad, { day: DAY, part: 1, key: CTX.bundleKey });
  assert.ok(!env.includes(SEGREDO) && !env.includes("orders"), "[E1.4] nenhum texto claro no envelope");
  const ring = parseKeyring(KEY_B64);
  let back = {};
  assert.doesNotThrow(() => { back = openBundleText(env, CTX, ring); }, "[E1.5] Worker -> node");
  assert.equal(back.text, PLAIN, "[E1.5] Worker -> node");
  assert.equal(back.encrypted, true); assert.equal(back.kid, k.kid);
  const nodeEnv = sealBundleText(PLAIN, CTX, KEY);
  const tryOpen = async (fn) => { try { return (await fn()).text; } catch (e) { return "erro:" + e.code; } };
  assert.equal(await tryOpen(() => W.openBundle(nodeEnv, CTX, [k])), PLAIN, "[E1.6] node -> Worker");
  assert.equal(await tryOpen(() => W.openBundle(env, CTX, [k])), PLAIN, "[E1.7] Worker -> Worker");
  const big = JSON.stringify({ t: "x".repeat(300000) });
  const bigEnv = await W.sealBundle(big, CTX, k);
  assert.equal(await tryOpen(() => openBundleText(bigEnv, CTX, ring)), big, "[E1.8] bundle grande (base64 em blocos)");
});

test("E2 chave errada: decifragem falha nas duas implementações, nunca devolve texto", async () => {
  const k = await W.loadBackupKey(KEY_B64), wrong = await W.loadBackupKey(OTHER_B64);
  const env = await W.sealBundle(PLAIN, CTX, k);
  const forged = new Map([[k.kid, OTHER]]); // mesmo kid, chave diferente
  assert.throws(() => openBundleText(env, CTX, forged), code(/^decrypt_failed$/), "[E2.1] node com chave errada");
  await assert.rejects(W.openBundle(env, CTX, [{ kid: k.kid, key: wrong.key }]), code(/^decrypt_failed$/), "[E2.2] Worker com chave errada");
  assert.throws(() => openBundleText(env, CTX, parseKeyring(OTHER_B64)), code(/^kid_unknown$/), "[E2.3] conjunto só com outra chave: kid desconhecido");
});

test("E3 adulteração de ciphertext, tag, AAD, posição ou versão: falha fechada com código claro", async () => {
  const k = await W.loadBackupKey(KEY_B64), ring = parseKeyring(KEY_B64);
  const env = await W.sealBundle(PLAIN, CTX, k);
  assert.throws(() => openBundleText(edit(env, (o) => { o.ct = flip(o.ct, 0); }), CTX, ring), code(/^decrypt_failed$/), "[E3.1] ciphertext");
  assert.throws(() => openBundleText(edit(env, (o) => { o.ct = flip(o.ct, -1); }), CTX, ring), code(/^decrypt_failed$/), "[E3.2] tag");
  await assert.rejects(W.openBundle(edit(env, (o) => { o.ct = flip(o.ct, -1); }), CTX, [k]), code(/^decrypt_failed$/), "[E3.3] tag (Worker)");
  assert.throws(() => openBundleText(edit(env, (o) => { o.nonce = flip(o.nonce, 0); }), CTX, ring), code(/^decrypt_failed$/), "[E3.4] nonce");
  assert.throws(() => openBundleText(edit(env, (o) => { o.aad.day = "2026-11-01"; }), CTX, ring), code(/^aad_mismatch$/), "[E3.5] metadado de AAD trocado");
  const otherPart = { day: DAY, part: 2, bundleKey: bundleKeyFor(DAY, 2) };
  const moved = edit(env, (o) => { o.aad = { day: DAY, part: 2, key: otherPart.bundleKey }; });
  assert.throws(() => openBundleText(moved, otherPart, ring), code(/^decrypt_failed$/), "[E3.6] envelope movido para outra parte: a AAD autenticada derruba a tag");
  await assert.rejects(W.openBundle(moved, otherPart, [k]), code(/^decrypt_failed$/), "[E3.7] idem no Worker");
  assert.throws(() => openBundleText(edit(env, (o) => { o.v = 2; }), CTX, ring), code(/^envelope_version_unsupported$/), "[E3.8] versão desconhecida");
  assert.throws(() => openBundleText(edit(env, (o) => { o.alg = "A128GCM"; }), CTX, ring), code(/^envelope_malformed$/), "[E3.9]");
  assert.throws(() => openBundleText(edit(env, (o) => { o.ct = "AAAA"; }), CTX, ring), code(/^envelope_malformed$/), "[E3.10] sem tag");
  // Ensaio completo: bundle adulterado reprova e nada é restaurado.
  const kv = makeBackup({ key: KEY });
  kv[bundleKeyFor(DAY, 1)] = edit(kv[bundleKeyFor(DAY, 1)], (o) => { o.ct = flip(o.ct, -1); });
  const calls = [];
  const rec = await drill(kv, { env: { P20_BACKUP_KEYS: KEY_B64 }, restoreImpl: okRestore(calls) });
  assert.equal(rec.verdict, "REPROVADO", "[E3.11]");
  assert.ok(rec.failures.includes("bundle_decrypt_failed:1"), "[E3.12]");
  assert.equal(calls.length, 0, "[E3.13] cópia adulterada nunca é restaurada");
});

test("E4 kid desconhecido e conjunto de chaves inválido: falha clara, sem material de chave na mensagem", async () => {
  const kv = makeBackup({ key: KEY });
  const calls = [];
  const noKey = await drill(kv, { restoreImpl: okRestore(calls) });
  assert.equal(noKey.verdict, "REPROVADO", "[E4.1] cópia cifrada sem chave no ensaio nunca é aprovada");
  assert.deepEqual(noKey.failures.filter((f) => f.startsWith("bundle_")), ["bundle_kid_unknown:0", "bundle_kid_unknown:1", "bundle_kid_unknown:2"], "[E4.2]");
  assert.equal(calls.length, 0, "[E4.11] cópia cifrada sem chave nunca é restaurada");
  const otherOnly = await drill(kv, { env: { P20_BACKUP_KEYS: OTHER_B64 } });
  assert.ok(otherOnly.failures.includes("bundle_kid_unknown:0"), "[E4.3] kid fora do conjunto, mesmo com outra chave presente");
  const rotated = await drill(kv, { env: { P20_BACKUP_KEYS: `${OTHER_B64},${KEY_B64}` } });
  assert.equal(rotated.verdict, "APROVADO", "[E4.4] rotação: qualquer kid do conjunto é aceito");
  const asJson = await drill(kv, { env: { P20_BACKUP_KEYS: JSON.stringify({ [kidOf(KEY)]: KEY_B64 }) } });
  assert.equal(asJson.verdict, "APROVADO", "[E4.5] formato JSON {kid: base64}");
  const mism = await drill(kv, { env: { P20_BACKUP_KEYS: JSON.stringify({ [kidOf(OTHER)]: KEY_B64 }) } });
  assert.equal(mism.verdict, "NOT_AVAILABLE", "[E4.6]");
  assert.equal(mism.reason, "backup_keyring_kid_mismatch", "[E4.7] kid declarado diferente do derivado derruba");
  const short = randomBytes(31).toString("base64");
  const bad = await drill(kv, { env: { P20_BACKUP_KEYS: short } });
  assert.equal(bad.verdict, "NOT_AVAILABLE", "[E4.8]");
  assert.equal(bad.reason, "backup_keyring_malformed", "[E4.9] motivo é só o código, nunca o valor");
  assert.throws(() => parseKeyring("{x"), code(/^backup_keyring_malformed$/));
  assert.equal((await W.loadBackupKey(short)).state, "invalid", "[E4.10] Worker recusa chave de tamanho errado");
  assert.equal((await W.loadBackupKey("não-é-base64")).state, "invalid");
});

test("E5 legado em claro ainda restaura e é marcado não cifrado; lacuna copia_cifrada só sai com TODAS as partes cifradas", async () => {
  // Direto no montador do registro (sem a releitura estrita): parcial nunca retira a lacuna.
  const readings = await readBackup(kvReader({ mode: "sintetica", fixture: makeBackup({ key: KEY, encryptParts: [0, 2] }) }));
  const part = buildRecord({ mode: "sintetica", sourceRead: true, assessment: assessBackup(readings, { keyring: parseKeyring(KEY_B64) }), restore: { ok: true, tables: {} }, startedAt: "2026-11-02T07:23:00.000Z", finishedAt: "2026-11-02T07:24:00.000Z", rtoSeconds: 1 });
  assert.ok(part.not_covered.some((s) => s.startsWith(COPIA_CIFRADA_ID + ":")) && part.backup.copia_cifrada === false, "[E5.0] cópia parcialmente cifrada mantém a lacuna");
  const legacy = await drill(makeBackup());
  assert.equal(legacy.verdict, "APROVADO", "[E5.1] backup legado continua restaurável");
  assert.deepEqual(legacy.backup.parts.map((p) => p.copia_cifrada), [false, false, false], "[E5.2]");
  assert.equal(legacy.backup.copia_cifrada, false);
  assert.ok(legacy.not_covered.some((s) => s.startsWith(COPIA_CIFRADA_ID + ":")), "[E5.3]");
  const mixed = await drill(makeBackup({ key: KEY, encryptParts: [0, 1] }), { env: { P20_BACKUP_KEYS: KEY_B64 } });
  assert.equal(mixed.verdict, "APROVADO", "[E5.4] partes mistas (transição) restauram");
  assert.deepEqual(mixed.backup.parts.map((p) => p.copia_cifrada), [true, true, false], "[E5.5] copia_cifrada por parte");
  assert.equal(mixed.backup.copia_cifrada, false, "[E5.6]");
  assert.ok(mixed.not_covered.some((s) => s.startsWith(COPIA_CIFRADA_ID + ":")), "[E5.7] parcial não retira a lacuna");
  const full = await drill(makeBackup({ key: KEY }), { env: { P20_BACKUP_KEYS: KEY_B64 } });
  assert.equal(full.verdict, "APROVADO", "[E5.8]");
  assert.equal(full.backup.copia_cifrada, true, "[E5.9]");
  assert.ok(!full.not_covered.some((s) => s.startsWith(COPIA_CIFRADA_ID + ":")), "[E5.10] todas cifradas: lacuna retirada");
  assert.equal(full.not_covered.length, 3);
  assert.equal(full.scope_complete_9_1, false, "[E5.11] outras lacunas continuam");
  const forged = structuredClone(legacy); forged.not_covered = forged.not_covered.filter((s) => !s.startsWith(COPIA_CIFRADA_ID + ":"));
  assert.throws(() => validateRecord(forged), /copia_cifrada_unproven/, "[E5.12] releitura recusa lacuna retirada sem prova");
  const forged2 = structuredClone(full); forged2.backup.parts[2].copia_cifrada = false;
  assert.throws(() => validateRecord(forged2), /copia_cifrada_unproven/, "[E5.13]");
  validateRecord(structuredClone(full));
  // Rebaixamento: a parte declara cifrada e o bundle chega em claro (KV reescrito): reprova.
  const down = makeBackup({ key: KEY });
  const plainOne = makeBackup();
  down[bundleKeyFor(DAY, 0)] = plainOne[bundleKeyFor(DAY, 0)];
  const d = await drill(down, { env: { P20_BACKUP_KEYS: KEY_B64 } });
  assert.equal(d.verdict, "REPROVADO", "[E5.14]");
  assert.ok(d.failures.includes("bundle_encryption_downgrade:0"), "[E5.15]");
});

test("E6 nonce nunca repetido: 4096 cifragens e as 3 partes de um backup real têm nonces distintos", async () => {
  const k = await W.loadBackupKey(KEY_B64);
  const seen = new Set();
  for (let i = 0; i < 4096; i++) seen.add(JSON.parse(await W.sealBundle("x", CTX, k)).nonce);
  assert.equal(seen.size, 4096, "[E6.1] sem repetição de nonce");
  const kv = fakeKv();
  const { factory } = fakeSql({ a: [{ id: 1 }], b: [{ id: 2 }], c: [{ id: 3 }] });
  for (let part = 0; part < 3; part++) await runDataBackup(wenv(kv, KEY_B64), { sqlFactory: factory, now: NOW, part, parts: 3 });
  const nonces = [0, 1, 2].map((p) => JSON.parse(kv.m.get(bundleKeyFor(DAY, p))).nonce);
  assert.equal(new Set(nonces).size, 3, "[E6.2] nonce único por parte");
  // Teste estatístico simples: bits do nonce equilibrados (nonce constante ou de zeros reprova).
  let ones = 0;
  for (const n of seen) for (const byte of Buffer.from(n, "base64")) ones += byte.toString(2).split("1").length - 1;
  const ratio = ones / (4096 * 96);
  assert.ok(ratio > 0.48 && ratio < 0.52, "[E6.3] proporção de bits 1 ~ 0,5: " + ratio);
});

test("E7 Worker, fase 1: com chave grava cifrado; sem chave mantém claro com alerta 'nao_cifrado'; obrigatória ou chave inválida nunca grava em claro", async () => {
  // (a) com chave
  const kv = fakeKv();
  const { factory } = fakeSql();
  const r = await runDataBackup(wenv(kv, KEY_B64), { sqlFactory: factory, now: NOW, part: 0, parts: 1 });
  assert.equal(r.ok, true, "[E7.0] backup cifrado aprovado pelo ensaio diário do Worker " + JSON.stringify(r.failures));
  assert.equal(r.encryption.state, "cifrado", "[E7.1]");
  assert.equal(r.encryption.kid, kidOf(KEY));
  const stored = kv.m.get(bundleKeyFor(DAY, 0));
  assert.ok(stored.startsWith('{"$enc":"zevanory-backup-enc/v1"'), "[E7.2] bundle gravado como envelope");
  assert.ok(!stored.includes(SEGREDO) && !stored.includes("orders"), "[E7.3] nada em claro no KV");
  assert.equal(r.restore.neon.ok, 2, "[E7.4] ensaio diário decifra e confere");
  const fin = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 1, now: NOW });
  assert.equal(fin.ok, true);
  assert.deepEqual(fin.encryption, { state: "cifrado", parts_cifradas: 1, parts: 1, kids: [kidOf(KEY)] }, "[E7.5]");
  // (b) sem chave, fase 1
  const kv2 = fakeKv();
  const r2 = await runDataBackup(wenv(kv2), { sqlFactory: fakeSql().factory, now: NOW, part: 0, parts: 1 });
  assert.equal(r2.ok, true, "[E7.6] fase 1: comportamento atual mantido");
  assert.equal(r2.encryption.state, "nao_cifrado", "[E7.7]");
  assert.deepEqual(r2.warnings, ["backup_nao_cifrado"], "[E7.8] alerta registrado");
  assert.equal(typeof JSON.parse(kv2.m.get(bundleKeyFor(DAY, 0))).orders, "string");
  const fin2 = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv2 }, { parts: 1, now: NOW });
  assert.equal(fin2.ok, true);
  assert.equal(fin2.encryption.state, "nao_cifrado", "[E7.9]");
  assert.deepEqual(fin2.warnings, ["backup_nao_cifrado:nao_cifrado"]);
  // (c) cifragem obrigatória sem chave: nada gravado
  const kv3 = fakeKv();
  const r3 = await runDataBackup(wenv(kv3), { sqlFactory: fakeSql().factory, now: NOW, part: 0, parts: 1, encryptionRequired: true });
  assert.equal(r3.ok, false, "[E7.10]");
  assert.ok(r3.failures.includes("backup_key_absent_encryption_required"), "[E7.11]");
  assert.ok(![...kv3.m.keys()].some((x) => x.startsWith("zpc:backup:v1:neon:")), "[E7.12] nenhum bundle em claro");
  const fin3 = await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv2 }, { parts: 1, now: NOW, encryptionRequired: true });
  assert.equal(fin3.ok, false, "[E7.13] obrigatória: consolidado com parte em claro falha");
  assert.ok(fin3.failures.includes("backup_nao_cifrado:nao_cifrado"));
  // (d) chave configurada mas inválida: nunca cai para claro
  const kv4 = fakeKv();
  const r4 = await runDataBackup(wenv(kv4, randomBytes(16).toString("base64")), { sqlFactory: fakeSql().factory, now: NOW, part: 0, parts: 1 });
  assert.ok(r4.failures.includes("backup_key_invalid"), "[E7.14]");
  assert.ok(![...kv4.m.keys()].some((x) => x.startsWith("zpc:backup:v1:neon:")), "[E7.15] chave inválida não grava em claro");
  // (e) releitura no Worker: cópia adulterada ou rebaixada para claro reprova
  const tamper = fakeKv({}, { onPut: (k, v) => (k.startsWith("zpc:backup:v1:neon:") ? edit(v, (o) => { o.ct = flip(o.ct, -1); }) : v) });
  const r5 = await runDataBackup(wenv(tamper, KEY_B64), { sqlFactory: fakeSql().factory, now: NOW, part: 0, parts: 1 });
  assert.ok(r5.failures.includes("neon_copy_unreadable:decrypt_failed"), "[E7.16]");
  const downgrade = fakeKv({}, { onPut: (k, v) => (k.startsWith("zpc:backup:v1:neon:") ? JSON.stringify({ orders: "[]" }) : v) });
  const r6 = await runDataBackup(wenv(downgrade, KEY_B64), { sqlFactory: fakeSql().factory, now: NOW, part: 0, parts: 1 });
  assert.ok(r6.failures.includes("neon_copy_not_encrypted"), "[E7.17] Worker exige o envelope na releitura");
  assert.equal(r6.ok, false);
});

test("E8 incremental com bundle anterior cifrado; rotação força exportação completa sem falha", async () => {
  const kv = fakeKv();
  const s1 = fakeSql();
  await runDataBackup(wenv(kv, KEY_B64), { sqlFactory: s1.factory, now: NOW, part: 0, parts: 1 });
  const s2 = fakeSql();
  const r2 = await runDataBackup(wenv(kv, KEY_B64), { sqlFactory: s2.factory, now: NOW + 86400000, part: 0, parts: 1 });
  assert.equal(r2.ok, true, "[E8.0] " + JSON.stringify(r2.failures));
  assert.equal(r2.transfer.reused, 2, "[E8.1] tabelas inalteradas reaproveitadas do bundle cifrado anterior");
  const s3 = fakeSql();
  const r3 = await runDataBackup(wenv(kv, OTHER_B64), { sqlFactory: s3.factory, now: NOW + 2 * 86400000, part: 0, parts: 1 });
  assert.equal(r3.ok, true, "[E8.2]");
  assert.equal(r3.transfer.reused, 0, "[E8.3] chave nova não abre o bundle antigo: exporta tudo");
  assert.equal(r3.encryption.kid, kidOf(OTHER));
});

test("E9 nenhum log, relatório, valor do KV ou registro com material de chave", async () => {
  const out = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => out.push(a.map(String).join(" "));
  const texts = [];
  try {
    const kv = fakeKv();
    for (let part = 0; part < 3; part++) texts.push(JSON.stringify(await runDataBackup(wenv(kv, KEY_B64), { sqlFactory: fakeSql().factory, now: NOW, part, parts: 3 })));
    texts.push(JSON.stringify(await finalizeBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv }, { parts: 3, now: NOW })));
    texts.push(...kv.m.values());
    texts.push(JSON.stringify(await runDataBackup(wenv(fakeKv(), KEY_B64.slice(0, 40)), { sqlFactory: fakeSql().factory, now: NOW })));
    for (const keys of [KEY_B64, OTHER_B64, KEY_B64.slice(0, 40), JSON.stringify({ [kidOf(OTHER)]: KEY_B64 })]) texts.push(JSON.stringify(await drill(makeBackup({ key: KEY }), { env: { P20_BACKUP_KEYS: keys } })));
    for (const bad of [KEY_B64.slice(0, 40), "{x", JSON.stringify({ a: KEY_B64 })]) { try { parseKeyring(bad); } catch (e) { texts.push(String(e.message)); } }
  } finally { Object.assign(console, orig); }
  const all = out.concat(texts).join("\n");
  for (const secret of [KEY_B64, OTHER_B64, KEY_B64.slice(0, 40), KEY.toString("hex"), OTHER.toString("hex"), KEY_B64.slice(4, 24)]) {
    assert.ok(!all.includes(secret), "[E9.1] material de chave vazou");
  }
  const src = readTextNormalized(new URL("../worker/backup-crypto.mjs", import.meta.url)) + readTextNormalized(new URL("../scripts/p20/backup-envelope.mjs", import.meta.url));
  assert.doesNotMatch(src, /console\./, "[E9.2] módulos de cifragem não registram nada");
});

test("E10 workflows: chave da restauração só no Environment producao-critica; Worker com no máximo 1 segredo novo", () => {
  const wf = readTextNormalized(new URL("../.github/workflows/p20-monthly-restore-drill.yml", import.meta.url));
  const [drillJob, publishJob] = wf.split(/\n  publish:\n/);
  assert.match(drillJob, /P20_BACKUP_KEYS: \$\{\{ secrets\.P20_BACKUP_KEYS \}\}/, "[E10.1]");
  assert.match(drillJob, /environment: producao-critica/, "[E10.5] chave só sob o Environment protegido");
  assert.doesNotMatch(publishJob, /P20_BACKUP_KEYS/, "[E10.2] publicação nunca vê a chave");
  const src = readTextNormalized(new URL("../worker/data-backup.mjs", import.meta.url)) + readTextNormalized(new URL("../worker/backup-crypto.mjs", import.meta.url));
  const names = new Set([...src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...names].filter((n) => n.startsWith("P20_")), ["P20_BACKUP_KEY"], "[E10.3] um único segredo novo no Worker");
  assert.doesNotMatch(src, /env\.P20_BACKUP_ENCRYPTION|env\.P20_BACKUP_ACTIVE/, "[E10.4] flag de fase no código, não em binding");
});
