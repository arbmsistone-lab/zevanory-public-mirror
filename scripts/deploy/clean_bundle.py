#!/usr/bin/env python3
"""ZEVANORY | Clean, reproducible Worker build (re-audit of PR #946, round 7, M-1).

Builds the release of a Worker ONLY from bytes of a commit, never from a working tree that other code (tests, build
scripts) may have touched, and runs the bundler ONLY from an integrity-pinned install outside the repository.

  1. The repository tree at --rev must not contain npm/yarn/pnpm configuration or packages (.npmrc, .yarnrc*,
     package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, npm-shrinkwrap.json, .pnpmfile.cjs, bunfig.toml,
     node_modules/**) outside scripts/deploy/wrangler-pin/. Anything else fails closed (CLEAN_BUNDLE=REFUSED).
  2. The sources are copied with `git archive <rev> -- <allowlisted paths>` into a fresh directory:
       sales    only the trust anchors that make up the sales Worker (sales-worker.mjs, worker/sales-public-worker.mjs,
                worker/politica-unica.mjs, data/politica-unica.json, wrangler.sales.toml and the config generator
                scripts/ci/materialize_sales_configs.py);
       central  the inputs of the central candidate (worker/, data/, scripts/deploy/, admin.css, assets/brand/,
                sales-public/brand/) plus public/ of the frozen commit 83620c68. The generators that run are the
                anchored scripts/deploy/* (no worker/ code is executed: the committed control-plane file is used and
                the build job proves it equals the generated one).
  3. The bundler is wrangler 4.143.0 installed with `npm ci --ignore-scripts` from the committed lockfile
     scripts/deploy/wrangler-pin/package-lock.json (every package sha512-pinned, registry.npmjs.org only), read from
     the commit (not the working tree), in --tools (outside the repository), with npm_config_userconfig and
     npm_config_globalconfig set to /dev/null and an explicit --registry. wrangler is executed by absolute path from
     that install with a minimal environment; `npx --yes wrangler@4.143.0` run below --tools resolves to the same
     install (checked offline here).
  4. The release (bundles, no-bundle configs, assets for central, MANIFEST.sha256) is written to --out, after checking
     that `wrangler deploy --no-bundle` uploads exactly the pre-built bytes.
  5. With --verify <dir>, the rebuilt release must be byte-for-byte identical to <dir> (same file set, same bytes),
     otherwise CLEAN_BUNDLE_REPRODUCED=MISMATCH and exit 1. The deploy jobs use this to refuse an artifact that does
     not come from the anchored sources of the commit.

Usage: clean_bundle.py {sales|central} --repo <git checkout> --rev <40-hex sha> --tools <dir> --work <dir> --out <dir>
                       [--verify <artifact dir>] [--skip-install]   (--skip-install: tests only; never in workflows)
"""
from __future__ import annotations

import argparse, hashlib, io, json, os, re, shutil, subprocess, sys, tarfile
from pathlib import Path

WRANGLER_VERSION = "4.143.0"
REGISTRY = "https://registry.npmjs.org"
PIN_DIR = "scripts/deploy/wrangler-pin"
PIN_FILES = ("package.json", "package-lock.json")
FROZEN_PUBLIC = "83620c680958d726fc4b0fd16e2574cdcc362a6d"
SALES_SOURCES = ("sales-worker.mjs", "worker/sales-public-worker.mjs", "worker/politica-unica.mjs",
                 "data/politica-unica.json", "wrangler.sales.toml", "scripts/ci/materialize_sales_configs.py")
CENTRAL_SOURCES = ("worker", "data", "scripts/deploy", "admin.css", "assets/brand", "sales-public/brand")
CENTRAL_ENV = ("PUBLIC_OWNER_ACCOUNT_ID", "ZEVANORY_LAUNCH_AUTHORIZATION", "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16",
               "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED", "OPERATOR_TOKEN_MIGRATION_UNTIL")
FORBIDDEN_NAMES = {".npmrc", "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
                   "pnpm-workspace.yaml", ".pnpmfile.cjs", "bunfig.toml", "bun.lockb", ".yarn"}


class Refused(SystemExit):
    def __init__(self, msg: str):
        super().__init__(f"CLEAN_BUNDLE=REFUSED {msg}")


