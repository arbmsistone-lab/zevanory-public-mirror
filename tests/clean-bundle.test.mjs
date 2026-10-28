// Round 7 of the PR #946 re-audit (M-1): the deployed Worker bundle is bound to the anchored sources of the commit.
// scripts/deploy/clean_bundle.py is exercised for real in temporary git repositories, with a stub bundler installed
// in a separate tools directory (--skip-install, test only: the stub records every call and builds a deterministic
// "bundle" from the bytes it is given, so a mutation of the sources shows up in the output). Markers [CBn.k].
// The real bundler run (npm ci of the pinned lockfile + wrangler 4.143.0, build and byte-for-byte rebuild of both
// Workers) is recorded in docs/evidence/pr946-round7-audit/.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync, chmodSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTool } from "./helpers/toolchain.mjs";
import { readTextNormalized } from "./helpers/text.mjs";

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
requireTool(PYTHON);
requireTool("git");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CB = join(REPO, "scripts/deploy/clean_bundle.py");
const SALES = ["sales-worker.mjs", "worker/sales-public-worker.mjs", "worker/politica-unica.mjs", "data/politica-unica.json",
  "wrangler.sales.toml", "scripts/ci/materialize_sales_configs.py", "scripts/deploy/wrangler-pin/package.json", "scripts/deploy/wrangler-pin/package-lock.json"];
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (root, ...args) => { const r = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { encoding: "utf8", env: GIT_ENV }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const commit = (root, msg) => { git(root, "add", "-A", "-f"); git(root, "commit", "-q", "-m", msg); return git(root, "rev-parse", "HEAD"); };
const put = (root, rel, text, mode) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); if (mode) chmodSync(join(root, rel), mode); };

// Stub bundler: `deploy --dry-run [--no-bundle] --config C --outdir D`. Bundling = header + every source file under
// the cwd (sorted, bytes); --no-bundle = copy of main. Every call is logged; nothing else is executed.
const STUB = `#!/usr/bin/env python3
import os, re, sys, json
from pathlib import Path
log = Path(__file__).resolve().parent.parent / "stub.log"  # clean_bundle.py gives the bundler a minimal env
with log.open("a") as f: f.write(json.dumps({"cwd": os.getcwd(), "argv": sys.argv[1:], "userconfig": os.environ.get("npm_config_userconfig")}) + "\\n")
a = sys.argv[1:]
if a[:1] == ["--version"]: print("4.143.0"); sys.exit(0)
cfg = a[a.index("--config") + 1]; out = Path(a[a.index("--outdir") + 1]); out.mkdir(parents=True, exist_ok=True)
text = Path(cfg).read_text()
main = (re.search(r'^main = "([^"]+)"', text, re.M) or [None, None])[1] or json.loads(text)["main"]
if "--no-bundle" in a:
    (out / Path(main).name).write_bytes(Path(main).read_bytes())
else:
    srcs = sorted(p for p in Path(".").rglob("*") if p.is_file() and p.suffix in (".mjs", ".json") and ".wrangler" not in p.parts)
    (out / (Path(main).stem + ".js")).write_bytes(b"// stub bundle\\n" + b"".join(b"// " + str(p).encode() + b"\\n" + p.read_bytes() for p in srcs))
    (out / (Path(main).stem + ".js.map")).write_text("{}")
`;
function tools() {
  const t = mkdtempSync(join(tmpdir(), "cb-tools-"));
  put(t, "node_modules/wrangler/package.json", JSON.stringify({ name: "wrangler", version: "4.143.0" }));
  put(t, "node_modules/.bin/wrangler", STUB, 0o755);
  put(t, "node_modules/.bin/wrangler.cmd", `@"${PYTHON}" "%~dp0wrangler" %*\r\n`);  // Windows: what npm would create
  return t;
}
function salesRepo() {
  const root = mkdtempSync(join(tmpdir(), "cb-repo-"));
  for (const rel of SALES) { mkdirSync(dirname(join(root, rel)), { recursive: true }); copyFileSync(join(REPO, rel), join(root, rel)); }
  git(root, "init", "-q", "-b", "main");
  return { root, sha: commit(root, "anchored sales sources") };
}
const PYENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", GITHUB_RUN_ID: "4242" };
function cb(root, sha, t, extra = [], env = {}) {
  const work = mkdtempSync(join(tmpdir(), "cb-work-"));
  const out = join(work, "out");
  const r = spawnSync(PYTHON, ["-I", CB, "sales", "--repo", root, "--rev", sha, "--tools", t, "--work", join(work, "clean"), "--out", out, "--skip-install", ...extra],
    { encoding: "utf8", env: { ...PYENV, ...env } });
  const logf = join(t, "node_modules", "stub.log");
  const log = existsSync(logf) ? readTextNormalized(logf).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), dir: out, work, log };
}
const cleanup = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test("CB1 the anchored sources of the commit build a release; the bundler runs only from the tools dir, in a clean dir with only those files", () => {
  const { root, sha } = salesRepo(); const t = tools();
  const r = cb(root, sha, t);
  try {
    assert.equal(r.code, 0, "[CB1.1] " + r.out);
    assert.match(r.out, /CLEAN_BUNDLE=BUILT kind=sales/, "[CB1.2]");
    assert.deepEqual(readdirSync(r.dir).sort(), ["MANIFEST.sha256", "sales-worker.deploy.js", "sales-worker.preview.js", "wrangler.sales.deploy.toml", "wrangler.sales.preview.toml"], "[CB1.3]");
    const bundles = r.log.filter((c) => c.argv.includes("--outdir") && !c.argv.includes("--no-bundle"));
    assert.equal(bundles.length, 2, "[CB1.4] deploy + preview: " + JSON.stringify(r.log));
    assert.equal(r.log.filter((c) => c.argv.includes("--no-bundle")).length, 2, "[CB1.4a] --no-bundle upload check for both configs");
    for (const c of r.log) {
      // Compare by the unique work-dir name: on Windows the cwd Python reports can be the long form of a short temp path.
      assert.ok(c.cwd.split("\\").join("/").includes("/" + basename(r.work) + "/clean/"), `[CB1.5] bundler ran outside the clean work dir: ${c.cwd}`);
      assert.equal(c.userconfig, "/dev/null", "[CB1.6] npm user config neutralized");
    }
    const src = join(r.work, "clean", "src");
    const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name).slice(src.length + 1).split("\\").join("/")).filter((p) => !p.startsWith(".wrangler/")).sort();
    assert.deepEqual(files, ["data/politica-unica.json", "sales-worker.mjs", "scripts/ci/materialize_sales_configs.py", "worker/politica-unica.mjs", "worker/sales-public-worker.mjs", "wrangler.sales.deploy.toml", "wrangler.sales.preview.toml", "wrangler.sales.toml"], "[CB1.7] only anchored sources (+ the generated configs)");
    const anchors = spawnSync(PYTHON, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import trust_anchor_guard as g, json; print(json.dumps([p for p in sys.argv[2:] if not g.is_anchor(p)]))", join(REPO, "scripts/p23"), ...SALES], { encoding: "utf8" });
    assert.equal(anchors.stdout.trim(), "[]", "[CB1.8] every sales source (and the pinned lockfile) is a trust anchor");
  } finally { cleanup(root, t, r.work); }
});

