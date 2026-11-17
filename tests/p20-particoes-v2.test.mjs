// P20 v2 (docs/p20/particoes-v2.md): plano autenticado, partes dinâmicas e consolidação conferida, com o código real
// de worker/data-backup.mjs e um banco FALSO que só responde ao inventário (nenhuma rede, nenhum segredo real).
// A cadeia inteira (Worker -> arquivamento -> restauração em PostgreSQL) é provada em tests/test_p20_restauracao_integral.py.
import test from "node:test";
import assert from "node:assert/strict";
import { partsFor, assignParts, computePlan, runDataBackup, finalizeBackup, planBackup, backupRunParams, MAX_PARTS, REPORT_KEY, AUTHENTICATED_FIELDS } from "../worker/data-backup.mjs";
import { loadReportKey, hmacHex, canonical } from "../worker/backup-crypto.mjs";
import { planDecision } from "../scripts/ops/data-backup.mjs";

const KEY = Buffer.alloc(32, 9).toString("base64");
const DAY = "2026-11-17";
const RUN = "1".repeat(32);
const NOW = Date.parse(DAY + "T12:00:00Z");
const tables = (n, prefix = "t") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
const inventoryRows = (names) => names.map((t) => ({ t, cols: JSON.stringify([["id", "integer", "NO"], ["txt", "text", "YES"]]) }));

// Banco falso: responde ao inventário e emula a POSSE DO DIA (zevanory_backup_day: mesma semântica das instruções
// atômicas do Worker); registra TODA instrução (para provar o que foi escrito). `days` pode ser compartilhado entre
// bancos falsos (o mesmo banco visto por duas execuções).
const LOCK = /zevanory_backup_day/;
function fakeSql(names, { colsOf = null, days = new Map(), stealOnComplete = false } = {}) {
  const seen = [];
  return {
    seen, days,
    async query(text, params = []) {
      const q = String(text);
      seen.push(q);
      if (/information_schema\.tables t\s+where t\.table_schema = 'public'/.test(q)) return names.map((t) => ({ t, cols: colsOf ? colsOf(t) : JSON.stringify([["id", "integer", "NO"], ["txt", "text", "YES"]]) }));
      if (/^create table if not exists zevanory_backup_day/.test(q)) return [];
      if (/^\s*insert into zevanory_backup_day/.test(q)) {
        const [day, run] = params; const r = days.get(day);
        if (!r) { days.set(day, { run_id: run, state: "running" }); return [{ run_id: run }]; }
        if (r.state === "running" && r.run_id === run) return [{ run_id: run }];
        return [];
      }
      if (/^\s*update zevanory_backup_day set state = 'complete'/.test(q)) {
        const [day, run] = params; const r = days.get(day);
        if (stealOnComplete && r) { r.run_id = "9".repeat(32); } // outra execução tomou a posse entre a reivindicação e o fechamento
        if (r && r.state === "running" && r.run_id === run) { r.state = "complete"; return [{ run_id: run }]; }
        return [];
      }
      if (/to_regclass\('public\.zevanory_backup_day'\)/.test(q)) return [{ e: days.size > 0 }];
      if (/^\s*select state from zevanory_backup_day/.test(q)) { const r = days.get(params[0]); return r ? [{ state: r.state }] : []; }
      return [];
    },
  };
}
const writesOutsideLock = (sql) => sql.seen.filter((q) => !/^\s*select/i.test(q) && !LOCK.test(q));
function memKv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } };
}

test("garantia de distribuição: para E de 1 a 180, parts = ceil(E/30) e nenhuma parte passa de 30 (enumeração completa)", () => {
  for (let E = 1; E <= 180; E++) {
    const p = partsFor(E);
    assert.equal(p, Math.ceil(E / 30));
    assert.ok(p <= MAX_PARTS);
    const a = assignParts(tables(E), p);
    assert.equal(a.length, p);
    assert.ok(a.every((x) => x.length <= 30 && x.length >= Math.floor(E / p)), `E=${E}`);
    assert.equal(new Set(a.flat()).size, E);
  }
});

test("tabelas de credencial saem ANTES da numeração: a atribuição das elegíveis não depende da posição delas", async () => {
  const base = tables(90);
  const ref = await computePlan({ sql: fakeSql(base), env: { P20_BACKUP_KEY: KEY }, day: DAY });
  for (const pos of [0, 1, 29, 30, 44, 60, 89, 90]) {
    for (const k of [1, 3, 8]) {
      const names = [...base];
      for (let i = 0; i < k; i++) names.splice(Math.min(pos + i, names.length), 0, `a_oauth_token_${i}`);
      const p = await computePlan({ sql: fakeSql(names.sort()), env: { P20_BACKUP_KEY: KEY }, day: DAY });
      assert.equal(p.plan.parts, 3);
      assert.deepEqual(assignParts(p.plan.eligible, p.plan.parts), assignParts(ref.plan.eligible, ref.plan.parts));
      assert.equal(p.plan.excluded.length, k);
      assert.ok(assignParts(p.plan.eligible, p.plan.parts).every((x) => x.length <= 30));
    }
  }
});

