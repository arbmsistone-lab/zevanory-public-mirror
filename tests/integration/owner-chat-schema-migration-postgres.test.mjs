// Epaminondas — coluna panel_end_marker no CAMINHO CANÔNICO de migração e restauração (27/11/2026), PostgreSQL 16 REAL.
// * Migração: banco com o esquema ANTERIOR (todo o DDL de tempo de execução do Worker, exatamente como
//   scripts/ops/restore_new_database.runtime_ddl() o extrai, menos o único ALTER novo) + sessão já existente →
//   ensureSessionSchema() do Worker (o caminho real) acrescenta a coluna sem tocar nas linhas; sessão antiga segue
//   valendo; sessão do painel passa a ser encerrada pela saída do painel.
// * Restauração: banco VAZIO + runtime_ddl() (fonte única do restauro em banco novo) → mesmo esquema da tabela que o
//   banco migrado (information_schema), o Worker funciona sem DDL adicional, saída do painel encerra a sessão.
// * Contraprova: restauro a partir de uma cópia do Worker SEM o ALTER → diverge do banco migrado e a sessão do painel
//   não pode ser criada → precisa ser DETECTADA.
// Sem rede, sem segredo. Rodar: T4_PG_HOST=127.0.0.1 T4_PG_PORT=5432 node --test tests/integration/owner-chat-schema-migration-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const DB_UP = "ci_owner_chat_upgrade", DB_RS = "ci_owner_chat_restore", DB_MUT = "ci_owner_chat_restore_mut";
const NEW_ALTER = "alter table zevanory_owner_chat_sessions add column if not exists panel_end_marker text;";
const ENV = { ...process.env, PGCONNECT_TIMEOUT: "5" };
const psqlArgs = (q, db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "--csv", "-c", q];
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const rowsOf = (out) => { const lines = out.trim() ? out.trim().split("\n") : []; if (!lines.length) return []; const h = lines[0].split(","); return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v === "" ? null : v]))); };
const q = (db, sqlText) => rowsOf(execFileSync("psql", psqlArgs(sqlText, db), { encoding: "utf8", env: ENV }));
function pg(db) { // uma conexão por consulta (autocommit), como o driver HTTP do Neon
  return { async query(text, params = []) {
    const inl = text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
    const { stdout } = await run("psql", psqlArgs(inl, db), { encoding: "utf8", env: ENV, maxBuffer: 1 << 24 });
    return rowsOf(stdout);
  } };
}
const recreate = (db) => { execFileSync("psql", psqlArgs(`drop database if exists ${db}`, "postgres"), { env: ENV }); execFileSync("psql", psqlArgs(`create database ${db}`, "postgres"), { env: ENV }); };
// Fonte única do restauro em banco novo: os MESMOS comandos que scripts/ops/restore_new_database.py aplica.
const runtimeDdl = (workerDir) => JSON.parse(execFileSync("python3", ["-I", "-c",
  "import sys,json;sys.path.insert(0,sys.argv[1]);import restore_new_database as r;print(json.dumps(r.runtime_ddl(sys.argv[2])[1]))",
  join(ROOT, "scripts/ops"), workerDir], { encoding: "utf8" }));
const apply = (db, stmts) => { for (const s of stmts) execFileSync("psql", psqlArgs(s, db), { env: ENV }); };
const columns = (db) => q(db, `select column_name, data_type, is_nullable, coalesce(column_default,'') as d from information_schema.columns where table_name = 'zevanory_owner_chat_sessions' order by column_name`);
const constraints = (db) => q(db, `select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'zevanory_owner_chat_sessions' order by 1`);
const hex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
let sess, bridge;

before(async () => {
  if (SKIP) return;
  sess = await import(pathToFileURL(join(ROOT, "worker/owner-session.mjs")).href);
  bridge = await import(pathToFileURL(join(ROOT, "worker/owner-panel-bridge.mjs")).href);
});

// Sessão do painel ligada ao sid; saída do painel encerra; a sessão sem painel (legada/PIN) segue.
async function panelFlow(db, legacyHash) {
  const sql = pg(db);
  const sid = hex().slice(0, 43), marker = await bridge.panelEndMarker(sid), h = hex();
  assert.equal(await sess.createSession(sql, h, 300, marker), true, "sessão do painel criada");
  assert.equal(await sess.checkSession(sql, h), true, "sessão do painel vale antes da saída");
  assert.equal(await sess.endPanelSession(sql, marker), true, "saída do painel gravada");
  assert.equal(await sess.checkSession(sql, h), false, "sessão do painel não vale depois da saída");
  if (legacyHash) assert.equal(await sess.checkSession(sql, legacyHash), true, "sessão anterior à migração segue valendo");
}

