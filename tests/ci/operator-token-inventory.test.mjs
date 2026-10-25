// Fora de tests/*.test.mjs de propósito: depende de PyYAML (usa o inventário do gate scripts/ci/operator_token_gate.py),
// instalado pelo job r9-operator-token. Sol 233: o inventário de consumidores da credencial de operador em
// docs/ops/operator-token-transition.md é a fonte; este teste falha se aparecer um consumidor fora dele:
//   I1 todo job que lê ZEVANORY_OPERATOR_TOKEN/CERTIFICATION_E2E_TOKEN (inventário do gate) está no documento, e vice-versa;
//   I2 todo script em scripts/ que cita um dos nomes está no documento, e vice-versa;
//   I3 todo módulo do Worker que importa operator-credential.mjs ou cita um dos nomes está no documento, e vice-versa;
//   I4 a matriz de operator-token-consumer-auth.yml cobre exatamente os consumidores de produção new+fallback, cada um no
//      Environment dele, e prova com o readback somente leitura --require-primary usando só o nome novo;
//   I5 workflows de prova e de readback nunca disparam no merge;
//   I6 (Sol 237) o job control-edge-t2-hmac prova os chamadores do verificador externo (exatamente os 4 jobs T2 do
//      inventário "external"), no Environment deles, só com o nome novo, pela sonda sem efeito colateral --require-primary;
//   I7 a sonda assina com a canônica separada, exige primary, falha fechada e nunca imprime o valor.
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

const HMAC_JOB = "control-edge-t2-hmac";
function hmacJob(text) {
  const block = text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1).find((b) => b.startsWith(HMAC_JOB + ":")) || "";
  return { block, env: (block.match(/\n    environment: ([a-z0-9-]+)\n/) || [])[1], rows: sorted([...block.matchAll(/\n          - "([^"]+)"/g)].map((m) => m[1])) };
}

function matrix() {
  const text = readTextNormalized(join(ROOT, ".github", "workflows", "operator-token-consumer-auth.yml"));
  const rows = [];
  for (const block of text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1)) {
    if (block.startsWith(HMAC_JOB + ":")) continue;
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
  assert.equal((text.match(/ZEVANORY_OPERATOR_TOKEN: \$\{\{ secrets\.ZEVANORY_OPERATOR_TOKEN \}\}/g) || []).length, 3, "[I4.3] nome novo nos três jobs");
});

test("I5 prova e readback nunca disparam no merge", () => {
  for (const f of ["operator-token-consumer-auth.yml", "production-credential-identity.yml"]) {
    const text = readTextNormalized(join(ROOT, ".github", "workflows", f));
    const on = (text.match(/\non:\n([\s\S]*?)\n[a-z]/) || [])[1] || "";
    assert.deepEqual(on.split("\n").filter((l) => /^  [a-z_]+:/.test(l)).map((l) => l.trim().replace(/:.*/, "")), ["workflow_dispatch"], "[I5.1] só workflow_dispatch: " + f);
    assert.match(text, /if: \$\{\{ github\.ref == 'refs\/heads\/gh-pages' \}\}/, "[I5.1] só em gh-pages: " + f);
  }
});

