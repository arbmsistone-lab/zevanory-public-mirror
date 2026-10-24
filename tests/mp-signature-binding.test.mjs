// Roteiro seção 7 ("Amarração ao código publicado"): a região de assinatura Mercado Pago testada é a publicada.
// Prova offline (sem rede externa, sem segredo): definição da região (Python == JS, CRLF, âncoras), build-info
// (mp_signature_region_sha256 e bundle_sha256), guarda contra os patches de deploy (prepare-central-candidate real,
// base sintética mínima), readback GET-only contra servidor local, fiação nos workflows de deploy e certificação.
// Marcadores [Bn.k] identificam cada asserção (usados pelos mutantes de scripts/ci/mutants_mp_signature_binding.py).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { extractMpSignatureRegion } from "./helpers/mp-signature-region.mjs";

const ROOT = new URL("../", import.meta.url);
const rel = (p) => new URL(p, ROOT);
const WORKER_REL = "worker/cloudflare-worker.recovered.mjs";
const WORKER_SRC = readTextNormalized(rel(WORKER_REL));
const TESTED = extractMpSignatureRegion(WORKER_SRC).sha256;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const DEPLOY = ["build_provenance.py", "mp-signature-region.json", "write-build-info.py", "prepare-central-candidate.py",
  "verify-signature-region-binding.py", "verify-live-build-info.py", "prepare-certification-config.py", "public_whatsapp_scan.py"];

requireTool("python3");

function py(args, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn("python3", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(out.trim().split("\n").pop()); } catch { return null; } })() }));
  });
}