def forbidden_path(path: str) -> bool:
    """npm/yarn/pnpm configuration or packages anywhere in the tree (the pinned tool dir is the only exception)."""
    if path.startswith(PIN_DIR + "/") and path[len(PIN_DIR) + 1:] in PIN_FILES:
        return False
    parts = path.split("/")
    return any(p == "node_modules" for p in parts) or parts[-1] in FORBIDDEN_NAMES or parts[-1].startswith(".yarnrc") \
        or any(p in (".yarn", ".pnpm-store") for p in parts[:-1])


def git(repo: Path, *args: str, binary: bool = False):
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if r.returncode != 0:
        raise Refused(f"git {' '.join(args[:2])}: {r.stderr.decode('utf-8', 'replace').strip()[:300]}")
    return r.stdout if binary else r.stdout.decode("utf-8")


def extract(repo: Path, rev: str, paths: tuple[str, ...], dest: Path) -> None:
    """git archive of the commit (object store, not the working tree) into dest; regular files and dirs only."""
    raw = git(repo, "archive", "--format=tar", rev, "--", *paths, binary=True)
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for m in tar.getmembers():
            name = m.name
            if name.startswith("/") or ".." in name.split("/") or not (m.isfile() or m.isdir()):
                raise Refused(f"unexpected archive member {name!r}")
            if forbidden_path(name.rstrip("/")):
                raise Refused(f"forbidden npm file in the sources: {name}")
            target = dest / name
            if m.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(m).read())
            if m.mode & 0o111:
                target.chmod(0o755)


PASSTHROUGH = ("HTTPS_PROXY", "https_proxy", "NODE_EXTRA_CA_CERTS", "npm_config_https_proxy", "npm_config_proxy", "npm_config_noproxy")


def base_env(tools: Path, work: Path) -> dict:
    """Minimal environment: no inherited npm configuration (user config /dev/null, empty global config, explicit
    registry); only network proxy settings pass through (none on GitHub-hosted runners)."""
    (work / "globalrc").touch()
    return {**{k: os.environ[k] for k in PASSTHROUGH if k in os.environ},
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(work / "home"), "LANG": "C.UTF-8",
            "CI": "1", "WRANGLER_SEND_METRICS": "false", "XDG_CONFIG_HOME": str(work / "xdg"),
            "npm_config_userconfig": "/dev/null", "npm_config_globalconfig": str(work / "globalrc"),
            "npm_config_registry": REGISTRY, "npm_config_cache": str(work / "npm-cache"),
            "npm_config_update_notifier": "false", "npm_config_fund": "false", "npm_config_audit": "false"}


def run(cmd: list[str], cwd: Path, env: dict, quiet: bool = False) -> str:
    r = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stdout[-4000:] + r.stderr[-4000:])
        raise Refused(f"command failed ({r.returncode}): {' '.join(cmd[:4])}")
    if not quiet:
        sys.stdout.write(r.stdout)
    return r.stdout


def install_tools(repo: Path, rev: str, tools: Path, work: Path, skip: bool) -> Path:
    tools.mkdir(parents=True, exist_ok=True)
    for f in (".npmrc", ".yarnrc", ".yarnrc.yml"):
        if (tools / f).exists():
            raise Refused(f"{tools / f} exists")
    for f in PIN_FILES:  # from the commit, never from the working tree
        (tools / f).write_bytes(git(repo, "show", f"{rev}:{PIN_DIR}/{f}", binary=True))
    lock = json.loads((tools / "package-lock.json").read_text(encoding="utf-8"))
    pkgs = lock.get("packages") or {}
    if pkgs.get("node_modules/wrangler", {}).get("version") != WRANGLER_VERSION:
        raise Refused("the lockfile does not pin wrangler " + WRANGLER_VERSION)
    for k, v in pkgs.items():
        if k and not (str(v.get("resolved", "")).startswith(REGISTRY + "/") and str(v.get("integrity", "")).startswith("sha512-")):
            raise Refused(f"lockfile entry without registry.npmjs.org + sha512 integrity: {k}")
    env = base_env(tools, work)
    if not skip:
        if (tools / "node_modules").exists():
            shutil.rmtree(tools / "node_modules")
        run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", f"--registry={REGISTRY}"], tools, env, quiet=True)
    wrangler = tools / "node_modules" / ".bin" / ("wrangler.cmd" if os.name == "nt" else "wrangler")  # nt: test suite only
    meta = json.loads((tools / "node_modules" / "wrangler" / "package.json").read_text(encoding="utf-8"))
    if meta.get("version") != WRANGLER_VERSION or not wrangler.exists():
        raise Refused(f"installed wrangler is {meta.get('version')!r}, expected {WRANGLER_VERSION}")
    if not skip:  # `npx --yes wrangler@X` below --tools (e.g. $RUNNER_TEMP/release) resolves to this install, offline
        probe = tools / "release-probe"
        probe.mkdir(exist_ok=True)
        out = run(["npx", "--yes", f"wrangler@{WRANGLER_VERSION}", "--version"], probe, {**env, "npm_config_offline": "true"}, quiet=True)
        probe.rmdir()
        if WRANGLER_VERSION not in out:
            raise Refused("npx does not resolve to the pinned install")
    print(f"PINNED_WRANGLER={WRANGLER_VERSION} lockfile_sha256={hashlib.sha256((tools / 'package-lock.json').read_bytes()).hexdigest()}")
    return wrangler


