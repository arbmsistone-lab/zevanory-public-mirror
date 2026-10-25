// Fora de tests/*.test.mjs de propósito: depende de PyYAML (usa o inventário do gate scripts/ci/operator_token_gate.py),
// instalado pelo job r9-operator-token. Sol 233: o inventário de consumidores da credencial de operador em
// docs/ops/operator-token-transition.md é a fonte; este teste falha se aparecer um consumidor fora dele:
//   I1 todo job que lê ZEVANORY_OPERATOR_TOKEN/CERTIFICATION_E2E_TOKEN (inventário do gate) está no documento, e vice-versa;
//   I2 todo script em scripts/ que cita um dos nomes está no documento, e vice-versa;
//   I3 todo módulo do Worker que importa operator-credential.mjs ou cita um dos nomes está no documento, e vice-versa;
//   I4 a matriz de operator-token-consumer-auth.yml cobre exatamente os consumidores de produção new+fallback, cada um no
//      Environment dele, e prova com o readback somente leitura --require-primary usando só o nome novo;
//   I5 workflows de prova e de readback nunca disparam no merge.
// Cada asserção leva [In.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "../helpers/toolchain.mjs";
import { readTextNormalized } from "../helpers/text.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NAMES = /ZEVANORY_OPERATOR_TOKEN|CERTIFICATION_E2E_TOKEN/;
const rel = (p) => relative(ROOT, p).split(sep).join("/");
function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__pycache__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
function doc() {
  const text = readTextNormalized(join(ROOT, "docs", "ops", "operator-token-transition.md"));
  const m = text.match(/<!-- operator-token-inventory:begin -->\n```json\n([\s\S]*?)\n```\n<!-- operator-token-inventory:end -->/);
  assert.ok(m, "[I0.1] bloco de inventário ausente no documento");
  return JSON.parse(m[1]);
}
const sorted = (a) => [...a].sort();

test("I1 workflows: inventário do gate == documento", () => {
  requireTool("python3");
  const r = spawnSync("python3", [join(ROOT, "scripts", "ci", "operator_token_gate.py"), "--root", ROOT, "--json"], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, "[I0.2] gate sem JSON: " + String(r.stderr || r.stdout).slice(-300));
  const key = (x) => `${x.workflow}#${x.job} env=${x.environment} form=${x.form}`;
  const gate = sorted(JSON.parse(line).inventory.map(key));
  const listed = sorted(doc().workflows.map(key));
  assert.deepEqual(gate.filter((k) => !listed.includes(k)), [], "[I1.1] consumidor fora do inventário (adicione-o ao documento e à prova por consumidor)");
  assert.deepEqual(listed.filter((k) => !gate.includes(k)), [], "[I1.2] entrada do documento que não existe mais");
});

test("I2 scripts que citam um dos nomes == documento", () => {
  const found = sorted(walk(join(ROOT, "scripts"), [".py", ".mjs", ".js", ".sh"]).filter((f) => NAMES.test(readTextNormalized(f))).map(rel));
  const listed = sorted(doc().scripts.map((s) => s.path));
  assert.deepEqual(found.filter((k) => !listed.includes(k)), [], "[I2.1] script novo com a credencial fora do inventário");
  assert.deepEqual(listed.filter((k) => !found.includes(k)), [], "[I2.2] script do documento que não cita mais a credencial");
});

test("I3 módulos do Worker com a credencial == documento", () => {
  const files = [...walk(join(ROOT, "worker"), [".mjs", ".js"]), join(ROOT, "certification-worker.mjs")];
  const found = sorted(files.filter((f) => { const t = readTextNormalized(f); return NAMES.test(t) || /from\s+["']\.\/operator-credential\.mjs["']/.test(t); }).map(rel));
  const listed = sorted(doc().worker.map((w) => w.path));
  assert.deepEqual(found.filter((k) => !listed.includes(k)), [], "[I3.1] módulo do Worker com a credencial fora do inventário");
  assert.deepEqual(listed.filter((k) => !found.includes(k)), [], "[I3.2] módulo do documento sem a credencial");
});

function matrix() {
  const text = readTextNormalized(join(ROOT, ".github", "workflows", "operator-token-consumer-auth.yml"));
  const rows = [];
  for (const block of text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1)) {
    const env = (block.match(/\n    environment: ([a-z0-9-]+)\n/) || [])[1];
    const consumers = [...block.matchAll(/\n          - "([^"]+)"/g)].map((m) => m[1]);
    for (const c of consumers) rows.push(`${c} env=${env}`);
  }
  return { text, rows: sorted(rows) };
}

test("I4 prova por consumidor: matriz == consumidores de produção, Environment certo, só leitura, só o nome novo", () => {
  const { text, rows } = matrix();
  const expected = sorted(doc().workflows.filter((w) => w.form === "new+fallback").map((w) => `${w.workflow}#${w.job} env=${w.environment}`));
  assert.ok(expected.length > 0, "[I4.0] nenhum consumidor esperado (o teste não pode passar vazio)");
  assert.deepEqual(rows.filter((k) => !expected.includes(k)), [], "[I4.1] linha da matriz sem consumidor correspondente");
  assert.deepEqual(expected.filter((k) => !rows.includes(k)), [], "[I4.1] consumidor de produção sem prova por consumidor");
  assert.equal((text.match(/credential_identity_readback\.py https:\/\/zevanory\.api\.br --require-primary/g) || []).length, 2, "[I4.2] cada job prova com o readback somente leitura --require-primary");
  assert.doesNotMatch(text, /CERTIFICATION_E2E_TOKEN/, "[I4.3] a prova usa só o nome novo (sem queda)");
  assert.equal((text.match(/ZEVANORY_OPERATOR_TOKEN: \$\{\{ secrets\.ZEVANORY_OPERATOR_TOKEN \}\}/g) || []).length, 2, "[I4.3] nome novo nos dois jobs");
});

test("I5 prova e readback nunca disparam no merge", () => {
  for (const f of ["operator-token-consumer-auth.yml", "production-credential-identity.yml"]) {
    const text = readTextNormalized(join(ROOT, ".github", "workflows", f));
    const on = (text.match(/\non:\n([\s\S]*?)\n[a-z]/) || [])[1] || "";
    assert.deepEqual(on.split("\n").filter((l) => /^  [a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*/, "")), ["workflow_dispatch"], "[I5.1] só workflow_dispatch: " + f);
    assert.match(text, /if: \$\{\{ github\.ref == 'refs\/heads\/gh-pages' \}\}/, "[I5.1] só em gh-pages: " + f);
  }
});