test("capacidade: 180 elegíveis = 6 partes; 181 = capacity_exceeded e nenhum plano", async () => {
  const ok = await computePlan({ sql: fakeSql(tables(180)), env: { P20_BACKUP_KEY: KEY }, day: DAY });
  assert.equal(ok.plan.parts, 6);
  const no = await computePlan({ sql: fakeSql(tables(181)), env: { P20_BACKUP_KEY: KEY }, day: DAY });
  assert.equal(no.ok, false);
  assert.deepEqual(no.failures, ["capacity_exceeded:181"]);
});

test("plan_id: HMAC do plano; muda com tabela nova, coluna alterada ou outro dia; sem chave só fora da produção (nao_autenticado)", async () => {
  const env = { P20_BACKUP_KEY: KEY };
  const a = await computePlan({ sql: fakeSql(tables(40)), env, day: DAY });
  assert.match(a.plan_id, /^[0-9a-f]{64}$/);
  assert.equal(a.auth.state, "autenticado");
  const rk = await loadReportKey(KEY);
  assert.equal(a.plan_id, await hmacHex(rk, canonical(a.plan)));
  const b = await computePlan({ sql: fakeSql([...tables(40), "zz_nova"]), env, day: DAY });
  const c = await computePlan({ sql: fakeSql(tables(40), { colsOf: (t) => JSON.stringify([["id", t === "t005" ? "bigint" : "integer", "NO"], ["txt", "text", "YES"]]) }), env, day: DAY });
  const d = await computePlan({ sql: fakeSql(tables(40)), env, day: "2026-11-18" });
  assert.equal(new Set([a.plan_id, b.plan_id, c.plan_id, d.plan_id]).size, 4);
  const semChave = await computePlan({ sql: fakeSql(tables(40)), env: {}, day: DAY });
  assert.deepEqual(semChave.failures, ["backup_key_absent_encryption_required"]);
  const legado = await computePlan({ sql: fakeSql(tables(40)), env: {}, day: DAY, encryptionRequired: false });
  assert.equal(legado.auth.state, "nao_autenticado");
  assert.match(legado.plan_id, /^sha256:/);
});