test("CB2 a committed node_modules/.bin/wrangler stub fails closed and is never executed", () => {
  const { root } = salesRepo(); const t = tools();
  const marker = join(root, "PWNED");
  put(root, "node_modules/.bin/wrangler", `#!/bin/sh\ntouch "${marker}"\n`, 0o755);
  const sha = commit(root, "committed wrangler stub");
  const r = cb(root, sha, t);
  try {
    assert.equal(r.code !== 0, true, "[CB2.1] " + r.out);
    assert.match(r.out, /CLEAN_BUNDLE=REFUSED the commit contains npm\/yarn configuration or packages: \['node_modules\/\.bin\/wrangler'\]/, "[CB2.2]");
    assert.equal(existsSync(marker), false, "[CB2.3] the committed stub never ran");
    assert.equal(r.log.length, 0, "[CB2.4] no bundler call at all");
  } finally { cleanup(root, t, r.work); }
});

test("CB3 a repository .npmrc (root or nested), package.json or yarn config fails closed", () => {
  for (const rel of [".npmrc", "worker/.npmrc", "package.json", "package-lock.json", ".yarnrc.yml", "data/node_modules/x.js"]) {
    const { root } = salesRepo(); const t = tools();
    put(root, rel, "registry=https://evil.invalid/\n");
    const sha = commit(root, "npm config " + rel);
    const r = cb(root, sha, t);
    try {
      assert.notEqual(r.code, 0, `[CB3.1] ${rel}: ${r.out}`);
      assert.ok(r.out.includes("CLEAN_BUNDLE=REFUSED") && r.out.includes(rel), `[CB3.2] ${rel}: ${r.out}`);
      assert.equal(r.log.length, 0, `[CB3.3] ${rel}: no bundler call`);
    } finally { cleanup(root, t, r.work); }
  }
});

