import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Contestação GPT-6 (016-D): o filtro de caminhos do gate não pode deixar de fora nenhuma entrada do
// código testado. Percorre o fecho de importações relativas dos testes de integração e exige que cada
// arquivo seja coberto pelo filtro do workflow.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WF = readFileSync(join(ROOT, ".github/workflows/trava-vendas-integracao-postgres.yml"), "utf8");
const pats = [...WF.matchAll(/^\s+- "([^"]+)"\s*$/gm)].map((m) => m[1]);
const toRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const covered = (rel) => pats.some((p) => toRe(p).test(rel));

function closure(entries) {
  const seen = new Set(), stack = [...entries];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|register\(\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1] || m[2] || m[3]; const target = resolve(dirname(f), spec);
      if (existsSync(target)) stack.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}

test("todo arquivo importado pelos testes do gate está coberto pelo filtro de caminhos", () => {
  const files = closure([
    join(ROOT, "tests/integration/mercadopago-webhook-postgres.test.mjs"),
    join(ROOT, "tests/integration/close-invalidation-postgres.test.mjs"),
    join(ROOT, "tests/t4_sim/register.mjs")
  ]);
  assert.ok(files.length > 10, `fecho suspeito: ${files.length}`);
  assert.ok(files.includes("worker/cloudflare-worker.recovered.mjs"));
  const fora = files.filter((f) => !covered(f));
  assert.deepEqual(fora, [], "arquivos fora do filtro: " + fora.join(", "));
});

test("o gate exige contagem exata e nunca aceita teste pulado", () => {
  assert.match(WF, /grep -qx "# tests 16" m\.txt && grep -qx "# pass 16" m\.txt && grep -qx "# skipped 0" m\.txt && grep -qx "# fail 0" m\.txt/);
  assert.match(WF, /grep -qx "# tests 7" p\.txt && grep -qx "# pass 7" p\.txt && grep -qx "# skipped 0" p\.txt && grep -qx "# fail 0" p\.txt/);
  assert.doesNotMatch(WF, /secrets\./);
  assert.match(WF, /permissions:\s*\n\s+contents: read/);
});