// Árvore mínima num diretório temporário: scripts/deploy, worker/ (só o necessário ao prepare) e o que for pedido.
function stage({ worker = true, extra = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zev-sigbind-test-"));
  const files = [...DEPLOY.map((f) => `scripts/deploy/${f}`), ...(worker ? [WORKER_REL, "worker/binding-aliases.mjs"] : []), ...extra];
  for (const f of files) {
    mkdirSync(join(d, ...f.split("/").slice(0, -1)), { recursive: true });
    copyFileSync(rel(f), join(d, ...f.split("/")));
  }
  return d;
}
const cleanup = (d) => rmSync(d, { recursive: true, force: true });
const PROV = ["scripts/deploy/build_provenance.py"];

test("B1 região: Python (build_provenance.py) e JS (helper do teste) dão o mesmo hash do Worker real", async () => {
  const r = await py([...PROV, "region"], { cwd: ROOT });
  assert.equal(r.code, 0, "[B1.1] build_provenance.py region falhou: " + r.err);
  assert.equal(r.json?.mp_signature_region_sha256, TESTED, "[B1.2] hash Python difere do hash da região testada (JS)");
});

test("B2 CRLF: o Worker com CRLF tem o mesmo hash (normalização de fim de linha)", async () => {
  const d = mkdtempSync(join(tmpdir(), "zev-sigbind-crlf-"));
  try {
    const f = join(d, "w.mjs");
    writeFileSync(f, WORKER_SRC.replace(/\n/g, "\r\n"));
    const r = await py([...PROV, "region", "--file", f], { cwd: ROOT });
    assert.equal(r.json?.mp_signature_region_sha256, TESTED, "[B2.1] Python com CRLF");
    assert.equal(extractMpSignatureRegion(readFileSync(f, "utf8")).sha256, TESTED, "[B2.2] JS com CRLF");
  } finally { cleanup(d); }
});

test("B3 âncora ausente ou duplicada fecha em falha (exit 2, nunca um hash)", async () => {
  const d = mkdtempSync(join(tmpdir(), "zev-sigbind-anchor-"));
  try {
    const fn = WORKER_SRC.slice(WORKER_SRC.indexOf("function verifyMercadoPagoSignature("));
    const dup = join(d, "dup.mjs"), miss = join(d, "miss.mjs");
    writeFileSync(dup, WORKER_SRC + "\n" + fn.slice(0, fn.indexOf("__name(verifyMercadoPagoSignature")));
    writeFileSync(miss, WORKER_SRC.replace("function normalizeMercadoPagoWebhook(", "function normalizeMercadoPagoWebhookX("));
    const a = await py([...PROV, "region", "--file", dup], { cwd: ROOT });
    assert.ok(a.code === 2 && /REGION_ANCHOR_NOT_UNIQUE/.test(a.out) && !a.json?.mp_signature_region_sha256, "[B3.1] duplicada: " + a.out);
    const b = await py([...PROV, "region", "--file", miss], { cwd: ROOT });
    assert.ok(b.code === 2 && /REGION_ANCHOR_NOT_UNIQUE|REGION_ANCHOR_NOT_FOUND/.test(b.out) && !b.json?.mp_signature_region_sha256, "[B3.2] ausente: " + b.out);
    assert.throws(() => extractMpSignatureRegion(readFileSync(dup, "utf8")), /REGION_ANCHOR_NOT_UNIQUE/, "[B3.3] JS duplicada");
  } finally { cleanup(d); }
});

test("B4 write-build-info.py: sha/source/repository inalterados e mp_signature_region_sha256 da região testada", async () => {
  const d = stage();
  try {
    mkdirSync(join(d, "public"));
    const r = await py(["scripts/deploy/write-build-info.py"], { cwd: d, env: { TARGET_RUNTIME_SHA: "a".repeat(40), GITHUB_REPOSITORY: "o/r" } });
    assert.equal(r.code, 0, "[B4.0] " + r.err);
    const j = JSON.parse(readTextNormalized(join(d, "public", "build-info.json")));
    assert.deepEqual(Object.keys(j), ["sha", "source", "repository", "mp_signature_region_sha256"], "[B4.1] campos");
    assert.deepEqual([j.sha, j.source, j.repository], ["a".repeat(40), "github-actions-cloudflare", "o/r"], "[B4.2] valores anteriores");
    assert.equal(j.mp_signature_region_sha256, TESTED, "[B4.3] região publicada == região testada");
  } finally { cleanup(d); }
});

test("B5 --bundle-dir: bundle_sha256 do único módulo (README e .map fora); 0 ou 2 módulos, ou build-info incompleto, falham", async () => {
  const d = stage();
  try {
    mkdirSync(join(d, "public"));
    const env = { TARGET_RUNTIME_SHA: "b".repeat(40), GITHUB_REPOSITORY: "o/r" };
    assert.equal((await py(["scripts/deploy/write-build-info.py"], { cwd: d, env })).code, 0);
    const out = join(d, "out");
    mkdirSync(out);
    writeFileSync(join(out, "cloudflare-worker.compat.js"), "export default {fetch(){}};\n");
    writeFileSync(join(out, "cloudflare-worker.compat.js.map"), `{"sourceRoot":"${Date.now()}"}`);
    writeFileSync(join(out, "README.md"), `generated at ${new Date().toISOString()}`);
    const before = JSON.parse(readTextNormalized(join(d, "public", "build-info.json")));
    const r = await py(["scripts/deploy/write-build-info.py", "--bundle-dir", out], { cwd: d });
    assert.equal(r.code, 0, "[B5.0] " + r.err);
    const j = JSON.parse(readTextNormalized(join(d, "public", "build-info.json")));
    assert.equal(j.bundle_sha256, sha("export default {fetch(){}};\n"), "[B5.1] hash do único módulo");
    assert.deepEqual({ ...j, bundle_sha256: undefined }, { ...before, bundle_sha256: undefined }, "[B5.2] demais campos preservados");
    writeFileSync(join(out, "chunk.mjs"), "export const x=1;\n");
    const two = await py(["scripts/deploy/write-build-info.py", "--bundle-dir", out], { cwd: d });
    assert.ok(two.code !== 0 && /BUNDLE_NOT_SINGLE_MODULE/.test(two.err), "[B5.3] dois módulos aceitos: " + two.err);
    const empty = join(d, "empty");
    mkdirSync(empty);
    writeFileSync(join(empty, "README.md"), "x");
    const zero = await py(["scripts/deploy/write-build-info.py", "--bundle-dir", empty], { cwd: d });
    assert.ok(zero.code !== 0 && /BUNDLE_NOT_SINGLE_MODULE/.test(zero.err), "[B5.4] nenhum módulo aceito: " + zero.err);
    writeFileSync(join(d, "public", "build-info.json"), JSON.stringify({ sha: "b".repeat(40), source: "s", repository: "o/r" }));
    rmSync(join(out, "chunk.mjs"));
    const inc = await py(["scripts/deploy/write-build-info.py", "--bundle-dir", out], { cwd: d });
    assert.ok(inc.code !== 0 && /BUILD_INFO_INCOMPLETE/.test(inc.err), "[B5.5] build-info sem região aceito: " + inc.err);
  } finally { cleanup(d); }
});

// Base estática sintética mínima para o prepare-central-candidate (as fixtures mínimas que ele já aceita).
function fakeBase(d) {
  mkdirSync(join(d, "base", "public"), { recursive: true });
  writeFileSync(join(d, "base", "wrangler.jsonc"), JSON.stringify({ name: "zevanory", main: "x.mjs", vars: {} }));
  writeFileSync(join(d, "base", "public", "solucoes.html"), "<html><body>catalogo</body></html>\n");
  writeFileSync(join(d, "base", "public", "sitemap.xml"), "<urlset></urlset>\n");
  return join(d, "base");
}
function badPrepare(d, name, injected) {
  const src = readTextNormalized(rel("scripts/deploy/prepare-central-candidate.py"));
  const anchor = 'recovered.write_text(recovered_src,encoding="utf-8")';
  assert.equal(src.split(anchor).length - 1, 1, "âncora do prepare mudou");
  const f = join(d, name);
  writeFileSync(f, src.replace(anchor, injected === null ? "pass" : injected + "\n" + anchor));
  return f;
}

test("B6 guarda: os patches reais preservam a região; patch que toca a região, troca o import ou não patcheia falha", async () => {
  const d = stage();
  try {
    const base = fakeBase(d);
    const guard = (extra = []) => py(["scripts/deploy/verify-signature-region-binding.py", "--repo", d, "--base-dir", base, ...extra], { cwd: d });
    const ok = await guard();
    assert.ok(ok.code === 0 && ok.json?.MP_SIGNATURE_REGION_BINDING === "PASS" && ok.json.modes.length === 2
      && ok.json.modes.every((m) => m.worker_patched && m.region_after_patch === TESTED && m.build_info === TESTED),
      "[B6.1] prepare real: " + ok.out.slice(0, 600));
    const region = await guard(["--prepare", badPrepare(d, "p1.py", 'recovered_src = recovered_src.replace("Math.abs(now - tsMs) > 10 * 60 * 1e3", "Math.abs(now - tsMs) > 60 * 60 * 1e3", 1)')]);
    assert.ok(region.code === 1 && region.json?.modes?.every((m) => m.problems.includes("REGION_CHANGED_BY_DEPLOY_PATCH")),
      "[B6.2] patch na região passou: " + region.out.slice(0, 600));
    const imp = await guard(["--prepare", badPrepare(d, "p2.py", 'recovered_src = recovered_src.replace(\'import crypto5 from "node:crypto";\', \'import crypto5 from "./crypto-shim.mjs";\', 1)')]);
    assert.ok(imp.code === 1 && imp.json?.modes?.every((m) => m.problems.includes("FREE_IDENTIFIER_LINES_CHANGED_BY_DEPLOY_PATCH")
      && m.region_after_patch === TESTED), "[B6.3] troca do import de crypto5 passou: " + imp.out.slice(0, 600));
    const none = await guard(["--prepare", badPrepare(d, "p3.py", null)]);
    assert.ok(none.code === 1 && none.json?.modes?.every((m) => m.problems.includes("PREPARE_DID_NOT_PATCH_WORKER")),
      "[B6.4] comparação vazia passou: " + none.out.slice(0, 600));
    const wbi = join(d, "scripts", "deploy", "write-build-info.py");
    writeFileSync(wbi, readTextNormalized(wbi).replace('"mp_signature_region_sha256": bp.region_sha256_file()', '"mp_signature_region_sha256": "0" * 64'));
    const rec = await guard();
    assert.ok(rec.code === 1 && rec.json?.modes?.every((m) => m.problems.includes("BUILD_INFO_REGION_DIFFERS_FROM_TESTED")),
      "[B6.5] build-info com outra região passou: " + rec.out.slice(0, 600));
  } finally { cleanup(d); }
});

test("B7 readback pós-deploy: só GET; passa só com sha, região e bundle iguais", async () => {
  let body = "{}";
  const methods = [];
  const srv = http.createServer((req, res) => { methods.push(req.method); res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/build-info.json`;
  const d = mkdtempSync(join(tmpdir(), "zev-sigbind-rb-"));
  try {
    const local = join(d, "local.json");
    writeFileSync(local, JSON.stringify({ bundle_sha256: "c".repeat(64) }));
    const S = "d".repeat(40);
    const run = (live, extra = []) => { body = JSON.stringify(live); return py(["scripts/deploy/verify-live-build-info.py", "--url", url,
      "--expected-sha", S, "--source-file", WORKER_REL, "--attempts", "1", "--sleep", "0", ...extra], { cwd: ROOT }); };
    const good = { sha: S, source: "github-actions-cloudflare", mp_signature_region_sha256: TESTED, bundle_sha256: "c".repeat(64) };
    const ok = await run(good, ["--local-build-info", local]);
    assert.ok(ok.code === 0 && ok.json?.LIVE_BUILD_INFO_READBACK === "PASS", "[B7.1] leitura correta recusada: " + ok.out);
    const reg = await run({ ...good, mp_signature_region_sha256: "e".repeat(64) });
    assert.ok(reg.code === 1 && reg.json?.problems?.includes("LIVE_MP_SIGNATURE_REGION_MISMATCH"), "[B7.2] região divergente aceita: " + reg.out);
    const miss = await run({ sha: S });
    assert.ok(miss.code === 1 && miss.json?.problems?.includes("LIVE_MP_SIGNATURE_REGION_MISMATCH"), "[B7.3] campo ausente aceito: " + miss.out);
    const wsha = await run({ ...good, sha: "f".repeat(40) });
    assert.ok(wsha.code === 1 && wsha.json?.problems?.includes("LIVE_SHA_MISMATCH"), "[B7.4] sha divergente aceito: " + wsha.out);
    const bun = await run({ ...good, bundle_sha256: "0".repeat(64) }, ["--local-build-info", local]);
    assert.ok(bun.code === 1 && bun.json?.problems?.includes("LIVE_BUNDLE_SHA256_MISMATCH"), "[B7.5] bundle divergente aceito: " + bun.out);
    assert.ok(methods.length >= 5 && methods.every((m) => m === "GET"), "[B7.6] método diferente de GET: " + methods.join(","));
  } finally { srv.close(); cleanup(d); }
});

const wf = (n) => readTextNormalized(rel(`.github/workflows/${n}`));
function step(text, name) {
  const i = text.indexOf(`- name: ${name}`);
  if (i < 0) return "";
  const j = text.indexOf("\n      - ", i + 1);
  return text.slice(i, j < 0 ? undefined : j);
}

test("B8 fiação: dry-run do PR roda a guarda; publicador grava bundle após o dry-run e lê de volta depois do rollback", () => {
  const dry = wf("central-candidate-dryrun.yml");
  assert.ok(dry.includes("python3 scripts/deploy/verify-signature-region-binding.py --base 83620c680958d726fc4b0fd16e2574cdcc362a6d --source-ref HEAD")
    && dry.includes("--file worker/cloudflare-worker.recovered.mjs --expect-build-info public/build-info.json")
    && dry.includes('test "$a" = "$b"'), "[B8.1] dry-run sem guarda/determinismo");
  const prod = wf("central-production-deploy.yml");
  const rec = step(prod, "Reconstruct exact production candidate");
  const iw = rec.indexOf("python3 scripts/deploy/write-build-info.py\n"), ip = rec.indexOf("python3 scripts/deploy/prepare-central-candidate.py");
  const idr = rec.indexOf("--outdir /tmp/central-final"), ib = rec.indexOf("python3 scripts/deploy/write-build-info.py --bundle-dir /tmp/central-final");
  assert.ok(iw > 0 && iw < ip && idr > ip && ib > idr, "[B8.2] ordem write-build-info -> prepare -> dry-run -> --bundle-dir");
  const rb = step(prod, "Read back live build-info signature region (GET only, after deploy)");
  const order = (n) => prod.indexOf(`- name: ${n}`);
  assert.ok(rb && order("Read back live build-info signature region (GET only, after deploy)") > order("Automatic rollback after failed post-deploy smoke")
    && rb.includes("\n        if: steps.auth.outputs.available == 'true' && steps.deployworker.outcome == 'success'\n")
    && !/continue-on-error/.test(rb)
    && rb.includes('verify-live-build-info.py --url https://zevanory.api.br/build-info.json')
    && rb.includes('--source-ref "$TARGET_RUNTIME_SHA"'), "[B8.3] readback ausente, antes do rollback ou sem falhar");
  const cb = readTextNormalized(rel("scripts/ci/cloudflare-build.sh"));
  assert.ok(cb.indexOf("python3 scripts/deploy/write-build-info.py --bundle-dir /tmp/central-final") > cb.indexOf("--outdir /tmp/central-final"),
    "[B8.4] build reserva sem bundle_sha256");
});

test("B9 certificação: config carrega o hash e confere com o build-info; o Worker ecoa o campo; o workflow confere", async () => {
  assert.match(readTextNormalized(rel("certification-worker.mjs")), /mp_signature_region_sha256:env\.CERTIFICATION_MP_SIGNATURE_REGION_SHA256\}/, "[B9.1] eco ausente");
  const d = stage();
  try {
    writeFileSync(join(d, "wrangler.central-fix.jsonc"), JSON.stringify({ compatibility_date: "2026-09-19", kv_namespaces: [], d1_databases: [] }));
    const env = { CLOUDFLARE_ACCOUNT_ID: "1b26415802588185a86c1d4d3ebf5bdb", TARGET_RUNTIME_SHA: "3".repeat(40), CERTIFICATION_KV_ID: "", CERTIFICATION_D1_ID: "" };
    const r = await py(["scripts/deploy/prepare-certification-config.py"], { cwd: d, env });
    assert.equal(r.code, 0, "[B9.0] " + r.err);
    const cfg = JSON.parse(readTextNormalized(join(d, "wrangler.certification.generated.jsonc")));
    assert.equal(cfg.vars.CERTIFICATION_MP_SIGNATURE_REGION_SHA256, TESTED, "[B9.2] var da região");
    mkdirSync(join(d, "public"));
    writeFileSync(join(d, "public", "build-info.json"), JSON.stringify({ mp_signature_region_sha256: "9".repeat(64) }));
    const bad = await py(["scripts/deploy/prepare-certification-config.py"], { cwd: d, env });
    assert.ok(bad.code !== 0 && /MP_SIGNATURE_REGION_BUILD_INFO_MISMATCH/.test(bad.err), "[B9.3] build-info divergente aceito: " + bad.err);
  } finally { cleanup(d); }
  const cert = wf("certification-isolated-deploy.yml");
  assert.ok(cert.includes('build_provenance.py region --git-ref \\"$EXPECTED_SHA\\"')
    && cert.includes("j.get('mp_signature_region_sha256')==sys.argv[1]")
    && cert.includes('\\"mp_signature_region_sha256\\":region,\\"bundle_sha256\\":bundle'), "[B9.4] workflow de certificação não confere/registra");
});