def bundle(wrangler: Path, src: Path, config: str, outdir: Path, env: dict, extra: tuple[str, ...] = ()) -> Path:
    run([str(wrangler), "deploy", "--dry-run", "--strict", *extra, "--config", config, "--outdir", str(outdir)], src, env, quiet=True)
    js = sorted(p for p in outdir.iterdir() if p.is_file() and not p.name.endswith(".map") and p.name != "README.md")
    if len(js) != 1 or js[0].suffix != ".js":
        raise Refused(f"expected exactly one bundled module, got {[p.name for p in js]}")
    return js[0]


def no_bundle_check(wrangler: Path, rel: Path, config: str, main: str, outdir: Path, env: dict, extra: tuple[str, ...] = ()) -> None:
    run([str(wrangler), "deploy", "--no-bundle", "--dry-run", *extra, "--config", config, "--outdir", str(outdir)], rel, env, quiet=True)
    if (outdir / main).read_bytes() != (rel / main).read_bytes():
        raise Refused(f"--no-bundle does not upload the pre-built bytes of {main}")


def manifest(out: Path, names: list[str]) -> None:
    lines = [f"{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}\n" for n in names]
    (out / "MANIFEST.sha256").write_text("".join(lines), encoding="utf-8")


def build_sales(repo, rev, wrangler, work, out, env):
    src = work / "src"
    extract(repo, rev, SALES_SOURCES, src)
    run([sys.executable, "-I", "scripts/ci/materialize_sales_configs.py"], src,
        {**env, "GITHUB_SHA": rev, "GITHUB_RUN_ID": os.environ.get("GITHUB_RUN_ID", "0")})
    (src / "sales-public").mkdir()  # assets directory (empty: assets are not part of the bundle)
    for kind in ("deploy", "preview"):
        cfg = (src / f"wrangler.sales.{kind}.toml").read_text(encoding="utf-8")
        if 'main = "sales-worker.mjs"' not in cfg.splitlines():
            raise Refused(f"unexpected main in wrangler.sales.{kind}.toml")
        if re.search(r"^\[build\]|^\s*command\s*=", cfg, re.M):
            raise Refused(f"build command in wrangler.sales.{kind}.toml")
        if re.search(r"^\s*routes?\s*=", cfg, re.M):
            raise Refused(f"routes in wrangler.sales.{kind}.toml")
        js = bundle(wrangler, src, f"wrangler.sales.{kind}.toml", work / f"bundle-{kind}", env)
        shutil.copyfile(js, out / f"sales-worker.{kind}.js")
        (out / f"wrangler.sales.{kind}.toml").write_text(
            cfg.replace('main = "sales-worker.mjs"', f'main = "sales-worker.{kind}.js"', 1), encoding="utf-8")
    check = work / "no-bundle-check"
    check.mkdir()
    for f in out.iterdir():
        shutil.copyfile(f, check / f.name)
    (check / "sales-public").mkdir()
    for kind in ("deploy", "preview"):
        no_bundle_check(wrangler, check, f"wrangler.sales.{kind}.toml", f"sales-worker.{kind}.js", work / f"nb-{kind}", env)
    manifest(out, ["sales-worker.deploy.js", "sales-worker.preview.js", "wrangler.sales.deploy.toml", "wrangler.sales.preview.toml"])


