// Atomicidade do compare-and-swap da evidência de entrega em PostgreSQL REAL, com conexões
// INDEPENDENTES e simultâneas (processos psql em paralelo). Usa o MESMO SQL do Worker
// (extraído do código-fonte), para que uma mudança no Worker seja testada aqui.
// Rodar: T4_PG_HOST=/tmp/pgt T4_PG_PORT=55432 node --test tests/integration/delivery-evidence-cas-postgres.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const HOST = process.env.T4_PG_HOST, PORT = process.env.T4_PG_PORT || "5432";
const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const DB = "ci_delivery_cas";
const lit = (v) => v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const args = (db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-c"];
const psql = (sql, db = DB) => execFileSync("psql", [...args(db), sql], { encoding: "utf8" }).trim();
const psqlAsync = (sql) => new Promise((ok, ko) => execFile("psql", [...args(DB), sql], { encoding: "utf8" }, (e, out) => e ? ko(e) : ok(out.trim())));

const SRC = readFileSync(new URL("../../worker/cloudflare-worker.recovered.mjs", import.meta.url), "utf8");
const pick = (re) => { const m = SRC.match(re); if (!m) throw new Error("SQL do Worker não encontrado: " + re); return m[1]; };
const CAS_JSON = pick(/\? await sql\.query\(`(update service_fulfillment set evidence_ref=\$2,updated_at=now\(\) where order_id=\$1 and coalesce\(nullif\(btrim\(evidence_ref::text\),''\)::jsonb[^`]+)`/);
const CAS_TEXT = pick(/: await sql\.query\(`(update service_fulfillment set evidence_ref=\$2,updated_at=now\(\) where order_id=\$1 and evidence_ref::text=\$3[^`]*)`/);
const inline = (q, p) => q.replace(/\$(\d+)/g, (_, n) => lit(p[Number(n) - 1]));
const ev = (n) => JSON.stringify({ download_url: `https://zevanory.api.br/private/artifacts/download?token=t${n}`, expires_at: new Date(Date.now() + 3 * 864e5).toISOString() });

function novo(evidence, tipo) {
  const oid = randomUUID();
  psql(`insert into f_${tipo}(order_id,status,evidence_ref) values (${lit(oid)},'pending',${evidence === null ? "NULL" : lit(evidence)})`);
  return oid;
}
before(() => {
  if (SKIP) return;
  try { psql(`drop database if exists ${DB}`, "postgres"); } catch {}
  psql(`create database ${DB}`, "postgres");
  psql(`create table f_text (order_id uuid primary key, status text, evidence_ref text, updated_at timestamptz default now());
        create table f_jsonb (order_id uuid primary key, status text, evidence_ref jsonb, updated_at timestamptz default now());`);
});

for (const tipo of ["text", "jsonb"]) {
  for (const [nome, inicial] of [["sem evidência", null], ["evidência anterior vencida", ev(0)]]) {
    test(`CAS ${tipo}, ${nome}: 8 conexões simultâneas => exatamente 1 vence; a gravada é a vencedora`, { skip: SKIP }, async () => {
      const oid = novo(inicial, tipo);
      const prev = inicial ?? "";
      const q = (n) => inline(CAS_JSON.replace("service_fulfillment", `f_${tipo}`), [oid, ev(n), prev]);
      const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => psqlAsync(q(i + 1))));
      const venceu = outs.filter((o) => o === oid);
      assert.equal(venceu.length, 1, JSON.stringify(outs));
      const gravado = JSON.parse(psql(`select evidence_ref::text from f_${tipo} where order_id=${lit(oid)}`));
      assert.match(gravado.download_url, /token=t[1-8]$/);
      assert.notEqual(gravado.download_url, inicial ? JSON.parse(inicial).download_url : "", "a evidência antiga foi substituída uma única vez");
    });
  }
}

test("CAS text com evidência legada não-JSON: caminho texto, 8 simultâneas => 1 vence", { skip: SKIP }, async () => {
  const legado = "entregue-manual-2026-10-01";
  const oid = novo(legado, "text");
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => psqlAsync(inline(CAS_TEXT.replace("service_fulfillment", "f_text"), [oid, ev(i + 1), legado]))));
  assert.equal(outs.filter((o) => o === oid).length, 1, JSON.stringify(outs));
});

test("CAS jsonb: formatação diferente do mesmo JSON ainda casa (comparação semântica)", { skip: SKIP }, () => {
  const oid = novo('{"b": 1, "a": 2}', "jsonb");
  const out = psql(inline(CAS_JSON.replace("service_fulfillment", "f_jsonb"), [oid, ev(9), '{"a":2,"b":1}']));
  assert.equal(out, oid);
});

test("CAS text com evidência em BRANCO no banco ('' e espaços): ramo JSON trata como vazio, sem erro de cast; 1 vence", { skip: SKIP }, async () => {
  for (const branco of ["", "   "]) {
    const oid = novo(branco, "text");
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => psqlAsync(inline(CAS_JSON.replace("service_fulfillment", "f_text"), [oid, ev(i + 1), ""]))));
    assert.equal(outs.filter((o) => o === oid).length, 1, JSON.stringify([branco, outs]));
  }
});
