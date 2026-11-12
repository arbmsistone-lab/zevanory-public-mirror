// NC-G6-1025-02: contrato único e coerente do status do pós-venda (leitor do #1025 e Vigia).
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import * as hps from "../worker/hotmart-post-sale.mjs";
import * as vigia from "../worker/vigia.mjs";
import * as chat from "../worker/owner-chat.mjs";
import { fakeSql } from "./helpers/owner-chat-fakes.mjs";

const KEY = "zpc:posvenda:hotmart:status:v1", T = Date.parse("2026-11-12T15:00:00Z");
const st = (resultado, codigo, pendentes = 0) => ({ em: new Date(T).toISOString(), resultado, codigo, pendentes });
const kv = (v) => ({ get: async (k) => (k === KEY ? JSON.stringify(v) : null) });
const LEGIT = [st("ok", "completed"), st("ok", "no_due_steps"), st("ok", "kv_budget_hold"), st("ok", "sales_closed"),
  st("inconclusivo", "not_configured"), st("inconclusivo", "quota_ledger_unreadable"), st("inconclusivo", "post_sale_inconclusive"),
  st("reconciliacao_pendente", "reconciliation_pending", 1), st("reconciliacao_pendente", "provider_restricted", 3)];
const CONTRADICTORY = [st("ok", "provider_usage_invalid"), st("ok", "post_sale_inconclusive"), st("ok", "reconciliation_pending"),
  st("inconclusivo", "completed"), st("inconclusivo", "sales_closed"), st("reconciliacao_pendente", "completed", 2),
  st("ok", "completed", 1), st("reconciliacao_pendente", "reconciliation_pending", 0), st("ok", "codigo_inventado")];

test("estados legítimos do gravador continuam válidos no leitor e no Vigia", async () => {
  for (const v of LEGIT) {
    assert.deepEqual(await hps.readHotmartPostSaleStatus(kv(v), { now: T }), { status: "ok", value: v }, JSON.stringify(v));
    assert.equal(vigia.validPostSaleStatus(v, T), true, JSON.stringify(v));
  }
});

test("estado contraditório = LEITURA_INCONCLUSIVA (value:null) no leitor e ilegível no Vigia", async () => {
  for (const v of CONTRADICTORY) {
    assert.deepEqual(await hps.readHotmartPostSaleStatus(kv(v), { now: T }), { status: "LEITURA_INCONCLUSIVA", value: null }, JSON.stringify(v));
    assert.equal(vigia.validPostSaleStatus(v, T), false, JSON.stringify(v));
    const obs = vigia.observePostSale({ state: "ok", value: v }, T);
    assert.ok(obs.every((o) => o.health === "falha") && obs.some((o) => o.key === "vigia:sem-dados:pos-venda"), JSON.stringify(v));
  }
});

test("todo código que o gravador pode emitir está no contrato (sem estado legítimo rejeitado)", () => {
  const src = readTextNormalized(new URL("../worker/hotmart-post-sale.mjs", import.meta.url));
  const runner = src.slice(src.indexOf("async function runHotmartPostSaleInternal"));
  const emitted = new Set([...runner.matchAll(/code:'([a-z_]+)'/g)].map((m) => m[1]).filter((c) => !["already_running", "not_hourly_tick"].includes(c)));
  for (const c of ["quota_ledger_unreadable", "post_sale_inconclusive"]) emitted.add(c);
  const all = Object.values(hps.POST_SALE_STATUS_CODES).flat();
  for (const c of emitted) assert.ok(all.includes(c), "código emitido fora do contrato: " + c);
  const vsrc = readTextNormalized(new URL("../worker/vigia.mjs", import.meta.url));
  assert.match(vsrc, /import \{ validPostSaleStatusShape \} from "\.\/hotmart-post-sale\.mjs";/);
});

test("resultado com tipo errado (array, objeto, número, booleano, null) = LEITURA_INCONCLUSIVA e nenhuma saúde", async () => {
  for (const bad of [["inconclusivo"], ["ok"], { ok: 1 }, 1, true, null]) {
    const v = { ...st("ok", "completed"), resultado: bad };
    assert.deepEqual(await hps.readHotmartPostSaleStatus(kv(v), { now: T }), { status: "LEITURA_INCONCLUSIVA", value: null }, JSON.stringify(bad));
    assert.equal(vigia.validPostSaleStatus(v, T), false, JSON.stringify(bad));
    assert.ok(vigia.observePostSale({ state: "ok", value: v }, T).every((o) => o.health === "falha"), JSON.stringify(bad));
  }
});

