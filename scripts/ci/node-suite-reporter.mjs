// ZEVANORY | Reporter do node:test que conta, POR ARQUIVO, os testes que realmente rodaram.
// Usado ao lado do reporter TAP pela suíte Node completa (trava-vendas-integracao-postgres.yml);
// scripts/ci/node_suite_check.py compara o resultado com tests/node-suite.manifest.
// Conta como "test" todo evento test:pass/test:fail que não é suíte (describe), em qualquer nível,
// igual ao "# tests" do resumo TAP. Um resultado no nível do ARQUIVO (nome = caminho do arquivo) indica
// que o arquivo não declarou/rodou testes normalmente (erro de carga, process.exit) e é marcado à parte.
import { relative, sep } from "node:path";

export default async function* nodeSuiteReporter(source) {
  const files = {};
  const cwd = process.cwd();
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data || {};
    if (d.details && d.details.type === "suite") continue;
    const rel = d.file ? relative(cwd, d.file).split(sep).join("/") : "<no-file>";
    const f = (files[rel] ||= { tests: 0, pass: 0, fail: 0, skip: 0, todo: 0, file_level: 0 });
    f.tests += 1;
    if (d.skip) f.skip += 1;
    else if (d.todo) f.todo += 1;
    else if (ev.type === "test:pass") f.pass += 1;
    else f.fail += 1;
    if (d.nesting === 0 && (d.name === rel || (d.file && d.name === d.file))) f.file_level += 1;
  }
  yield JSON.stringify({ schema: "zevanory.node-suite-per-file.v1", files }, null, 1) + "\n";
}