test("I6 prova T2 no Worker de controle: chamadores externos == matriz, Environment deles, sonda sem efeito colateral", () => {
  const text = readTextNormalized(join(ROOT, ".github", "workflows", "operator-token-consumer-auth.yml"));
  const { block, env, rows } = hmacJob(text);
  assert.ok(block, "[I6.1] job control-edge-t2-hmac ausente");
  const ext = doc().external.find((e) => /controle\.zevanory\.api\.br/.test(e.name));
  assert.ok(ext, "[I6.1] verificador externo ausente do inventário");
  const callers = sorted(ext.callers.map((c) => doc().workflows.find((w) => w.workflow === c)).map((w) => `${w.workflow}#${w.job}`));
  assert.equal(callers.length, 4, "[I6.1] os 4 jobs T2");
  assert.deepEqual(rows, callers, "[I6.2] matriz HMAC == chamadores do verificador externo");
  for (const c of ext.callers) assert.equal(doc().workflows.find((w) => w.workflow === c).environment, env, "[I6.3] Environment do chamador");
  assert.match(block, /\n          node scripts\/ci\/control_edge_hmac_probe\.mjs --require-primary\n/, "[I6.4] sonda --require-primary");
  assert.match(block, /\n      ZEVANORY_OPERATOR_TOKEN: \$\{\{ secrets\.ZEVANORY_OPERATOR_TOKEN \}\}\n/, "[I6.5] só o nome novo");
  assert.doesNotMatch(block, /CERTIFICATION_E2E_TOKEN|factory\/tick|creative\/upload|creative\/background|publish\//, "[I6.6] nenhuma rota com efeito colateral, nenhuma queda");
});

test("I7 sonda: canônica separada, exige primary, falha fechada, sem valor na saída", async () => {
  const { createServer } = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const { runProbe, PROBE_PURPOSE, PROBE_PATH } = await import("../../scripts/ci/control_edge_hmac_probe.mjs");
  const NEW = "n".repeat(40), OLD = "o".repeat(40);
  let answer = "primary";
  const server = createServer((req, res) => {
    const ts = req.headers["x-commercial-timestamp"], nonce = req.headers["x-commercial-nonce"], sig = req.headers["x-commercial-signature"];
    const ok = (s) => createHmac("sha256", s).update([PROBE_PURPOSE, ts, nonce].join("\n")).digest("hex") === sig;
    if (req.method !== "POST" || req.url !== PROBE_PATH) { res.writeHead(404); return res.end("{}"); }
    const hit = ok(NEW) ? answer : ok(OLD) ? "legacy" : "";
    res.writeHead(hit ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(hit ? { ok: true, category: hit, migration: "open", sideEffects: "none" } : { ok: false }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const pass = await runProbe({ env: { ZEVANORY_OPERATOR_TOKEN: NEW, CONTROL_EDGE_PROBE_ORIGIN: origin }, requirePrimary: true });
    assert.equal(pass.CONTROL_EDGE_HMAC_PROBE, "PASS", "[I7.1] valor novo aceito como primary: " + JSON.stringify(pass));
    const legacy = await runProbe({ env: { ZEVANORY_OPERATOR_TOKEN: OLD, CONTROL_EDGE_PROBE_ORIGIN: origin }, requirePrimary: true });
    assert.equal(legacy.REASON, "RUNNER_TOKEN_NOT_PRIMARY", "[I7.2] antigo aceito não basta");
    answer = "tick";
    const tick = await runProbe({ env: { ZEVANORY_OPERATOR_TOKEN: NEW, CONTROL_EDGE_PROBE_ORIGIN: origin }, requirePrimary: true });
    assert.equal(tick.REASON, "RUNNER_TOKEN_NOT_PRIMARY", "[I7.2] tick não basta");
    const unknown = await runProbe({ env: { ZEVANORY_OPERATOR_TOKEN: "u".repeat(40), CONTROL_EDGE_PROBE_ORIGIN: origin }, requirePrimary: true });
    assert.equal(unknown.REASON, "CREDENTIAL_NOT_ACCEPTED", "[I7.3] desconhecido recusado");
    const absent = await runProbe({ env: { CONTROL_EDGE_PROBE_ORIGIN: origin }, requirePrimary: true });
    assert.equal(absent.REASON, "RUNNER_TOKEN_ABSENT_OR_SHORT", "[I7.3] sem credencial falha fechada");
    const foreign = await runProbe({ env: { ZEVANORY_OPERATOR_TOKEN: NEW, CONTROL_EDGE_PROBE_ORIGIN: "https://example.com" }, requirePrimary: true });
    assert.equal(foreign.REASON, "ORIGIN_REFUSED", "[I7.4] origem alheia recusada (a credencial nunca sai para outro host)");
    for (const r of [pass, legacy, tick, unknown, absent, foreign]) assert.equal(JSON.stringify(r).includes("nnnnnnnn") || JSON.stringify(r).includes("oooooooo"), false, "[I7.5] nunca imprime o valor");
  } finally { server.close(); }
});
