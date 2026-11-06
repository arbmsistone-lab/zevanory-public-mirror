#!/usr/bin/env python3
"""Readback pós-deploy (roteiro seção 7): o /build-info.json publicado carrega a região de assinatura testada.

Só GET (urllib, método explícito), sem credenciais, sem escrita. Compara:
  sha                         == --expected-sha (o SHA promovido)
  mp_signature_region_sha256  == hash da região no código-fonte TESTADO, recalculado aqui a partir de
                                 `git show <--source-ref>:worker/cloudflare-worker.recovered.mjs` (ou --source-file)
  bundle_sha256               == o do build-info local do candidato (--local-build-info), quando este tiver o campo
Repete até --attempts vezes (propagação da borda); falha (exit 1) se nenhuma leitura bater; exit 2 em entrada inválida.
Uso: verify-live-build-info.py --url URL --expected-sha SHA (--source-ref SHA | --source-file F)
     [--local-build-info public/build-info.json] [--attempts 30] [--sleep 5]
"""
import argparse, json, re, sys, time, urllib.request
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_provenance as bp  # noqa: E402


def fetch(url, timeout=20):
    req = urllib.request.Request(url, method="GET", headers={
        "User-Agent": "ZEVANORY-BuildInfo-Readback/1.0", "Cache-Control": "no-cache", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def compare(live, expected_sha, tested_region, local_bundle):
    problems = []
    if not isinstance(live, dict):
        return ["LIVE_BUILD_INFO_NOT_OBJECT"]
    if live.get("sha") != expected_sha:
        problems.append("LIVE_SHA_MISMATCH")
    if live.get("mp_signature_region_sha256") != tested_region:
        problems.append("LIVE_MP_SIGNATURE_REGION_MISMATCH")
    if local_bundle is not None and live.get("bundle_sha256") != local_bundle:
        problems.append("LIVE_BUNDLE_SHA256_MISMATCH")
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--expected-sha", required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--source-ref")
    src.add_argument("--source-file")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--local-build-info")
    ap.add_argument("--attempts", type=int, default=30)
    ap.add_argument("--sleep", type=float, default=5.0)
    a = ap.parse_args(argv)
    out = {"LIVE_BUILD_INFO_READBACK": "FAIL", "url": a.url, "expected_sha": a.expected_sha}
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", a.expected_sha) or not a.url.startswith(("https://", "http://127.0.0.1")):
            raise ValueError("INVALID_ARGUMENTS")
        tested = bp.region_sha256_file(file=a.source_file, git_ref=a.source_ref, repo=a.repo)
        local_bundle = None
        if a.local_build_info:
            local_bundle = json.loads(Path(a.local_build_info).read_text(encoding="utf-8")).get("bundle_sha256")
    except (bp.RegionError, OSError, ValueError, bp.subprocess.CalledProcessError) as e:
        out["error"] = f"{type(e).__name__}: {e}"[:300]
        print(json.dumps(out, sort_keys=True))
        return 2
    out.update({"tested_region": tested, "expected_bundle": local_bundle})
    for i in range(max(1, a.attempts)):
        try:
            live = fetch(a.url)
            problems = compare(live, a.expected_sha, tested, local_bundle)
            out.update({"attempt": i + 1, "problems": problems,
                        "live": {k: live.get(k) for k in ("sha", "mp_signature_region_sha256", "bundle_sha256")}
                        if isinstance(live, dict) else None})
        except Exception as e:  # noqa: BLE001 - leitura falha => tenta de novo; nunca conta como sucesso
            out.update({"attempt": i + 1, "problems": [f"FETCH_FAILED:{type(e).__name__}"]})
        if not out["problems"]:
            out["LIVE_BUILD_INFO_READBACK"] = "PASS"
            print(json.dumps(out, sort_keys=True))
            return 0
        if i + 1 < a.attempts:
            time.sleep(a.sleep)
    print(json.dumps(out, sort_keys=True))
    return 1


if __name__ == "__main__":
    sys.exit(main())
