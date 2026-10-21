#!/usr/bin/env python3
"""Write the lead privacy key ring to the production Worker as ONE tagged version (plan 3.1, T3).

Why not `wrangler secret put`: it creates AND deploys an untagged version per secret. That
(a) drops the Cloudflare source of the monotonic guard (the active version has no SHA tag), and
(b) during a rotation writes CURRENT and PREVIOUS in two deployments, with an intermediate state
in which links signed with the previous key are rejected.

Procedure (inside the serialized deploy-zevanory queue):
  1. Pre-check: the effective version must be known by BOTH sources (Cloudflare tag of the active
     version and /api/release) and they must agree (live SHA L); the newest uploaded version must
     be the active one (no pending version would be silently promoted). Otherwise: no change.
  2. `wrangler versions secret bulk` creates ONE new version with all keys at once, tagged L (same
     code, same SHA): no intermediate key state, and the guard keeps both sources.
  3. `wrangler versions deploy <new>@100%`.
  4. Post-check: effective version = L by both sources (same SHA as before), /api/health live and
     ready, binding names present. FAIL (positive evidence) or unhealthy -> redeploy the previous
     version at 100% (exact previous state). NAO_COMPROVADO (observer unreachable) -> no rollback,
     the run fails for an independent re-check (same policy as the T1 post-promotion gate).
Values are read from the environment and never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import promotion_guard as pg  # noqa: E402

SCRIPT = "zevanory"
RELEASE_URL = "https://zevanory.api.br/api/release"
RELEASE_PATH = "deployment.commit_sha"
HEALTH_URL = "https://zevanory.api.br/api/health"
API = "https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}"


def log(kind: str, title: str, msg: str) -> None:
    print(f"::{kind} title={title}::{msg}", flush=True)


class Cloudflare:
    def __init__(self, fetch=pg._get):
        self.fetch = fetch
        self.base = API.format(account=os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""), script=SCRIPT)
        # .strip(): segredo com quebra de linha quebra o cabeçalho HTTP no urllib (issue #849).
        self.auth = {"Authorization": "Bearer " + os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()}

    def active_version_id(self) -> str | None:
        deps = (self.fetch(self.base + "/deployments", self.auth).get("result") or {}).get("deployments") or []
        versions = (deps[0].get("versions") or []) if deps else []
        full = [v for v in versions if int(v.get("percentage") or 0) == 100]
        return full[0].get("version_id") if len(full) == 1 else None

    def latest_version_id(self) -> str | None:
        res = self.fetch(self.base + "/versions", self.auth).get("result") or {}
        items = res.get("items") if isinstance(res, dict) else res
        return (items or [{}])[0].get("id")

    def secret_names(self) -> set[str]:
        return {s.get("name") for s in (self.fetch(self.base + "/secrets", self.auth).get("result") or [])}


def wrangler(args: list[str], run=subprocess.run) -> None:
    cmd = shlex.split(os.environ.get("WRANGLER", "npx --yes wrangler@4.143.0")) + args
    proc = run(cmd, capture_output=True, text=True, input="y\n")
    if proc.returncode != 0:
        # Never echo raw output (could contain values); report only the failing subcommand.
        raise RuntimeError("wrangler_failed:" + " ".join(args[:3]))


def health_state(fetch=pg._get) -> str:
    """OK: live and ready. ANSWERED: the Worker answered unhealthy (error status or live/ready not
    true) = positive evidence. UNREACHABLE: the observer could not reach it = no evidence."""
    try:
        h = fetch(HEALTH_URL)
    except urllib.error.HTTPError:
        return pg.ANSWERED
    except Exception:
        return pg.UNREACHABLE
    return pg.OK if isinstance(h, dict) and h.get("live") is True and h.get("ready") is True else pg.ANSWERED


def health_ok(fetch=pg._get) -> bool:
    return health_state(fetch) == pg.OK


def secret_names_or_none(cf: "Cloudflare"):
    """Binding names, or None when the API could not be read (no evidence either way)."""
    try:
        res = cf.fetch(cf.base + "/secrets", cf.auth)
    except Exception:
        return None
    if not isinstance(res, dict) or res.get("success") is False or not isinstance(res.get("result"), list):
        return None
    return {s.get("name") for s in res["result"]}


def run(keys: dict[str, str], *, cf: Cloudflare, run_cmd=subprocess.run, fetch=pg._get,
        attempts: int = 12, interval: float = 10.0, sleep=time.sleep, drop: tuple[str, ...] = ()) -> int:
    """keys: written in ONE version. drop: names removed in ONE version (end of a rotation)."""
    # 1. Pre-check
    obs_http = pg.observe_readback(RELEASE_URL, RELEASE_PATH, fetch)
    obs_cf = pg.observe_cloudflare(SCRIPT, fetch)
    if obs_http[0] != pg.OK or obs_cf[0] != pg.OK or obs_http[1] != obs_cf[1]:
        log("error", "WORKER_SECRET_PRECHECK", f"effective version not proven by both sources (cloudflare={obs_cf[0]}:{(obs_cf[1] or '')[:12]} readback={obs_http[0]}:{(obs_http[1] or '')[:12]}); no change")
        return 1
    live = obs_cf[1]
    prev = cf.active_version_id()
    latest = cf.latest_version_id()
    if not prev or prev != latest:
        log("error", "WORKER_SECRET_PRECHECK", "newest uploaded version is not the active one (or gradual rollout); no change")
        return 1
    print("WORKER_SECRET_PRECHECK=" + json.dumps({"live": live, "previous_version": prev}), flush=True)

    # 2. One tagged version with all keys (no intermediate state)
    if keys:
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "secrets.json"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                json.dump(keys, fh)
            wrangler(["versions", "secret", "bulk", str(path), "--name", SCRIPT, "--tag", live,
                      "--message", f"T3 lead privacy key ring on {live[:12]} ({','.join(sorted(keys))})"], run_cmd)
    for name in drop:  # only LEAD_PRIVACY_SECRET_PREVIOUS is ever dropped (see main)
        wrangler(["versions", "secret", "delete", name, "--name", SCRIPT, "--tag", live,
                  "--message", f"T3 end of rotation on {live[:12]}"], run_cmd)
    new = cf.latest_version_id()
    if not new or new == prev:
        log("error", "WORKER_SECRET_VERSION", "new version not found after upload; nothing deployed")
        return 1

    # 3. Deploy the new version
    wrangler(["versions", "deploy", f"{new}@100%", "--name", SCRIPT, "--yes",
              "--message", f"T3 lead privacy key ring on {live[:12]}"], run_cmd)

    # 4. Post-check (same SHA by both sources, health, binding names), classified like the T1 gate:
    #    FAIL = positive evidence (another SHA, sources disagree, Worker answered unhealthy, API listed
    #    the bindings and one is missing/still present); NAO_COMPROVADO = an observer was unreachable.
    state, reason = "NAO_COMPROVADO", "not_checked"
    for _ in range(attempts):
        ok, reason = pg.verify_effective(live, pg.observe_readback(RELEASE_URL, RELEASE_PATH, fetch), pg.observe_cloudflare(SCRIPT, fetch))
        state = reason.split(":", 1)[0]
        health = health_state(fetch)
        if state == "PASS" and health == pg.ANSWERED:
            state, reason = "FAIL", "FAIL:health_answered_not_live_ready"
        elif state == "PASS" and health == pg.UNREACHABLE:
            state, reason = "NAO_COMPROVADO", "NAO_COMPROVADO:health_unreachable"
        if state == "PASS":
            break
        sleep(interval)
    if state == "PASS":
        names = secret_names_or_none(cf)
        if names is None:
            state, reason = "NAO_COMPROVADO", "NAO_COMPROVADO:secrets_api_unreadable"
        else:
            missing = sorted(set(keys) - names)
            lingering = sorted(set(drop) & names)
            if missing or lingering:
                state, reason = "FAIL", "FAIL:binding_state:" + ",".join(["missing=" + n for n in missing] + ["present=" + n for n in lingering])
    print("WORKER_SECRET_POSTCHECK=" + json.dumps({"state": state, "reason": reason, "live": live, "version": new}), flush=True)
    if state == "PASS":
        log("notice", "WORKER_SECRET", f"PASS key ring {sorted(keys)} written, {sorted(drop)} removed, on {SCRIPT} at {live[:12]} (version {new})")
        return 0
    if state == "FAIL":
        wrangler(["versions", "deploy", f"{prev}@100%", "--name", SCRIPT, "--yes",
                  "--message", "T3 restore previous version after failed post-check"], run_cmd)
        log("error", "WORKER_SECRET", f"{reason}; previous version {prev} restored at 100%")
        return 1
    log("error", "WORKER_SECRET", f"{reason}; NOT certified and NOT rolled back (observer unreachable): run the read-only verify")
    return 2


def verify(cf: Cloudflare, fetch=pg._get) -> int:
    """Read-only certification: binding present, both version sources agree, Worker healthy."""
    obs_http = pg.observe_readback(RELEASE_URL, RELEASE_PATH, fetch)
    obs_cf = pg.observe_cloudflare(SCRIPT, fetch)
    names = secret_names_or_none(cf)
    health = health_state(fetch)
    healthy = health == pg.OK
    record = {"binding": None if names is None else sorted(n for n in names if n.startswith("LEAD_PRIVACY_SECRET")),
              "cloudflare": obs_cf, "readback": obs_http, "healthy": healthy}
    print("WORKER_SECRET_VERIFY=" + json.dumps(record), flush=True)
    if names is None or obs_http[0] == pg.UNREACHABLE or obs_cf[0] == pg.UNREACHABLE or health == pg.UNREACHABLE:
        log("error", "WORKER_SECRET_VERIFY", "NAO_COMPROVADO: a source was unreachable")
        return 2
    ok = "LEAD_PRIVACY_SECRET" in names and obs_http[0] == obs_cf[0] == pg.OK and obs_http[1] == obs_cf[1] and healthy
    log("notice" if ok else "error", "WORKER_SECRET_VERIFY", ("PASS" if ok else "FAIL") + f" binding={'LEAD_PRIVACY_SECRET' in names} sources_agree={obs_http[1] == obs_cf[1] and obs_http[0] == pg.OK} healthy={healthy}")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--drop-previous", action="store_true", help="end of rotation: remove LEAD_PRIVACY_SECRET_PREVIOUS only")
    ap.add_argument("--verify", action="store_true", help="read-only certification")
    args = ap.parse_args()
    if args.verify:
        return verify(Cloudflare())
    if args.drop_previous:
        if not args.apply:
            log("error", "WORKER_SECRET", "refusing without --apply")
            return 1
        return run({}, cf=Cloudflare(), drop=("LEAD_PRIVACY_SECRET_PREVIOUS",))
    current = os.environ.get("LEAD_PRIVACY_SECRET", "")
    previous = os.environ.get("LEAD_PRIVACY_SECRET_PREVIOUS", "")
    if len(current) < 32:
        log("error", "WORKER_SECRET", "github_secret_missing_or_shorter_than_32")
        return 1
    keys = {"LEAD_PRIVACY_SECRET": current}
    if previous:
        if len(previous) < 32 or previous == current:
            log("error", "WORKER_SECRET", "previous_invalid_or_equal_to_current")
            return 1
        keys["LEAD_PRIVACY_SECRET_PREVIOUS"] = previous
    if not args.apply:
        log("error", "WORKER_SECRET", "refusing without --apply")
        return 1
    return run(keys, cf=Cloudflare())


if __name__ == "__main__":
    sys.exit(main())