def build_central(repo, rev, wrangler, work, out, env):
    src = work / "src"
    extract(repo, rev, CENTRAL_SOURCES, src)
    git(repo, "cat-file", "-e", f"{FROZEN_PUBLIC}^{{commit}}")
    extract(repo, FROZEN_PUBLIC, ("public",), src)
    shutil.copyfile(src / "worker/live-recovered/control-plane-vnext.js", src / "public/control-plane-vnext.js")
    shutil.copyfile(src / "admin.css", src / "public/admin.css")
    genv = {**env, "TARGET_RUNTIME_SHA": rev, "GITHUB_REPOSITORY": os.environ.get("GITHUB_REPOSITORY", "")}
    genv.update({k: os.environ[k] for k in CENTRAL_ENV if k in os.environ})
    run([sys.executable, "-I", "scripts/deploy/write-build-info.py"], src, genv)
    (src / "wrangler.central-fix.jsonc").write_bytes(git(repo, "show", f"{FROZEN_PUBLIC}:wrangler.jsonc", binary=True))
    run([sys.executable, "-I", "scripts/deploy/prepare-central-candidate.py"], src, genv)
    run([sys.executable, "-I", "scripts/deploy/copy-brand-export.py"], src, genv)
    js = bundle(wrangler, src, "wrangler.central-fix.jsonc", work / "central-final", env, ("--keep-vars",))
    shutil.copyfile(js, out / "worker.bundle.js")
    c = json.loads((src / "wrangler.central-fix.jsonc").read_text(encoding="utf-8"))
    c["main"] = "worker.bundle.js"
    c.pop("alias", None)  # bundling-only settings; the bundle is already built
    c.pop("build", None)
    if (c.get("assets") or {}).get("directory") != "./public":
        raise Refused(f"unexpected assets directory {c.get('assets')}")
    (out / "wrangler.central-fix.jsonc").write_text(json.dumps(c, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    shutil.copytree(src / "public", out / "public")
    no_bundle_check(wrangler, out, "wrangler.central-fix.jsonc", "worker.bundle.js", work / "central-nb", env, ("--strict", "--keep-vars"))
    names = sorted("./" + p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file() and p.name != "MANIFEST.sha256")
    manifest(out, names)


def tree(d: Path) -> dict[str, bytes]:
    return {p.relative_to(d).as_posix(): p.read_bytes() for p in d.rglob("*") if p.is_file()}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=("sales", "central"))
    ap.add_argument("--repo", required=True)
    ap.add_argument("--rev", required=True)
    ap.add_argument("--tools", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--verify")
    ap.add_argument("--skip-install", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{40}", a.rev):
        raise Refused(f"--rev must be a full sha: {a.rev!r}")
    repo, tools, work, out = Path(a.repo).resolve(), Path(a.tools).resolve(), Path(a.work).resolve(), Path(a.out).resolve()
    if git(repo, "rev-parse", "--verify", f"{a.rev}^{{commit}}").strip() != a.rev:
        raise Refused("rev does not resolve to itself")
    bad = [p for p in git(repo, "ls-tree", "-r", "-z", "--name-only", a.rev).split("\0") if p and forbidden_path(p)]
    if bad:
        raise Refused(f"the commit contains npm/yarn configuration or packages: {bad[:10]}")
    for d in (work, out):
        if d.exists() and any(d.iterdir()):
            raise Refused(f"{d} is not empty")
        d.mkdir(parents=True, exist_ok=True)
    for sub in ("home", "xdg"):
        (work / sub).mkdir()
    wrangler = install_tools(repo, a.rev, tools, work, a.skip_install)
    env = base_env(tools, work)
    (build_sales if a.kind == "sales" else build_central)(repo, a.rev, wrangler, work, out, env)
    digest = hashlib.sha256((out / "MANIFEST.sha256").read_bytes()).hexdigest()
    print(f"CLEAN_BUNDLE=BUILT kind={a.kind} rev={a.rev} manifest={digest}")
    if a.verify:
        got, want = tree(out), tree(Path(a.verify))
        diff = sorted(set(got) ^ set(want)) + sorted(k for k in set(got) & set(want) if got[k] != want[k])
        if diff:
            for k in diff[:20]:
                print(f"::error title=CLEAN_BUNDLE_MISMATCH::{k}")
            print(f"CLEAN_BUNDLE_REPRODUCED=MISMATCH files={len(diff)}")
            return 1
        print(f"CLEAN_BUNDLE_REPRODUCED=MATCH files={len(got)} manifest={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
