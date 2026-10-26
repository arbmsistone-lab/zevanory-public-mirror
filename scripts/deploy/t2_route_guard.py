#!/usr/bin/env python3
"""Static proof that the control Worker's factory/tick route is HMAC-guarded before any work.

Runs on the EXACT source being promoted (zpc checkout). Two accepted layouts:

  inline  (up to edge f501904e): verifyFactoryRequest itself calls crypto.subtle.verify('HMAC', ...).
  module  (edge #211, R9-D1, c7d8a3e and later): verifyFactoryRequest delegates to
          verifyCommercialSignature(request.headers, env, CREATIVE_FACTORY_PURPOSE) !== 'none',
          imported from ./commercial-hmac, and that function fails closed: it starts from 'none',
          only an HMAC verify can change it, and it returns that value.

In both layouts the route itself must reject non-POST and call verifyFactoryRequest, answering
401 before the first `try {` (no work before authentication).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROUTE = "url.pathname === '/api/commercial/creative/factory/tick'"
ROUTE_401 = re.compile(
    r"if \(!await verifyFactoryRequest\(request, env\)\) return Response\.json\("
    r"\{ ok: false, error: 'commercial_creative_factory_auth_required' \}, \{ status: 401 \}\)"
)


def _function_body(src: str, name: str) -> str:
    """Body of `async function name(...) {...}` / `export async function name(...)...{...}` by brace matching."""
    m = re.search(r"(?:export\s+)?async function " + re.escape(name) + r"\s*\(", src)
    if not m:
        return ""
    # skip the parameter list (may contain braces in default values)
    i, depth = m.end() - 1, 0
    while i < len(src):
        c = src[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                break
        i += 1
    start = src.find("{", i)
    # return-type annotations such as Promise<X> contain no braces in this codebase
    if start < 0:
        return ""
    depth = 0
    for j in range(start, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[start + 1:j]
    return ""


def route_guarded(worker: str) -> tuple[bool, str]:
    i = worker.find(ROUTE)
    if i < 0:
        return False, "route_missing"
    head = worker[i:i + 600].split("try {", 1)[0]
    if "request.method !== 'POST'" not in head:
        return False, "route_accepts_non_post"
    if not ROUTE_401.search(head):
        return False, "route_not_authenticated_before_work"
    return True, "route_ok"


def verifier_fails_closed(worker: str, hmac_module: str | None) -> tuple[bool, str]:
    body = _function_body(worker, "verifyFactoryRequest")
    if not body:
        return False, "verifyFactoryRequest_missing"
    if "crypto.subtle.verify('HMAC'" in body:
        return True, "layout_inline"
    delegate = re.fullmatch(
        r"\s*(?://[^\n]*\n\s*)*return \(await verifyCommercialSignature\(request\.headers, env, CREATIVE_FACTORY_PURPOSE\)\) !== 'none';\s*",
        body,
    )
    if not delegate:
        return False, "verifyFactoryRequest_unrecognised"
    if not re.search(r"import\s*\{[^}]*\bverifyCommercialSignature\b[^}]*\}\s*from\s*'\./commercial-hmac(?:\.ts)?'", worker):
        return False, "verifyCommercialSignature_not_imported_from_commercial_hmac"
    if not re.search(r"import\s*\{[^}]*\bCREATIVE_FACTORY_PURPOSE\b[^}]*\}\s*from\s*'\./commercial-hmac(?:\.ts)?'", worker):
        return False, "purpose_not_imported_from_commercial_hmac"
    if hmac_module is None:
        return False, "commercial_hmac_missing"
    vbody = _function_body(hmac_module, "verifyCommercialSignature")
    if not vbody:
        return False, "verifyCommercialSignature_missing"
    checks = [
        ("let hit: CommercialAuthResult = 'none';" in vbody, "hit_not_initialised_none"),
        (bool(re.search(r"const ok = await crypto\.subtle\.verify\('HMAC', key, bytes, message\);", vbody)), "no_hmac_verify"),
        (bool(re.search(r"if \(ok && hit === 'none'\) hit = candidate\.category;", vbody)), "hit_set_without_verify"),
        (bool(re.search(r"return recordCommercialAuth\(hit, log\);\s*$", vbody)), "does_not_return_hit"),
        (len(re.findall(r"\bhit\s*=(?!=)", vbody)) == 1 and vbody.count("let hit") == 1, "hit_assigned_elsewhere"),
        # every early return before the loop must be 'none'
        (all(r == "'none'" for r in re.findall(r"return recordCommercialAuth\(([^,]+), log\);", vbody)[:-1]), "early_return_not_none"),
        (bool(re.search(r"export const CREATIVE_FACTORY_PURPOSE = '[^']+';", hmac_module)), "purpose_not_constant"),
    ]
    for ok, reason in checks:
        if not ok:
            return False, reason
    return True, "layout_module"


def check(worker: str, hmac_module: str | None) -> tuple[bool, str]:
    ok, reason = route_guarded(worker)
    if not ok:
        return ok, reason
    ok, layout = verifier_fails_closed(worker, hmac_module)
    return ok, layout


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="zpc checkout root (cf-worker/ inside)")
    args = ap.parse_args(argv)
    root = Path(args.source) / "cf-worker"
    worker = (root / "worker.ts").read_text(encoding="utf-8")
    module_path = root / "commercial-hmac.ts"
    module = module_path.read_text(encoding="utf-8") if module_path.exists() else None
    ok, reason = check(worker, module)
    if not ok:
        print(f"::error title=SOURCE_T2_ROUTE_UNGUARDED::factory/tick is not HMAC-guarded before work in the promoted source ({reason})")
        return 1
    print(f"SOURCE_T2_ROUTE_GUARDED=PASS ({reason})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