test("parte com plan_id diferente (inventário mudou) é rejeitada sem NENHUMA escrita: o relatório válido no KV fica intacto", async () => {
  const sql = fakeSql(tables(40));
  const kv = memKv();
  const valido = JSON.stringify({ contract: 2, day: DAY, part: 0, run_id: RUN, ok: true, failures: [] });
  kv.m.set(REPORT_KEY + ":part:0", valido);
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://falso", P20_BACKUP_KEY: KEY };
  const r = await runDataBackup(env, { sqlFactory: () => sql, now: NOW, part: 0, parts: 2, planId: "0".repeat(64), runId: "2".repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.deepEqual(r.failures, ["inventory_changed"]);
  assert.deepEqual(writesOutsideLock(sql), [], "nenhuma escrita no banco além da posse do dia");
  assert.deepEqual([...kv.m.keys()], [REPORT_KEY + ":part:0"], "nenhuma chave nova no KV");
  assert.equal(kv.m.get(REPORT_KEY + ":part:0"), valido, "relatório válido byte a byte igual");
  const semRun = await runDataBackup(env, { sqlFactory: () => sql, now: NOW, part: 0, parts: 2, planId: "0".repeat(64) });
  assert.deepEqual(semRun.failures, ["run_id_missing_or_malformed"]);
  assert.equal(kv.m.get(REPORT_KEY + ":part:0"), valido);
});

test("parte fora do intervalo do plano falha sem escrever", async () => {
  const sql = fakeSql(tables(40));
  const kv = memKv();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://falso", P20_BACKUP_KEY: KEY };
  const p = await planBackup(env, { sqlFactory: () => sql, now: NOW });
  assert.equal(p.parts, 2);
  const r = await runDataBackup(env, { sqlFactory: () => sql, now: NOW, part: 2, parts: 3, planId: p.plan_id, runId: RUN });
  assert.deepEqual(r.failures, ["part_out_of_range"]);
  assert.deepEqual(writesOutsideLock(sql), []);
  assert.equal(kv.m.size, 0, "parte rejeitada não grava no KV");
});

// Consolidação: relatórios das partes gravados à mão (como o Worker grava), para provocar cada divergência.
async function consolidate(mutate = () => {}) {
  const sql = fakeSql(tables(40));
  sql.days.set(DAY, { run_id: RUN, state: "running" }); // a execução RUN é a dona do dia (como depois das partes)
  const kv = memKv();
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://falso", P20_BACKUP_KEY: KEY };
  const pl = await computePlan({ sql, env, day: DAY });
  const asg = assignParts(pl.plan.eligible, pl.plan.parts);
  const parts = asg.map((names, i) => ({
    schema: "zevanory-backup/v1", contract: 2, day: DAY, part: i, parts: pl.plan.parts, plan_id: pl.plan_id, run_id: RUN, ok: true, failures: [],
    ...(i === 0 ? { plan: pl.plan, totalTables: 40, kv: {}, restore: { kv: null } } : {}),
    neon: { tables: names.length, rows: names.length, excluded: [], skipped: [] }, restore: { neon: { tables: names.length, ok: names.length, rows: names.length } },
    encryption: { state: "cifrado", kid: "k" }, bundle: { key: `zpc:backup:v1:neon:${DAY}:part:${i}`, sha256: "a".repeat(64) },
    tables: Object.fromEntries(names.map((t) => [t, { rows: 1, sha: "b".repeat(64) }])),
  }));
  mutate(parts, pl);
  parts.forEach((r, i) => kv.m.set(`${REPORT_KEY}:part:${i}`, JSON.stringify(r)));
  const rep = await finalizeBackup(env, { parts: pl.plan.parts, now: NOW, planId: pl.plan_id, runId: RUN, sqlFactory: () => sql });
  return { rep, pl, kv, sql };
}

test("consolidação v2 íntegra: relatório autenticado inteiro (HMAC sobre os campos declarados)", async () => {
  const { rep, pl, kv, sql } = await consolidate();
  assert.deepEqual(rep.failures, []);
  assert.equal(rep.ok, true);
  assert.equal(rep.auth.state, "autenticado");
  // run_id de cada parte vai DENTRO do relatório autenticado (parts_detail).
  assert.ok(rep.parts_detail.every((d) => d.run_id === RUN));
  // Lista explícita (não a constante do módulo): um campo retirado da autenticação derruba este teste.
  assert.deepEqual(rep.auth.fields, ["contract", "day", "plan_id", "plan", "parts", "parts_detail", "ok", "failures", "encryption"]);
  const body = Object.fromEntries(AUTHENTICATED_FIELDS.map((k) => [k, rep[k] === undefined ? null : rep[k]]));
  assert.equal(rep.auth.hmac, await hmacHex(await loadReportKey(KEY), canonical(body)));
  // Consolidação aprovada marca o dia "complete" no banco ANTES de publicar.
  assert.equal(sql.days.get(DAY).state, "complete");
  // Dia CONCLUÍDO: outra execução (consolidação, parte ou plano) e a própria RUN de novo são recusadas sem gravar.
  const antes = new Map(kv.m);
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://falso", P20_BACKUP_KEY: KEY };
  const mesmoBanco = () => fakeSql(tables(40), { days: sql.days });
  const finB = await finalizeBackup(env, { parts: pl.plan.parts, now: NOW, planId: pl.plan_id, runId: "2".repeat(32), sqlFactory: mesmoBanco });
  assert.deepEqual(finB.failures, ["day_already_complete"]);
  const finA2 = await finalizeBackup(env, { parts: pl.plan.parts, now: NOW, planId: pl.plan_id, runId: RUN, sqlFactory: mesmoBanco });
  assert.deepEqual(finA2.failures, ["day_already_complete"]);
  const partB = await runDataBackup(env, { sqlFactory: mesmoBanco, now: NOW, part: 0, parts: pl.plan.parts, planId: pl.plan_id, runId: "2".repeat(32) });
  assert.deepEqual(partB.failures, ["day_already_complete"]);
  const planB = await planBackup(env, { sqlFactory: mesmoBanco, now: NOW });
  assert.equal(planB.day_complete, true);
  assert.deepEqual([...kv.m.entries()], [...antes.entries()], "KV byte a byte igual");
  // Dia de OUTRA execução em andamento: recusado (day_owned_by_other_run), sem gravar.
  const outroDia = fakeSql(tables(40)); outroDia.days.set(DAY, { run_id: "3".repeat(32), state: "running" });
  const finC = await finalizeBackup(env, { parts: pl.plan.parts, now: NOW, planId: pl.plan_id, runId: RUN, sqlFactory: () => outroDia });
  assert.deepEqual(finC.failures, ["day_owned_by_other_run"]);
  assert.deepEqual([...kv.m.entries()], [...antes.entries()]);
  // Posse perdida entre a reivindicação e o fechamento: a consolidação aprovada NÃO publica.
  const kv2 = memKv(); for (const [k, v] of kv.m) if (k.includes(":part:")) kv2.m.set(k, v);
  const roubado = fakeSql(tables(40), { stealOnComplete: true }); roubado.days.set(DAY, { run_id: RUN, state: "running" });
  const finD = await finalizeBackup({ ...env, ZEVANORY_PRIVATE_ARTIFACTS: kv2 }, { parts: pl.plan.parts, now: NOW, planId: pl.plan_id, runId: RUN, sqlFactory: () => roubado });
  assert.deepEqual(finD.failures, ["day_owned_by_other_run"]);
  assert.equal(kv2.m.has(REPORT_KEY), false, "sem posse no fechamento, nada é publicado");
  const adulterado = { ...body, parts_detail: body.parts_detail.map((d, i) => (i === 0 ? { ...d, bundle_sha256: "c".repeat(64) } : d)) };
  assert.notEqual(rep.auth.hmac, await hmacHex(await loadReportKey(KEY), canonical(adulterado)));
});

test("consolidação v2 reprova: tabela em duas partes, tabela faltando, plano adulterado, parte de outro plano", async () => {
  const dup = await consolidate((ps) => { const t = Object.keys(ps[0].tables)[0]; ps[1].tables[t] = { rows: 1, sha: "b".repeat(64) }; });
  assert.ok(dup.rep.failures.some((f) => f.startsWith("table_in_two_parts:")));
  assert.ok(dup.rep.failures.includes("part_tables_mismatch:1"));
  assert.equal(dup.rep.ok, false);
  const falta = await consolidate((ps) => { delete ps[1].tables[Object.keys(ps[1].tables)[0]]; });
  assert.ok(falta.rep.failures.includes("coverage_incomplete:1"));
  const forjado = await consolidate((ps) => { ps[0].plan = { ...ps[0].plan, eligible: ps[0].plan.eligible.slice(1) }; });
  assert.ok(forjado.rep.failures.includes("plan_auth_failed"));
  const outro = await consolidate((ps) => { ps[1].plan_id = "f".repeat(64); });
  assert.ok(outro.rep.failures.includes("part_plan_mismatch:1"));
  const semHash = await consolidate((ps) => { delete ps[0].bundle; });
  assert.ok(semHash.rep.failures.includes("part_bundle_hash_missing:0"));
  // Parte desta execução rejeitada (sem gravar): o relatório que sobrou no KV é de OUTRA execução e não supre a parte.
  const outraExec = await consolidate((ps) => { ps[1].run_id = "2".repeat(32); });
  assert.ok(outraExec.rep.failures.includes("part_run_mismatch:1"));
  assert.equal(outraExec.rep.ok, false);
});

test("condutor: rota de plano ausente (404) = legado v1 sinalizado; plano válido = v2; resposta inválida = falha", () => {
  assert.deepEqual(planDecision({ http: 404, body: {} }), { mode: "v1" });
  assert.deepEqual(planDecision({ http: 409, body: { ok: false, day_complete: true, failures: ["day_already_complete"] } }), { mode: "done" });
  assert.equal(planDecision({ http: 409, body: { ok: false, failures: ["other"] } }).mode, "fail");
  assert.deepEqual(planDecision({ http: 200, body: { ok: true, plan_id: "a".repeat(64), parts: 4 } }), { mode: "v2", planId: "a".repeat(64), parts: 4 });
  assert.equal(planDecision({ http: 200, body: { ok: true, plan_id: "sha256:x", parts: 4 } }).mode, "fail");
  assert.equal(planDecision({ http: 200, body: { ok: true, plan_id: "a".repeat(64), parts: 7 } }).mode, "fail");
  assert.equal(planDecision({ http: 500, body: { ok: false, failures: ["capacity_exceeded:181"] } }).failures[0], "capacity_exceeded:181");
  // Rota do Worker novo: só o contrato v2. Chamada legada (sem plan_id/run_id) ou malformada é recusada antes de tudo.
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(backupRunParams(q("part=0&parts=3")), { ok: false, failure: "v2_required:plan_id_and_run_id" });
  assert.deepEqual(backupRunParams(q("finalize=1&parts=3")), { ok: false, failure: "v2_required:plan_id_and_run_id" });
  assert.deepEqual(backupRunParams(q("part=0&parts=3&plan_id=" + "a".repeat(64))), { ok: false, failure: "v2_required:plan_id_and_run_id" });
  assert.deepEqual(backupRunParams(q("part=0&parts=3&plan_id=xyz&run_id=" + RUN)), { ok: false, failure: "plan_id_malformed" });
  assert.deepEqual(backupRunParams(q("part=0&parts=3&plan_id=" + "a".repeat(64) + "&run_id=zz")), { ok: false, failure: "run_id_malformed" });
  assert.deepEqual(backupRunParams(q("part=2&parts=4&plan_id=" + "a".repeat(64) + "&run_id=" + RUN)), { ok: true, parts: 4, planId: "a".repeat(64), runId: RUN, part: 2, finalize: false });
});
