// Guarda de portabilidade da suíte Node (AVAL Sol 081, #865). Fica FORA de tests/*.test.mjs de propósito:
// a suíte principal mantém a contagem exata 573 (literal até o rebase sobre o manifesto do #874) e este
// guarda tem passo e contagem exata próprios nos workflows trava-vendas-integracao-postgres e
// node-suite-windows. Regras R1–R5 documentadas em tests/helpers/portability-guard.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { checkFile, TEXT_READ_ALLOWLIST } from "../helpers/portability-guard.mjs";
import { readTextNormalized, normalizeEol } from "../helpers/text.mjs";
import { requireTool } from "../helpers/toolchain.mjs";

const dir = new URL("../", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

test("toda tests/*.test.mjs respeita R1–R5 (helper de texto, preflight de ferramenta, tmp único)", () => {
  assert.ok(files.length >= 80, `suíte suspeita: ${files.length} arquivos`);
  const problems = files.flatMap((f) => checkFile(f, readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(problems, []);
  for (const a of TEXT_READ_ALLOWLIST) assert.ok(files.includes(a), `allowlist aponta para arquivo inexistente: ${a}`);
});

test("o verificador detecta cada violação (mutantes sintéticos) e aceita a forma canônica", () => {
  const rd = 'import { readFileSync } from "node:fs";\nconst s = readFileSync("x.yml", "utf8");\nassert.match(s, /a\\nb/);\n';
  assert.deepEqual(checkFile("novo.test.mjs", rd, new Set()), ["TEXT_READ_WITHOUT_HELPER novo.test.mjs"]);
  const ok = 'import { readTextNormalized } from "./helpers/text.mjs";\nconst s = readTextNormalized("x.yml");\nassert.match(s, /a/);\n';
  assert.deepEqual(checkFile("ok.test.mjs", ok, new Set()), []);
  assert.deepEqual(checkFile("ad.test.mjs", ok + 'readFileSync("y", "utf8").replace(/\\r\\n/g, "\\n");\n', new Set()), ["ADHOC_EOL_REPLACE ad.test.mjs"]);
  assert.deepEqual(checkFile("ok.test.mjs", ok, new Set(["ok.test.mjs"])), ["STALE_ALLOWLIST ok.test.mjs"]);
  assert.deepEqual(checkFile("allow.test.mjs", rd, new Set(["allow.test.mjs"])), []);
  for (const tool of ["python3", "jq", "bash"]) {
    const sp = `spawnSync("${tool}", ["-c", "x"]);\n`;
    assert.deepEqual(checkFile("t.test.mjs", sp, new Set()), [`TOOL_WITHOUT_PREFLIGHT t.test.mjs: ${tool}`]);
    assert.deepEqual(checkFile("t.test.mjs", `requireTool("${tool}");\n` + sp, new Set()), []);
  }
  assert.deepEqual(checkFile("tmp.test.mjs", 'const out = "/tmp/zevanory-pack-test";\n', new Set()), ["FIXED_TMP_PATH tmp.test.mjs"]);
  assert.deepEqual(checkFile("tmp.test.mjs", 'execFileSync("node", [], { cwd: process.env.TMPDIR || "/tmp" });\n', new Set()), ["FIXED_TMP_PATH tmp.test.mjs"]);
  assert.deepEqual(checkFile("tmp.test.mjs", 'const out = "C:\\\\tmp\\\\x";\n', new Set()), ["FIXED_TMP_PATH tmp.test.mjs"]);
});

test("helpers: CRLF vira LF e ferramenta ausente falha com TOOL_MISSING explícito", () => {
  assert.equal(normalizeEol("a\r\nb\r\n"), "a\nb\n");
  assert.equal(readTextNormalized(new URL("../helpers/text.mjs", import.meta.url)).includes("\r"), false);
  assert.throws(() => requireTool("zevanory-ferramenta-inexistente-081"), /^Error: TOOL_MISSING: zevanory-ferramenta-inexistente-081 \(/);
  assert.match(requireTool("node"), /^v\d+/);
});