test("regressão no motor: incidente inconclusivo aberto → registro posterior com resultado:[\"inconclusivo\"] → nenhum RESOLVIDO", async () => {
  const data = new Map([["zpc:creative-autonomy:paused:v1", "0"], [KEY, JSON.stringify(st("inconclusivo", "post_sale_inconclusive"))]]);
  const store = { get: async (k) => (data.has(k) ? data.get(k) : null), put: async (k, v) => { data.set(k, String(v)); } }, sql = fakeSql();
  const snap = { today: [{ channel: "blog", status: "publicado", at: new Date(T).toISOString() }, { channel: "bluesky", status: "publicado", at: new Date(T).toISOString() }] };
  const run = (at) => chat.runOwnerChatSentinel({ ZEVANORY_PRIVATE_ARTIFACTS: store, DATABASE_URL: "x" }, new Date(at), { sqlFactory: () => sql, snapshot: async () => snap });
  await run(T + 60000);
  assert.equal(sql.rows.filter((r) => /PROBLEMA.*pós-venda/.test(r.body)).length, 1);
  data.set(KEY, JSON.stringify({ ...st("inconclusivo", "post_sale_inconclusive"), em: new Date(T + 3600000).toISOString(), resultado: ["inconclusivo"] }));
  await run(T + 3600000 + 60000); await run(T + 2 * 3600000);
  assert.equal(sql.rows.filter((r) => /RESOLVIDO/.test(r.body)).length, 0, "array não pode resolver");
  data.set(KEY, JSON.stringify({ ...st("ok", "completed"), em: new Date(T + 2 * 3600000).toISOString() }));
  await run(T + 2 * 3600000 + 60000);
  assert.equal(sql.rows.filter((r) => /PROBLEMA.*pós-venda está ilegível/.test(r.body)).length, 1, "o array é falha de leitura, não saúde");
  assert.equal(sql.rows.filter((r) => /RESOLVIDO — O pós-venda não conseguiu concluir/.test(r.body)).length, 1, "saúde real posterior resolve o inconclusivo");
  assert.equal(sql.rows.filter((r) => /RESOLVIDO — O estado do pós-venda está ilegível/.test(r.body)).length, 1, "e a falha de leitura");
});

test("mutante: sem coerência código×resultado, o contraditório passaria", async () => {
  const SRC = fileURLToPath(new URL("../worker/hotmart-post-sale.mjs", import.meta.url));
  const src = readTextNormalized(SRC), from = "POST_SALE_STATUS_CODES[v.resultado].includes(v.codigo)";
  assert.ok(src.includes(from));
  const path = SRC.replace(/\.mjs$/, ".mutant-coerencia.mjs");
  await writeFile(path, src.replace(from, "/^[a-z_]{1,64}$/.test(v.codigo)"));
  try { const m = await import(pathToFileURL(path).href + "?" + Date.now()); assert.equal((await m.readHotmartPostSaleStatus(kv(st("ok", "provider_usage_invalid")), { now: T })).status, "ok", "o mutante precisa aceitar o contraditório"); }
  finally { await rm(path, { force: true }); }
});

test("mutante: sem exigir resultado string, o array passaria", async () => {
  const SRC = fileURLToPath(new URL("../worker/hotmart-post-sale.mjs", import.meta.url));
  const src = readTextNormalized(SRC), from = "typeof v.resultado==='string'&&";
  assert.ok(src.includes(from));
  const path = SRC.replace(/\.mjs$/, ".mutant-tipo.mjs");
  await writeFile(path, src.replace(from, ""));
  try { const m = await import(pathToFileURL(path).href + "?" + Date.now()); assert.equal((await m.readHotmartPostSaleStatus(kv({ ...st("inconclusivo", "post_sale_inconclusive"), resultado: ["inconclusivo"] }), { now: T })).status, "ok", "o mutante precisa aceitar o array"); }
  finally { await rm(path, { force: true }); }
});
