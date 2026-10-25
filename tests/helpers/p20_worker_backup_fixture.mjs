// ZEVANORY | P20: gera a fixture SINTÉTICA do ensaio mensal executando o CÓDIGO REAL do Worker
// (worker/data-backup.mjs: runDataBackup nas 3 partes + finalizeBackup) contra um PostgreSQL descartável,
// com um KV em memória. Assim o ensaio lê exatamente o formato que o Worker de produção grava.
// Uso: PGHOST=... PGDATABASE=<banco-origem-sintetico> node tests/helpers/p20_worker_backup_fixture.mjs <saida.json> <agora-iso>
// O "sql" do Worker é atendido pelo psql (parâmetros $n viram literais citados; saída CSV vira objetos).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { runDataBackup, finalizeBackup } from "../../worker/data-backup.mjs";

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return "ARRAY[" + v.map(lit).join(",") + "]";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const subst = (text, params = []) => String(text).replace(/\$(\d+)(?![0-9A-Za-z_$])/g, (_, n) => lit(params[Number(n) - 1]));

export function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function psqlSql(env = process.env) {
  return {
    async query(text, params) {
      const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-f", "-"], { input: subst(text, params) + ";\n", env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) throw new Error("psql_failed " + String(r.stderr || "").replace(/ERROR:\s*/g, "").slice(0, 200));
      const rows = parseCsv(r.stdout || "");
      if (!rows.length) return [];
      const [head, ...body] = rows;
      return body.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] === "" ? null : /^-?\d{1,15}$/.test(cells[i]) ? Number(cells[i]) : cells[i]])));
    },
  };
}

export function memoryKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
  };
}

export async function buildFixture({ now, env = process.env, kvSeed = {} }) {
  const kv = memoryKv(kvSeed);
  const sql = psqlSql(env);
  const wenv = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fixture-local-only" };
  const reports = [];
  for (let part = 0; part < 3; part++) reports.push(await runDataBackup(wenv, { sqlFactory: () => sql, now, part, parts: 3 }));
  const final = await finalizeBackup(wenv, { parts: 3, now });
  return { kv: Object.fromEntries([...kv.m.entries()].filter(([k]) => k.startsWith("zpc:backup:v1:"))), reports, final };
}

const isMain = process.argv[1] && import.meta.url.endsWith("/p20_worker_backup_fixture.mjs") && process.argv[1].endsWith("p20_worker_backup_fixture.mjs");
if (isMain) {
  const [out, nowIso] = process.argv.slice(2);
  const { kv, final } = await buildFixture({ now: Date.parse(nowIso), kvSeed: { "sales:open:v1": JSON.stringify({ enabled: false }), "zpc:sales:v1:sintetico": JSON.stringify({ ok: true }) } });
  writeFileSync(out, JSON.stringify(kv));
  console.log(JSON.stringify({ ok: final.ok, day: final.day, tables: final.neon.tables, rows: final.neon.rows, failures: final.failures }));
}