test("CB4 a test-time mutation of the Worker source never reaches the release, and an artifact built from it is refused", () => {
  const { root, sha } = salesRepo(); const t = tools();
  const clean = cb(root, sha, t);
  // Round-6 attack: code running in the build workspace (a test) rewrites the Worker source before bundling.
  const p = join(root, "worker/sales-public-worker.mjs");
  writeFileSync(p, readTextNormalized(p).replace("export default", "/* INJECTED-BY-TEST */\nexport default"));
  const again = cb(root, sha, t, ["--verify", clean.dir]);
  // The artifact the round-6 build would have produced from the mutated working tree.
  const evil = mkdtempSync(join(tmpdir(), "cb-evil-"));
  try {
    assert.equal(clean.code, 0, "[CB4.1] " + clean.out);
    assert.equal(again.code, 0, "[CB4.2] the clean build ignores the working tree: " + again.out);
    assert.match(again.out, /CLEAN_BUNDLE_REPRODUCED=MATCH/, "[CB4.3]");
    assert.ok(!readTextNormalized(join(again.dir, "sales-worker.deploy.js")).includes("INJECTED-BY-TEST"), "[CB4.4] mutation absent from the release");
    cpSync(clean.dir, evil, { recursive: true });
    const ws = join(evil, "ws"); cpSync(join(clean.work, "clean", "src"), ws, { recursive: true });
    copyFileSync(p, join(ws, "worker/sales-public-worker.mjs"));  // same sources, plus the test-time mutation
    const stub = spawnSync(PYTHON, [join(t, "node_modules/.bin/wrangler"), "deploy", "--dry-run", "--config", "wrangler.sales.deploy.toml", "--outdir", join(evil, "b")], { cwd: ws, encoding: "utf8" });
    assert.equal(stub.status, 0, stub.stderr);
    copyFileSync(join(evil, "b", "sales-worker.js"), join(evil, "sales-worker.deploy.js"));
    rmSync(join(evil, "b"), { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true });
    assert.ok(readTextNormalized(join(evil, "sales-worker.deploy.js")).includes("INJECTED-BY-TEST"), "[CB4.5] the forged artifact carries the mutation");
    const deploy = cb(root, sha, t, ["--verify", evil]);
    assert.equal(deploy.code, 1, "[CB4.6] the deploy-side rebuild refuses the forged artifact: " + deploy.out);
    assert.match(deploy.out, /CLEAN_BUNDLE_MISMATCH::sales-worker\.deploy\.js/, "[CB4.7]");
    assert.match(deploy.out, /CLEAN_BUNDLE_REPRODUCED=MISMATCH/, "[CB4.8]");
    // An extra file in the artifact is refused too.
    cpSync(clean.dir, evil, { recursive: true }); writeFileSync(join(evil, "extra.js"), "x");
    const extra = cb(root, sha, t, ["--verify", evil]);
    assert.equal(extra.code, 1, "[CB4.9] " + extra.out);
  } finally { cleanup(root, t, clean.work, again.work, evil); }
});

test("CB5 the pinned tool: a lockfile without sha512 integrity, from another registry or with another wrangler version fails closed", () => {
  const lock = JSON.parse(readTextNormalized(join(REPO, "scripts/deploy/wrangler-pin/package-lock.json")));
  assert.equal(lock.packages["node_modules/wrangler"].version, "4.143.0", "[CB5.0]");
  for (const [label, fn, msg] of [
    ["no integrity", (l) => { delete l.packages["node_modules/wrangler"].integrity; }, /without registry\.npmjs\.org \+ sha512 integrity: node_modules\/wrangler/],
    ["other registry", (l) => { l.packages["node_modules/esbuild"].resolved = "https://evil.invalid/esbuild.tgz"; }, /node_modules\/esbuild/],
    ["other version", (l) => { l.packages["node_modules/wrangler"].version = "4.999.0"; }, /does not pin wrangler 4\.143\.0/],
  ]) {
    const { root } = salesRepo(); const t = tools();
    const l = structuredClone(lock); fn(l);
    put(root, "scripts/deploy/wrangler-pin/package-lock.json", JSON.stringify(l, null, 2));
    const sha = commit(root, label);
    const r = cb(root, sha, t);
    try {
      assert.notEqual(r.code, 0, `[CB5.1] ${label}: ${r.out}`);
      assert.match(r.out, msg, `[CB5.2] ${label}: ${r.out}`);
      assert.equal(r.log.length, 0, `[CB5.3] ${label}: no bundler call`);
    } finally { cleanup(root, t, r.work); }
  }
  // The lockfile is read from the commit, not from the working tree.
  const { root, sha } = salesRepo(); const t = tools();
  writeFileSync(join(root, "scripts/deploy/wrangler-pin/package-lock.json"), "{}");
  const r = cb(root, sha, t);
  try { assert.equal(r.code, 0, "[CB5.4] working-tree lockfile ignored: " + r.out); } finally { cleanup(root, t, r.work); }
});

test("CB6 an installed tool that is not wrangler 4.143.0 fails closed; a non-empty output dir is refused", () => {
  const { root, sha } = salesRepo(); const t = tools();
  put(t, "node_modules/wrangler/package.json", JSON.stringify({ name: "wrangler", version: "3.0.0" }));
  const r = cb(root, sha, t);
  const t2 = tools();
  const w = mkdtempSync(join(tmpdir(), "cb-busy-")); put(w, "out/old.js", "x");
  const busy = spawnSync(PYTHON, ["-I", CB, "sales", "--repo", root, "--rev", sha, "--tools", t2, "--work", join(w, "clean"), "--out", join(w, "out"), "--skip-install"], { encoding: "utf8", env: PYENV });
  try {
    assert.notEqual(r.code, 0, "[CB6.1] " + r.out);
    assert.match(r.out, /installed wrangler is '3\.0\.0'/, "[CB6.2]");
    assert.notEqual(busy.status, 0, "[CB6.3]");
    assert.match(busy.stdout + busy.stderr, /is not empty/, "[CB6.4]");
  } finally { cleanup(root, t, t2, r.work, w); }
});
