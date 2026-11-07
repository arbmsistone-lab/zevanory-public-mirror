// T1, condição 1 e condição 5 (roteiro seção 15): detector AMPLIADO de caminhos que escrevem na Cloudflare
// (scripts/deploy/t1-write-scan.mjs) e inventário ops/publishers.json -> write_paths.
// WS1/WS2: fixtures positivas e negativas (tests/t1_scan/fixtures). WS3: scripts chamados pelos workflows.
// WS4: o repositório real está inteiro no inventário. WS5: cobre tudo o que o detector anterior cobria.
// WS6: testes NEGATIVOS isolados (repositório sintético em diretório temporário, sem rede, sem credencial):
// workflow publicador não registrado, guard ausente ou depois da escrita, troca de alvo de produção, token de
// outro Worker, credencial em workflow sem credencial, classe nova, entrada velha, script novo.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { scanText, scanRepo, scriptRefs, checkInventory, CLASSES } from "../scripts/deploy/t1-write-scan.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FX = new URL("t1_scan/fixtures/", import.meta.url);
const fixtures = readdirSync(FX).filter((f) => f.endsWith(".yml")).sort();
const header = (text) => ({ classes: text.match(/^# expect: ?(.*)$/m)[1].trim(), count: Number(text.match(/^# findings: (\d+)$/m)[1]) });
const classes = (found) => [...new Set(found.map((f) => f.cls))].sort().join(",");

test("WS1 fixtures positivas: cada forma de escrita é detectada com a classe e a quantidade certas", () => {
  const pos = fixtures.filter((f) => f.startsWith("pos-"));
  assert.ok(pos.length >= 13, "[WS1.1] fixtures positivas presentes");
  for (const f of pos) {
    const text = readTextNormalized(new URL(f, FX));
    const want = header(text);
    const got = scanText(text);
    assert.equal(classes(got), want.classes, `[WS1.2] ${f}: classes`);
    assert.equal(got.length, want.count, `[WS1.3] ${f}: quantidade de escritas`);
  }
  // Formas que o detector anterior não pegava (achado do levantamento).
  assert.equal(classes(scanText("run: npx wrangler versions secret put K --name zevanory")), "secret", "[WS1.4] versions secret");
  assert.equal(classes(scanText("run: npx --yes wrangler@4.135.0 kv key put k --path f --namespace-id N --remote")), "config-kv", "[WS1.5] kv key put");
  assert.equal(classes(scanText('curl -sS \\\n  -X POST \\\n  "https://api.cloudflare.com/client/v4/accounts/A/workers/scripts/zevanory/secrets"')), "secret", "[WS1.6] curl quebrado em linhas");
  assert.equal(classes(scanText('ops = [("PUT", f"{base}/{rid}", body, "updated")]\nbase = f"{API}/zones/{zid}/workers/routes"')), "route", "[WS1.7] rota por tupla de método");
  assert.deepEqual([...CLASSES], ["config-kv", "d1", "deploy", "route", "secret"], "[WS1.8] cinco classes");
});

test("WS2 fixtures negativas: dry-run, --local, leitura, comentário e POST para outro host não contam", () => {
  const neg = fixtures.filter((f) => f.startsWith("neg-"));
  assert.ok(neg.length >= 4, "[WS2.1] fixtures negativas presentes");
  for (const f of neg) {
    const text = readTextNormalized(new URL(f, FX));
    assert.deepEqual(scanText(text).map((x) => `${x.line}:${x.cls}`), [], `[WS2.2] ${f}: nenhuma escrita`);
  }
  assert.deepEqual(scanText("Why not `wrangler secret put`: it deploys an untagged version", { python: true }), [], "[WS2.3] prosa entre crases em Python");
  assert.equal(scanText("run: npx wrangler kv key put k v --namespace-id N --local --remote").length, 1, "[WS2.4] --local com --remote continua remoto");
  assert.deepEqual(scriptRefs(readTextNormalized(new URL("neg-paths-filter.yml", FX))), [], "[WS2.5] item de filtro paths não é chamada de script");
});

// Repositório sintético mínimo: workflows, scripts e registro.
function mkRepo({ workflows = {}, scripts = {}, registry }) {
  const dir = mkdtempSync(join(tmpdir(), "t1-ws-"));
  const put = (rel, text) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  for (const [n, t] of Object.entries(workflows)) put(`.github/workflows/${n}`, t);
  for (const [n, t] of Object.entries(scripts)) put(n, t);
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  put("ops/publishers.json", JSON.stringify(registry, null, 2));
  return dir;
}
const GUARD = Object.fromEntries(CLASSES.map((c) => [c, `guard exigido para a classe ${c} antes da escrita`]));
const PUB = `on: workflow_dispatch
concurrency:
  group: deploy-svc
jobs:
  a:
    environment: producao-critica
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - run: python3 scripts/deploy/promotion_guard.py --service svc --candidate "$GITHUB_SHA"
      - run: npx --yes wrangler@4.143.0 deploy --config wrangler.toml --tag "$GITHUB_SHA"
`;
const ISO = `on: workflow_dispatch
jobs:
  a:
    env:
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
    steps:
      - run: npx --yes wrangler@4.143.0 deploy --name svc-certification --config wrangler.cert.toml
`;
const NOCRED = `on: pull_request
jobs:
  a:
    steps:
      - run: python3 scripts/ci/gate.py
`;
function baseRegistry() {
  return {
    services: { svc: { group: "deploy-svc", canonical: "pub.yml", config_publishers: [] } },
    isolated: { "svc-certification": "iso.yml" },
    unserialized_known: {},
    write_paths: {
      guard_required: GUARD,
      workflows: {
        "pub.yml": { classes: ["deploy"], via: [], scope: "production", service: "svc", t1: "guarded", guard_evidence: ["promotion_guard\\.py --service svc"], controls: "guard + grupo + environment" },
        "iso.yml": { classes: ["deploy"], via: [], scope: "isolated", target: "svc-certification", t1: "gap", controls: "environment sandbox", gap: "token compartilhado da conta; alvo só por configuração" },
        "gate.yml": { classes: ["deploy"], via: ["scripts/ci/gate.py"], scope: "no-credential", note: "gate estático" },
      },
      scripts: { "scripts/ci/gate.py": { classes: ["deploy"], invoked_by: ["gate.yml"], role: "not-a-writer", findings: 1, note: "procura o texto do comando, não executa" } },
    },
  };
}
const GATE_PY = 'BAD = "npx wrangler deploy"  # texto procurado\n';
function repo(mut = (r) => r) {
  const r = mut({ workflows: { "pub.yml": PUB, "iso.yml": ISO, "gate.yml": NOCRED }, scripts: { "scripts/ci/gate.py": GATE_PY }, registry: baseRegistry() });
  return mkRepo(r);
}
const codes = (dir) => { try { return checkInventory(dir).map((e) => e.split(":")[0]); } finally { rmSync(dir, { recursive: true, force: true }); } };

test("WS3 scripts chamados pelos workflows entram por via, recursivamente; filtro de paths não", () => {
  const dir = mkRepo({
    workflows: { "w.yml": 'on:\n  push:\n    paths:\n      - "scripts/c.py"\njobs:\n  a:\n    steps:\n      - run: python3 scripts/a.py\n' },
    scripts: { "scripts/a.py": "import subprocess\nsubprocess.run(['node', 'scripts/b.mjs'])\n", "scripts/b.mjs": 'await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/storage/kv/namespaces/${N}/values/k`, { method: "PUT", body: "x" });\n', "scripts/c.py": 'subprocess.run(["npx", "wrangler", "deploy"])\n' },
    registry: {},
  });
  try {
    const s = scanRepo(dir);
    assert.deepEqual(s.workflows["w.yml"]?.via, ["scripts/b.mjs"], "[WS3.1] escritor indireto atribuído ao workflow");
    assert.deepEqual(s.workflows["w.yml"]?.classes, ["config-kv"], "[WS3.2] classe do escritor indireto");
    assert.deepEqual(s.scripts["scripts/b.mjs"]?.invoked_by, ["w.yml"], "[WS3.3] chamado por");
    assert.deepEqual(s.scripts["scripts/c.py"]?.invoked_by, [], "[WS3.4] script só no filtro de paths é operação manual, não chamada");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("WS4 repositório real: todo caminho de escrita está no inventário, com classe, escopo e guard coerentes", () => {
  const errors = checkInventory(ROOT);
  assert.deepEqual(errors, [], "[WS4.1] inventário write_paths coerente com a varredura");
  const reg = JSON.parse(readTextNormalized(new URL("../ops/publishers.json", import.meta.url)));
  const wp = reg.write_paths.workflows;
  for (const w of ["zees16-control-reconciler.yml", "voice-final-closure-reconcile.yml", "zevanory-close-sales.yml", "zevanory-f7-emergency-close-drill.yml", "system-matrix.yml", "command-center-snapshot.yml"]) {
    assert.ok(wp[w]?.classes.includes("config-kv") && wp[w].scope === "production", `[WS4.2] escritor de KV de produção inventariado: ${w}`);
  }
  assert.deepEqual(reg.write_paths.scripts["scripts/ops/router_routes.py"]?.classes, ["route"], "[WS4.3] router_routes.py inventariado como rota");
  assert.ok(reg.write_paths.scripts["scripts/ops/router_routes.py"].invoked_by.includes("public-router-deploy.yml"), "[WS4.4] chamado pelo publicador do roteador");
  const gaps = Object.entries(wp).filter(([, e]) => e.t1 === "gap").map(([k]) => k);
  assert.ok(gaps.length > 0 && gaps.every((k) => String(wp[k].gap).length > 30), "[WS4.5] cada lacuna T1 tem motivo escrito");
});

test("WS5 o detector ampliado cobre tudo o que o detector anterior (publisher-inventory) cobria", () => {
  const src = readTextNormalized(new URL("publisher-inventory.test.mjs", import.meta.url));
  const body = src.split("const PUBLISH = [")[1].split("\n];")[0];
  const old = [...body.matchAll(/^\s+(\/.+\/),?$/gm)].map((m) => new Function(`return ${m[1]}`)());
  assert.ok(old.length >= 5, "[WS5.1] padrões do detector anterior lidos");
  const wfDir = new URL("../.github/workflows/", import.meta.url);
  const now = scanRepo(ROOT).workflows;
  const missed = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f) && old.some((re) => re.test(readTextNormalized(new URL(f, wfDir)))) && !now[f]);
  assert.deepEqual(missed, [], "[WS5.2] nenhum workflow que o detector anterior pegava escapa do novo");
});

test("WS6 testes negativos (condição 5): o gate falha em cada violação, isolado de produção", () => {
  assert.deepEqual(codes(repo()), [], "[WS6.0] repositório sintético coerente");
  assert.ok(codes(repo((r) => { r.workflows["novo.yml"] = PUB.replace("svc --candidate", "svc2 --candidate"); return r; })).includes("UNREGISTERED_WRITE_PATH"), "[WS6.1] workflow publicador não registrado");
  assert.ok(codes(repo((r) => { r.workflows["pub.yml"] = PUB.replace(/( {6}- run: python3 scripts\/deploy\/promotion_guard[^\n]*\n)( {6}- run: npx[^\n]*\n)/, "$2$1"); return r; })).includes("GUARD_AFTER_WRITE"), "[WS6.2] guard depois da escrita");
  assert.ok(codes(repo((r) => { r.workflows["pub.yml"] = PUB.replace(/ {6}- run: python3 scripts\/deploy\/promotion_guard[^\n]*\n/, ""); return r; })).includes("GUARD_ABSENT"), "[WS6.3] sem guard");
  assert.ok(codes(repo((r) => { r.workflows["iso.yml"] = ISO.replace("--name svc-certification", "--name svc"); return r; })).includes("ISOLATED_TARGET_SWAP"), "[WS6.4] troca de alvo de produção num workflow isolado");
  assert.ok(codes(repo((r) => { r.workflows["iso.yml"] = ISO.replace("secrets.CLOUDFLARE_API_TOKEN", "secrets.CF_TOKEN_SALES"); return r; })).includes("TOKEN_CROSS_WORKER"), "[WS6.5] token de outro Worker (token excessivo para o alvo)");
  assert.ok(codes(repo((r) => { r.workflows["gate.yml"] = NOCRED.replace("    steps:", "    env:\n      T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n    steps:"); return r; })).includes("CREDENTIAL_IN_NO_CREDENTIAL"), "[WS6.6] credencial em workflow declarado sem credencial");
  assert.ok(codes(repo((r) => { r.workflows["pub.yml"] = PUB + "      - run: npx wrangler secret put K --name svc\n"; return r; })).includes("CLASS_MISMATCH"), "[WS6.7] classe nova num publicador");
  assert.ok(codes(repo((r) => { r.registry.write_paths.workflows["velho.yml"] = { classes: ["deploy"], via: [], scope: "no-credential", note: "x" }; return r; })).includes("STALE_WRITE_PATH"), "[WS6.8] entrada que não escreve mais");
  assert.ok(codes(repo((r) => { r.scripts["scripts/ci/gate.py"] = GATE_PY + 'subprocess.run(["npx", "wrangler", "rollback", "--name", "svc"])\n'; return r; })).includes("NOT_A_WRITER_CHANGED"), "[WS6.9] script declarado não escritor ganha escrita");
  assert.ok(codes(repo((r) => { r.workflows["pub.yml"] = PUB + "      - run: node scripts/ops/kv.mjs\n"; r.scripts["scripts/ops/kv.mjs"] = 'await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/storage/kv/namespaces/${N}/values/k`, { method: "PUT" });\n'; return r; })).includes("VIA_MISMATCH"), "[WS6.10] script escritor novo chamado por um publicador");
  assert.ok(codes(repo((r) => { r.registry.services.svc.canonical = "outro.yml"; r.workflows["outro.yml"] = PUB; r.registry.write_paths.workflows["outro.yml"] = { ...r.registry.write_paths.workflows["pub.yml"] }; return r; })).includes("PUBLISHER_NOT_IN_REGISTRY"), "[WS6.11] publicador de produção fora do registro de serviços");
});
