// P01 Fase A (AVAL 099, resíduo): a conferência "worker/fase-a-lia.generated.mjs = docs/lgpd/LIA-fase-a.md" roda
// DENTRO do check obrigatório "product-pages / static-audit" (os dois workflows que publicam esse nome), sem filtro
// de caminho (roda em todo PR para gh-pages, portanto sempre que a LIA ou o Worker mudam), e falha quando a LIA
// muda sem regenerar o manifesto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIRED = [".github/workflows/product-pages-premerge.yml", ".github/workflows/required-status-compat.yml"];
const CHECK = "node scripts/fase_a/lia_manifest.mjs --check", SELF = "node scripts/fase_a/lia_manifest.mjs --self-test";

// Bloco do job cujo name é "product-pages / static-audit" (até o próximo job de mesma indentação).
function jobBlock(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const i = lines.findIndex((l) => /^\s+name:\s*product-pages \/ static-audit\s*$/.test(l));
  assert.ok(i > 0, "job product-pages / static-audit ausente");
  const indent = lines[i - 1].match(/^(\s*)/)[1].length;
  let j = i + 1;
  while (j < lines.length && !(lines[j].trim() && lines[j].match(/^(\s*)/)[1].length <= indent)) j++;
  return lines.slice(i, j).join("\n");
}

test("check obrigatório product-pages / static-audit roda a conferência do manifesto da LIA e a prova negativa, sem filtro de caminho", () => {
  for (const rel of REQUIRED) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const on = text.split(/^jobs:/m)[0];
    assert.match(on, /pull_request:\s*\n\s+branches:\s*\n\s+- gh-pages/, rel + ": dispara em PR para gh-pages");
    assert.doesNotMatch(on, /paths(-ignore)?:/, rel + ": sem filtro de caminho (sempre roda, inclusive quando docs/ ou worker/ mudam)");
    const job = jobBlock(text);
    assert.ok(job.includes(CHECK) && job.includes(SELF), rel + ": passos da LIA no job obrigatório");
    assert.match(job, /set -euo pipefail\n\s+node scripts\/fase_a\/lia_manifest\.mjs --check/, rel + ": fail-closed");
    assert.match(job, /actions\/setup-node@v4/, rel + ": node disponível");
    // Reforço: os passos pré-existentes continuam lá.
    for (const s of ["premerge_product_audit.py", "zevanory_10p_excellence_gate.py", "test_crown_negative.py", "zevanory_crown_gate.py"]) assert.ok(job.includes("python3 scripts/" + s), rel + ": " + s);
  }
});

test("o passo falha quando a LIA muda sem regenerar o manifesto (cópia temporária), e passa intacto ou regenerado", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lia-req-"));
  for (const rel of ["docs/lgpd/LIA-fase-a.md", "worker/fase-a-lia.mjs", "worker/fase-a-lia.generated.mjs", "scripts/fase_a/lia_manifest.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
  }
  const run = (m) => spawnSync(process.execPath, [path.join(tmp, "scripts", "fase_a", "lia_manifest.mjs"), m], { encoding: "utf8" });
  assert.equal(run("--check").status, 0, "intacto");
  const lia = path.join(tmp, "docs", "lgpd", "LIA-fase-a.md");
  fs.writeFileSync(lia, fs.readFileSync(lia, "utf8").replace("## 1. Finalidade", "## 1. Finalidade (editada)"));
  const drift = run("--check");
  assert.equal(drift.status, 1, "LIA alterada sem regenerar => falha");
  assert.match(drift.stdout, /::error title=LIA_MANIFEST_DRIFT::/);
  // Manifesto adulterado à mão (sha256 trocado) também falha.
  assert.equal(run("--write").status, 0);
  assert.equal(run("--check").status, 0, "regenerado");
  const gen = path.join(tmp, "worker", "fase-a-lia.generated.mjs");
  fs.writeFileSync(gen, fs.readFileSync(gen, "utf8").replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${"0".repeat(64)}"`));
  assert.equal(run("--check").status, 1, "manifesto adulterado => falha");
  fs.rmSync(gen);
  assert.equal(run("--check").status, 1, "manifesto ausente => falha");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("prova negativa embutida no check obrigatório (--self-test) passa no repositório", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "fase_a", "lia_manifest.mjs"), "--self-test"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LIA_MANIFEST_SELF_TEST=PASS intact=0 drift=1 regenerated=0$/m);
});
