// B05 — utilitários de teste contra PostgreSQL EFÊMERO local (mesmo padrão de mercadopago-webhook-postgres):
// psql de verdade (semântica SQL real), sem credenciais, sem rede externa. Não é suíte (sem .test.).
import { execFileSync, execFile } from "node:child_process";

export const HOST = process.env.T4_PG_HOST;
export const PORT = process.env.T4_PG_PORT || "5432";
export const SKIP = !HOST && "T4_PG_HOST not set (throwaway local PostgreSQL required)";
const ARGS = () => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "--csv", "-q", "-f", "-"];

export const lit = (v) => (v === null || v === undefined ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'");
export const inline = (q, params = []) => q.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));

export function psqlRaw(input) {
  return execFileSync("psql", ARGS(), { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}
export function psqlAsync(input) {
  return new Promise((resolve, reject) => {
    const child = execFile("psql", ARGS(), { encoding: "utf8" }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
    child.stdin.end(input);
  });
}

export function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') { q = true; quoted = true; } else if (c === ",") { row.push(quoted || cur !== "" ? cur : null); cur = ""; quoted = false; }
    else if (c === "\n") { row.push(quoted || cur !== "" ? cur : null); rows.push(row); row = []; cur = ""; quoted = false; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(quoted || cur !== "" ? cur : null); rows.push(row); }
  return rows;
}
const toObjects = (text) => {
  const [head, ...rows] = parseCsv(text);
  return head ? rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))) : [];
};

// Cliente no formato do driver Neon (query(text, params) -> linhas como objetos), assíncrono: processos psql
// independentes = conexões independentes (concorrência real).
export const asyncSql = { async query(text, params = []) { return toObjects(await psqlAsync(inline(text, params).trim().replace(/;\s*$/, "") + ";\n")); } };
export function rowsSync(text, params = []) { return toObjects(psqlRaw(inline(text, params).trim().replace(/;\s*$/, "") + ";\n")); }

// Emulação do protocolo HTTP do Neon (para o bundle de produção, que fala com /sql via fetch).
const OID = { boolean: 16, integer: 23, bigint: 20, smallint: 21, numeric: 1700, text: 25, uuid: 2950, json: 114, jsonb: 3802,
  "timestamp with time zone": 1184, "character varying": 1043 };
export function neonQuery(query, params = []) {
  const q = inline(query, params).trim().replace(/;\s*$/, "");
  let desc = [];
  try { desc = parseCsv(psqlRaw(q + "\n\\gdesc\n")).slice(1).filter((r) => r.length >= 2); } catch { desc = []; }
  const out = parseCsv(psqlRaw(q + ";\n"));
  if (!desc.length) return { fields: [], rows: [], command: "OK", rowCount: 0 };
  const [head, ...rows] = out;
  return { fields: head.map((name, i) => ({ name, dataTypeID: OID[desc[i]?.[1]] ?? 25 })), rows, command: "SELECT", rowCount: rows.length };
}
export function neonResponse(init) {
  const body = JSON.parse(init.body);
  try {
    const result = body.queries ? { results: body.queries.map((x) => neonQuery(x.query, x.params)) } : neonQuery(body.query, body.params);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ message: String(e.stderr || e.message).slice(0, 300) }), { status: 400 });
  }
}
