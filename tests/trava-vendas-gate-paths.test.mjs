import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Contestações GPT-6 (016-D/016-E): o filtro de caminhos do gate não pode deixar de fora nenhuma entrada
// do código testado. Fecho = importações estáticas relativas + import()/register() literais + arquivos lidos
// por readFileSync(new URL("literal", import.meta.url)). Qualquer import dinâmico NÃO literal, require() de
// módulo não nativo ou leitura de arquivo não literal fora da lista explícita derruba o teste — assim a
// cobertura deixa de ser "parcial silenciosa": o que não puder ser provado estaticamente falha alto.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WF_PATH = ".github/workflows/trava-vendas-integracao-postgres.yml";
const WF = readFileSync(join(ROOT, WF_PATH), "utf8");
const pats = [...WF.matchAll(/^\s+- "([^"]+)"\s*$/gm)].map((m) => m[1]);
const toRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const covered = (rel) => pats.some((p) => toRe(p).test(rel));
const ENTRIES = [
  "tests/integration/mercadopago-webhook-postgres.test.mjs",
  "tests/integration/close-invalidation-postgres.test.mjs",
  "tests/integration/delivery-evidence-cas-postgres.test.mjs",
  "tests/t4_sim/register.mjs",
  "tests/trava-vendas-gate-paths.test.mjs"
];
// Leituras de arquivo com caminho vindo do AMBIENTE em tempo de execução (certificados TLS do driver
// PostgreSQL embutido no bundle); não são arquivos do repositório.
const RUNTIME_READS_ALLOWED = new Set(["t.sslcert", "t.sslkey", "t.sslrootcert"]);
const NATIVE = /^(node:.+|fs|path|crypto|url|os|buffer|events|stream|util|http|https|net|tls|zlib|child_process|module|dns|string_decoder)$/;

function closure() {
  const seen = new Set(), stack = ENTRIES.map((e) => join(ROOT, e)), problems = [];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    const src = readFileSync(f, "utf8"), rel = relative(ROOT, f);
    if (!/\.(m?js)$/.test(f)) continue;
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\(\s*|\bregister\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const t = resolve(dirname(f), m[1]); if (existsSync(t)) stack.push(t); else problems.push(`${rel}: import inexistente ${m[1]}`);
    }
    for (const m of src.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
      const t = resolve(dirname(f), m[1]); if (existsSync(t)) stack.push(t);
    }
    // Este próprio arquivo contém os padrões como texto de regex; seus imports são só módulos nativos.
    if (rel === "tests/trava-vendas-gate-paths.test.mjs") continue;
    for (const m of src.matchAll(/\bimport\(\s*(?!["'])([^)]{0,60})/g)) problems.push(`${rel}: import dinâmico não literal ${m[1]}`);
    for (const m of src.matchAll(/(?<![\w$.])require\(\s*["']([^"']+)["']\s*\)/g)) if (!NATIVE.test(m[1])) problems.push(`${rel}: require ${m[1]}`);
    for (const m of src.matchAll(/(?<![\w$.])require\(\s*(?!["'])([^)]{0,40})\)/g)) problems.push(`${rel}: require não literal ${m[1]}`);
    for (const m of src.matchAll(/readFileSync\(\s*([^,)]{1,80})/g)) {
      const a = m[1].trim();
      if (/^new URL\(\s*["']/.test(a) || /^join\(ROOT,/.test(a) || /^f$/.test(a) || RUNTIME_READS_ALLOWED.has(a)) continue;
      problems.push(`${rel}: leitura de arquivo não literal ${a}`);
    }
  }
  return { files: [...seen].map((f) => relative(ROOT, f)), problems };
}

test("todo arquivo do fecho (código, testes, dados lidos) está coberto pelo filtro de caminhos", () => {
  const { files } = closure();
  assert.ok(files.length > 10, `fecho suspeito: ${files.length}`);
  for (const must of ["worker/cloudflare-worker.recovered.mjs", "tests/t4_sim/schema.sql", "tests/trava-vendas-gate-paths.test.mjs", WF_PATH === WF_PATH && "tests/t4_sim/hooks.mjs"]) assert.ok(files.includes(must), must);
  const fora = files.filter((f) => !covered(f));
  assert.deepEqual(fora, [], "arquivos fora do filtro: " + fora.join(", "));
  assert.ok(covered(WF_PATH), "o próprio workflow");
});

test("nenhuma entrada que escape da prova estática: import dinâmico calculado, require externo ou leitura não literal", () => {
  assert.deepEqual(closure().problems, []);
});

test("o gate exige contagem exata, roda este teste e nunca aceita teste pulado nem segredo", () => {
  for (const [file, n] of [["m", 21], ["p", 9], ["c", 7], ["g", 3]]) {
    assert.match(WF, new RegExp(`grep -qx "# tests ${n}" ${file}\\.txt && grep -qx "# pass ${n}" ${file}\\.txt && grep -qx "# skipped 0" ${file}\\.txt && grep -qx "# fail 0" ${file}\\.txt`), file);
  }
  assert.doesNotMatch(WF, /secrets\./);
  assert.match(WF, /permissions:\s*\n\s+contents: read/);
});
