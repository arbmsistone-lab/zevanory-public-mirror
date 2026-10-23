// P01 Fase A: resolução PORTÁTIL de ferramentas externas (Linux, macOS e Windows/Git Bash).
// Python: python3 -> python -> py -3 (cada candidato precisa responder "Python 3.x" a --version; o atalho
// da Microsoft Store que só abre a loja é recusado). psql: PATH -> $PGBIN. Ausente = erro explícito
// "TOOL_MISSING: <ferramenta>" (nunca um teste pulado em silêncio).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cache = new Map();
const works = (cmd, args, re) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  return r.status === 0 && re.test(String(r.stdout) + String(r.stderr));
};
export function resolvePython() {
  if (cache.has("python")) return cache.get("python");
  for (const [cmd, pre] of [["python3", []], ["python", []], ["py", ["-3"]]]) {
    if (works(cmd, [...pre, "--version"], /Python 3\./)) { const v = { cmd, pre }; cache.set("python", v); return v; }
  }
  throw new Error("TOOL_MISSING: python (tentados: python3, python, py -3)");
}
export function resolvePsql() {
  if (cache.has("psql")) return cache.get("psql");
  const cands = ["psql"];
  if (process.env.PGBIN) cands.push(path.join(process.env.PGBIN, process.platform === "win32" ? "psql.exe" : "psql"));
  for (const c of cands) if ((c === "psql" || fs.existsSync(c)) && works(c, ["--version"], /PostgreSQL|psql/)) { cache.set("psql", c); return c; }
  throw new Error("TOOL_MISSING: psql (tentados: PATH, $PGBIN)");
}
// Executa python com os argumentos dados; devolve { status, stdout, stderr } (sem bytecode).
export function runPython(args, opts = {}) {
  const { cmd, pre } = resolvePython();
  return spawnSync(cmd, [...pre, ...args], { encoding: "utf8", windowsHide: true, ...opts, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...(opts.env || {}) } });
}
export function pythonOk(args, opts = {}) {
  const r = runPython(args, opts);
  if (r.status !== 0) throw new Error(`python ${args.join(" ")} -> ${r.status}: ${String(r.stderr).slice(0, 400)}`);
  return r.stdout;
}

// CSV do psql --csv (aspas, vírgulas e quebras de linha dentro de campos; CRLF do Windows).
export function parseCsv(out) {
  const rows = []; let row = [], cur = "", q = false;
  const text = String(out).replace(/\r\n/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cur); cur = ""; } else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  // Linhas de etiqueta de comando do psql (BEGIN, ROLLBACK, INSERT 0 1...) não são dados.
  const data = rows.filter((r) => r.length && !(r.length === 1 && /^(BEGIN|ROLLBACK|COMMIT|(INSERT|UPDATE|DELETE|SELECT) \d+( \d+)?|)$/.test(r[0])));
  const [head, ...body] = data;
  return head ? body.map((r) => Object.fromEntries(r.map((v, i) => [head[i], v]))) : [];
}
