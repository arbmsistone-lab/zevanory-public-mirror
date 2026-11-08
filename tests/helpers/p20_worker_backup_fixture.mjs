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

// KV em memória com a semântica do Cloudflare que o backup usa: list devolve expiration (s, absoluta) e metadata.
// Semente: { chave: "valor" } ou { chave: { value, expiration?, metadata? } } (TTL e metadados sintéticos).
export function memoryKv(seed = {}) {
  const m = new Map(), meta = new Map();
  for (const [k, v] of Object.entries(seed)) {
    if (v !== null && typeof v === "object") { m.set(k, String(v.value)); meta.set(k, { expiration: v.expiration ?? null, metadata: v.metadata ?? null }); }
    else m.set(k, String(v));
  }
  return {
    m, meta,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v, opts = {}) {
      m.set(k, String(v));
      const expiration = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : null);
      meta.set(k, { expiration, metadata: opts.metadata ?? null });
    },
    async delete(k) { m.delete(k); meta.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => {
        const e = meta.get(name) || {};
        return { name, ...(e.expiration != null ? { expiration: e.expiration } : {}), ...(e.metadata != null ? { metadata: e.metadata } : {}) };
      }), list_complete: true };
    },
  };
}

// Semente sintética do KV crítico: trava, resumo de vendas, uma chave de transação com TTL (como sales-ledger.mjs,
// 400 dias) e uma chave com metadados. "zpc:interest:" (dado pessoal, fora da cópia por política T3) não entra.
export function syntheticKvSeed(nowMs) {
  const s = Math.floor(nowMs / 1000);
  return {
    "sales:open:v1": JSON.stringify({ enabled: false }),
    "zpc:sales:v1:sintetico": JSON.stringify({ ok: true }),
    "zpc:sales:v1:txn:00000000000000a1:approved": { value: "1", expiration: s + 400 * 86400 },
    "zpc:cp:sub:sintetico": { value: JSON.stringify({ plan: "cp", ç: "acentuação \"aspas\" $1 $$" }), metadata: { kind: "sub", v: 1 } },
    "zpc:interest:sintetico": "fora-da-copia@example.invalid",
  };
}

export async function buildFixture({ now, env = process.env, kvSeed = {} }) {
  const kv = memoryKv(kvSeed);
  const sql = psqlSql(env);
  // P20_BACKUP_KEY (opcional, sintética): o Worker grava os bundles cifrados, como em produção com o segredo.
  const wenv = { ZEVANORY_PRIVATE_ARTIFACTS: kv, DATABASE_URL: "postgres://fixture-local-only", ...(env.P20_BACKUP_KEY ? { P20_BACKUP_KEY: env.P20_BACKUP_KEY } : {}) };
  // R154 (fase 2): com a chave, o padrão de produção (cifragem obrigatória). Sem a chave, a fixture gera de
  // propósito um backup legado em claro (anterior à fase 2), desligando a obrigatoriedade só aqui.
  const legacy = env.P20_BACKUP_KEY ? {} : { encryptionRequired: false };
  const reports = [];
  for (let part = 0; part < 3; part++) reports.push(await runDataBackup(wenv, { sqlFactory: () => sql, now, part, parts: 3, ...legacy }));
  const final = await finalizeBackup(wenv, { parts: 3, now, ...legacy });
  return { kv: Object.fromEntries([...kv.m.entries()].filter(([k]) => k.startsWith("zpc:backup:v1:"))), reports, final };
}

const isMain = process.argv[1] && import.meta.url.endsWith("/p20_worker_backup_fixture.mjs") && process.argv[1].endsWith("p20_worker_backup_fixture.mjs");
if (isMain) {
  const [out, nowIso] = process.argv.slice(2);
  const { kv, final } = await buildFixture({ now: Date.parse(nowIso), kvSeed: syntheticKvSeed(Date.parse(nowIso)) });
  writeFileSync(out, JSON.stringify(kv));
  console.log(JSON.stringify({ ok: final.ok, day: final.day, tables: final.neon.tables, rows: final.neon.rows, failures: final.failures, encryption: final.encryption, kv_keys: final.kv?.keys ?? null }));
}