test("migração: banco com o esquema anterior + sessão existente → ensureSessionSchema acrescenta a coluna sem tocar nas linhas", { skip: SKIP }, async () => {
  const full = runtimeDdl(join(ROOT, "worker"));
  assert.equal(full.filter((s) => s === NEW_ALTER).length, 1, "o ALTER novo está, inteiro e uma vez, no DDL do restauro");
  const previous = full.filter((s) => s !== NEW_ALTER);
  assert.equal(previous.length, full.length - 1);
  recreate(DB_UP); apply(DB_UP, previous);
  assert.equal(columns(DB_UP).some((c) => c.column_name === "panel_end_marker"), false, "esquema anterior sem a coluna");
  const legacy = hex();
  q(DB_UP, `insert into zevanory_owner_chat_sessions (token_sha256, expires_at) values (${lit(legacy)}, now() + interval '1 hour')`);
  const before = q(DB_UP, `select token_sha256, created_at::text as c, expires_at::text as e, coalesce(revoked_at::text,'') as r from zevanory_owner_chat_sessions order by 1`);
  await sess.ensureSessionSchema(pg(DB_UP));
  await sess.ensureSessionSchema(pg(DB_UP)); // idempotente (outra conexão; o cache é por conexão)
  const col = columns(DB_UP).find((c) => c.column_name === "panel_end_marker");
  assert.deepEqual(col, { column_name: "panel_end_marker", data_type: "text", is_nullable: "YES", d: null });
  const after = q(DB_UP, `select token_sha256, created_at::text as c, expires_at::text as e, coalesce(revoked_at::text,'') as r from zevanory_owner_chat_sessions order by 1`);
  assert.deepEqual(after, before, "linhas existentes intactas");
  assert.equal(q(DB_UP, `select count(*) as n from zevanory_owner_chat_sessions where panel_end_marker is not null`)[0].n, "0");
  await panelFlow(DB_UP, legacy);
  console.log("# OWNER_CHAT_SCHEMA migracao=PASS comandos_anteriores=" + previous.length);
});

test("restauração: banco vazio + DDL canônico do restauro = mesmo esquema do banco migrado; Worker funciona sem DDL extra", { skip: SKIP }, async () => {
  recreate(DB_RS); apply(DB_RS, runtimeDdl(join(ROOT, "worker")));
  assert.deepEqual(columns(DB_RS), columns(DB_UP), "colunas iguais às do banco migrado");
  assert.deepEqual(constraints(DB_RS), constraints(DB_UP), "restrições iguais às do banco migrado");
  // O Worker não precisa acrescentar nada: o DDL dele vira no-op e nada muda.
  const cols = columns(DB_RS); await sess.ensureSessionSchema(pg(DB_RS)); assert.deepEqual(columns(DB_RS), cols);
  await panelFlow(DB_RS, null);
  console.log("# OWNER_CHAT_SCHEMA restauro=PASS");
});

test("contraprova: restauro a partir de um Worker SEM o ALTER diverge do banco migrado e não cria sessão do painel", { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "zv-mut-worker-")); cpSync(join(ROOT, "worker"), dir, { recursive: true });
  const f = join(dir, "owner-session.mjs"), src = readFileSync(f, "utf8");
  const line = "  await sql.query(`" + NEW_ALTER.slice(0, -1) + "`, []);\n";
  assert.ok(src.includes(line), "linha do ALTER encontrada"); writeFileSync(f, src.replace(line, ""));
  recreate(DB_MUT); apply(DB_MUT, runtimeDdl(dir));
  let detected = false;
  try {
    assert.deepEqual(columns(DB_MUT), columns(DB_UP));
    await panelFlow(DB_MUT, null);
  } catch { detected = true; }
  assert.equal(detected, true, "restauro sem a coluna precisa reprovar");
  console.log("# OWNER_CHAT_SCHEMA_COUNTERPROOF restauro-sem-alter=DETECTED");
});
