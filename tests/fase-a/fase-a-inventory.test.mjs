// P01 Fase A (AVAL 085 §6): as 5 tabelas da migração 030 estão no inventário (manifesto de migrações), são
// restauradas pela restauração completa (fonte = migração, não DDL de tempo de execução) e entram no backup
// diário do Worker (que por isso aparece no aviso: cópias apagadas em até 8 dias).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonOk } from "../../scripts/fase_a/tools.mjs";
import { runDataBackup, SENSITIVE } from "../../worker/data-backup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TABLES = ["waitlist_signups", "waitlist_persons", "waitlist_person_alias", "waitlist_person_days", "waitlist_raw_daily"];

test("manifesto exato de migrações: 31 arquivos, 030 declara as 5 tabelas; a restauração confere o manifesto", () => {
  const out = pythonOk(["-c", "import sys, json; sys.path.insert(0, sys.argv[1]); import restore_new_database as r; n, t = r.migration_manifest(); print(json.dumps({'n': len(n), 'last': n[-1], 't': t[n[-1]], 'rt': r.runtime_ddl()[0]}))", path.join(ROOT, "scripts", "ops")]);
  const j = JSON.parse(out.trim().split(/\r?\n/).pop());
  assert.equal(j.n, 31);
  assert.equal(j.last, "030_waitlist_fase_a.sql");
  assert.deepEqual(j.t, TABLES);
  for (const t of TABLES) assert.ok(!j.rt.includes(t), t + " não pode vir de DDL de tempo de execução (fonte única = migração)");
  const src = fs.readFileSync(path.join(ROOT, "worker", "waitlist.mjs"), "utf8");
  assert.doesNotMatch(src, /create table/i, "o Worker não cria as tabelas");
  const mig = fs.readFileSync(path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql"), "utf8");
  for (const t of TABLES) assert.match(mig, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
  assert.match(mig, /VALUES \('030_waitlist_fase_a'\)/);
  const down = fs.readFileSync(path.join(ROOT, "db", "rollback", "030_waitlist_fase_a.down.sql"), "utf8");
  for (const t of TABLES) assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${t};`));
});

test("backup diário inclui as 5 tabelas (nenhuma é filtrada como credencial)", async () => {
  for (const t of TABLES) assert.equal(SENSITIVE.test(t), false, t);
  const m = new Map();
  const kv = { async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; }, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
  const rows = Object.fromEntries(TABLES.map((t) => [t, [{ n: 1 }]]));
  const query = async (text, params = []) => {
    if (/from information_schema.tables/.test(text)) return TABLES.map((t) => ({ t, n: 1 }));
    if (/json_agg/.test(text)) return params[0].map((t) => ({ t, j: JSON.stringify(rows[t]) }));
    if (/^with ins as/.test(text.trim())) return [{ n: 1, h: "same", hb: "same" }];
    return [];
  };
  const now = Date.parse("2026-11-02T05:10:00Z");
  const r = await runDataBackup({ ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://x" }, { sqlFactory: () => ({ query }), now });
  assert.equal(r.neon.tables, 5, JSON.stringify(r.failures));
  const bundle = JSON.parse(m.get("zpc:backup:v1:neon:2026-11-02:part:0") || "{}");
  for (const t of TABLES) assert.equal(typeof bundle[t], "string", t);
  assert.match(fs.readFileSync(path.join(ROOT, "worker", "data-backup.mjs"), "utf8"), /expirationTtl: 8 \* DAY/, "prazo de 8 dias do aviso = TTL do backup");
});
