#!/usr/bin/env python3
"""Resolve a certified maintenance release for the central Worker cutover."""
import os
import re
import subprocess
import sys
from pathlib import Path

from promotion_guard import _get, is_ancestor, norm, observe_cloudflare_version, readback_sha

RELEASE = "worker/owner-chat-release.mjs"
PHASE_A = Path("ops/owner-chat-phase-a.sha")
VERSION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()


def phase(source):
    match = re.search(r'^export const OWNER_CHAT_RELEASE_PHASE = "(maintenance|postgres)";$', source, re.M)
    if not match:
        raise ValueError("fase do Worker não reconhecida")
    return match[1]


def resolve():
    candidate_phase = phase(Path(RELEASE).read_text())
    if candidate_phase == "maintenance":
        return candidate_phase, "", ""

    expected = norm(PHASE_A.read_text())
    target_id = os.environ.get("OWNER_CHAT_PHASE_A_VERSION_ID", "")
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not (expected and VERSION_ID.fullmatch(target_id) and token and account):
        raise ValueError("referência A, ID de versão e observador Cloudflare obrigatórios")

    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/zevanory"
    detail = _get(f"{base}/versions/{target_id}", {"Authorization": f"Bearer {token}"})
    result = detail.get("result") or {}
    data = (result.get("metadata") or {}).get("annotations") or result.get("annotations") or {}
    deployed_a = norm(data.get("workers/tag"))
    if (detail.get("success") is not True or result.get("id") != target_id or not deployed_a
            or git("rev-parse", f"{expected}^{{tree}}") != git("rev-parse", f"{deployed_a}^{{tree}}")
            or phase(git("show", f"{deployed_a}:{RELEASE}")) != "maintenance"):
        raise ValueError("versão indicada diverge da árvore certificada da fase A")

    _, live_sha, live_id = observe_cloudflare_version("zevanory")
    http_sha = readback_sha("https://zevanory.api.br/api/release", "deployment.commit_sha")
    if not live_sha or live_sha != http_sha:
        raise ValueError("SHA ativo sem confirmação simultânea de Cloudflare e /api/release")
    if live_id != target_id and not (
        live_sha != deployed_a
        and is_ancestor(deployed_a, live_sha, ".")
        and phase(git("show", f"{live_sha}:{RELEASE}")) == "postgres"
    ):
        raise ValueError("fase A certificada precisa estar ativa antes da primeira fase B")
    return candidate_phase, target_id, deployed_a


def main():
    if sys.argv[1:] == ["--verify-active"]:
        _, live_sha, live_id = observe_cloudflare_version("zevanory")
        confirmed = bool(live_sha and live_id and live_sha == os.environ.get("OWNER_CHAT_ROLLBACK_SHA")
                         and live_id == os.environ.get("OWNER_CHAT_ROLLBACK_ID"))
        print("OWNER_CHAT_ROLLBACK_ACTIVE_ID=" + ("PASS" if confirmed else "FAIL"))
        return 0 if confirmed else 1
    try:
        release_phase, version_id, sha = resolve()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"OWNER_CHAT_ROLLBACK_TARGET=REFUSED ({type(exc).__name__})", file=sys.stderr)
        if isinstance(exc, ValueError):
            print(exc, file=sys.stderr)
        return 1
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        out.write(f"phase={release_phase}\nversion_id={version_id}\nsha={sha}\n")
    print(f"OWNER_CHAT_ROLLBACK_TARGET=PASS phase={release_phase} sha={sha or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
