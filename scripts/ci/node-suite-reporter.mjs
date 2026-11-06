// ZEVANORY | Reporter do node:test que conta, POR ARQUIVO, os testes que realmente rodaram.
// Usado ao lado do reporter TAP pela suíte Node completa (trava-vendas-integracao-postgres.yml);
// scripts/ci/node_suite_check.py compara o resultado com tests/node-suite.manifest.
// Conta como "test" todo evento test:pass/test:fail que não é suíte (describe), em qualquer nível,
// igual ao "# tests" do resumo TAP. Um resultado no nível do ARQUIVO (o node usa o caminho do arquivo como
// nome quando o arquivo não declarou/rodou testes normalmente: erro de carga, process.exit) é marcado à parte.
// Portável (AVAL Sol, Windows): todo caminho sai em forma POSIX relativa ao diretório atual
// (path.relative + split(sep).join("/")); o nome do resultado de arquivo é comparado nas duas formas.
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const posix = (p) => String(p).split(sep).join("/").split("\\").join("/");
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

function toPath(f) {
  if (!f) return null;
  const s = String(f);
  return s.startsWith("file:") ? fileURLToPath(s) : s;
}

export function relPosix(file, cwd = process.cwd()) {
  const p = toPath(file);
  if (!p) return "<no-file>";
  return posix(relative(cwd, isAbsolute(p) ? p : resolve(cwd, p)));
}

// Resultado no nível do arquivo: nível 0 e o NOME aponta para o próprio arquivo (qualquer separador,
// com ou sem "./", relativo ou absoluto; sem diferenciar maiúsculas no Windows).
export function isFileLevel(d, cwd = process.cwd()) {
  if (!d || d.nesting !== 0 || typeof d.name !== "string") return false;
  const file = toPath(d.file);
  const name = d.name.trim();
  if (!/\.(c|m)?js$/i.test(name)) return false;
  const nameRel = relPosix(name.replace(/\\/g, "/"), cwd).replace(/^\.\//, "");
  if (!file) return /[\\/]/.test(name);
  const fileRel = relPosix(file, cwd);
  return same(nameRel, fileRel) || (/[\\/]/.test(name) && same(basename(name.replace(/\\/g, "/")), basename(posix(file))));
}

export default async function* nodeSuiteReporter(source) {
  const files = {};
  const cwd = process.cwd();
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data || {};
    if (d.details && d.details.type === "suite") continue;
    const rel = relPosix(d.file || (isFileLevel(d, cwd) ? d.name : null), cwd);
    const f = (files[rel] ||= { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, file_level: 0 });
    f.tests += 1;
    if (d.skip) f.skip += 1;
    else if (d.todo) f.todo += 1;
    else if (ev.type === "test:pass") f.pass += 1;
    else f.fail += 1;
    if (isFileLevel(d, cwd)) f.file_level += 1;
  }
  yield JSON.stringify({ schema: "zevanory.node-suite-per-file.v1", files }, null, 1) + "\n";
}
