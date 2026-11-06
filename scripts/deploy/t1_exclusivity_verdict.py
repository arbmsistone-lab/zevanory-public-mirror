#!/usr/bin/env python3
"""T1 STRICT exclusivity verdict (separate from the informational `credential-scope` job).

Prints T1_EXCLUSIVITY=PROVEN only when every condition below holds on evidence collected in this run;
anything unproven, unknown, unreadable or merely "not configured" -> T1_EXCLUSIVITY=NOT_PROVEN with reasons
(Sol T1 conditions 1-7: a notice never counts as a PASS). Read-only: GET requests only, token values are never
printed (only secret names and 8-char token id prefixes).

  I  inventory   scripts/deploy/worker_write_paths.py reports zero findings (complete, registered, guarded).
  W  per Worker  for each canonical Worker (zevanory, zevanory-sales-public, zevanory-public-router,
                 zevanory-product-control-portable) its CF_TOKEN_* is configured and active, reaches exactly
                 that one Worker (reach == 1, same name), its own policies are readable, they grant a Workers
                 write/edit permission, and every write policy's resources are limited to that Worker; it reads
                 the Worker's deployments and settings.
  S  shared      CLOUDFLARE_API_TOKEN and CLOUDFLARE_PUBLIC_OWNER_API_TOKEN: if still configured, Cloudflare
                 must report them not active (revoked/disabled/expired or invalid). "Not configured" alone is
                 NOT proof of revocation: it is accepted only together with A.
  A  audit       CF_TOKEN_AUDIT lists every account-owned AND user-owned token with its policies; for each
                 canonical Worker the set of ACTIVE tokens whose write policies cover it (account-wide or that
                 Worker) is exactly {its CF_TOKEN_*}. Any other write-capable token (shared, probe, unknown) fails.
  O  other       probe tokens (CF_PROBE_TOKEN, CF_PROBE_TOKEN_NO_ROUTES, CLOUDFLARE_SANDBOX_PROBE_TOKEN): when
                 configured, their policies must be readable and cover no canonical Worker.
  L  live SHA    each canonical Worker's active version carries a workers/tag SHA (read with its own token) and
                 an independent readback (ops/publishers.json services.<w>.readback) reports the same SHA.
                 A Worker without a readback has a single source -> not proven.
  M  manual      access that no API can enumerate (Cloudflare dashboard members, the owner's Global API Key) is
                 registered in ops/publishers.json manual_operations["cloudflare-dashboard-and-global-key"].

Usage:
  t1_exclusivity_verdict.py --inventory inv.json [--registry ops/publishers.json] [--account ID]
                            [--mock responses.json]     (tests: canned API/readback responses, no network)
Exit 0 PROVEN, 1 NOT_PROVEN. Writes `exclusivity` and `reasons` to $GITHUB_OUTPUT when present.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
CANONICAL = {"zevanory": "CF_TOKEN_ZEVANORY", "zevanory-sales-public": "CF_TOKEN_SALES",
             "zevanory-public-router": "CF_TOKEN_ROUTER", "zevanory-product-control-portable": "CF_TOKEN_PANEL"}
SHARED = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_PUBLIC_OWNER_API_TOKEN")
OTHER = ("CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES", "CLOUDFLARE_SANDBOX_PROBE_TOKEN")
AUDIT = "CF_TOKEN_AUDIT"
WRITE_GROUP = re.compile(r"workers?\b.*\b(?:write|edit)\b|\beditor\b|\badmin", re.I)
SHA = re.compile(r"^[0-9a-f]{40}$")
MANUAL_KEY = "cloudflare-dashboard-and-global-key"


def http_fetch(url: str, token: str | None):
    headers = {"user-agent": "ZEVANORY-t1-exclusivity/1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:  # noqa: S310
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, None
    except Exception:
        return None, None


def mock_fetch(mock: dict):
    def f(url: str, token: str | None):
        table = mock.get(token or "", {}) if token else mock.get("readback", {})
        key = url[len(API):] if url.startswith(API) else url
        hit = table.get(key)
        return (hit[0], hit[1]) if hit else (None, None)
    return f


def _ok(resp) -> bool:
    st, body = resp
    return st == 200 and isinstance(body, dict) and body.get("success") is True


def _write_policies(policies) -> list[dict]:
    out = []
    for p in policies or []:
        if not isinstance(p, dict) or p.get("effect") != "allow":
            continue
        groups = [g.get("name", "") for g in p.get("permission_groups") or [] if isinstance(g, dict)]
        if any(WRITE_GROUP.search(g) for g in groups):
            out.append({"groups": groups, "resources": sorted((p.get("resources") or {}).keys())})
    return out


def covers(write_policies: list[dict], worker: str, account: str) -> bool:
    """Does any write policy reach this Worker? Account-wide or wildcard resources reach every Worker."""
    for p in write_policies:
        for r in p["resources"]:
            if r.endswith("*") or r in (f"com.cloudflare.api.account.{account}",) or re.search(rf"(?:^|[.:/]){re.escape(worker)}$", r):
                return True
    return False


def limited_to(write_policies: list[dict], worker: str, account: str) -> bool:
    if not write_policies:
        return False
    for p in write_policies:
        for r in p["resources"]:
            if r.endswith("*") or r == f"com.cloudflare.api.account.{account}" or not re.search(rf"(?:^|[.:/]){re.escape(worker)}$", r):
                return False
    return True


def token_evidence(name: str, tok: str, account: str, fetch, worker: str | None = None) -> dict:
    if not tok:
        return {"configured": False}
    ev = {"configured": True}
    av, uv = fetch(f"{API}/accounts/{account}/tokens/verify", tok), fetch(f"{API}/user/tokens/verify", tok)
    scope, res = ("account", av[1]["result"]) if _ok(av) else (("user", uv[1]["result"]) if _ok(uv) else (None, {}))
    ev["scope"], ev["id"], ev["status"] = scope, (res or {}).get("id"), (res or {}).get("status")
    if scope is None:
        # Both verify endpoints refused with 401: Cloudflare says the token is invalid (revoked) - positive proof.
        ev["status"] = "invalid" if av[0] == 401 and uv[0] == 401 else "unknown"
        return ev
    lst = fetch(f"{API}/accounts/{account}/workers/scripts", tok)
    if _ok(lst):
        names = sorted(str(s.get("id")) for s in lst[1].get("result") or [] if isinstance(s, dict))
        ev["reach"], ev["visible"] = len(names), names
    else:
        ev["reach"], ev["visible"] = None, []
    pol = fetch(f"{API}/accounts/{account}/tokens/{ev['id']}" if scope == "account" else f"{API}/user/tokens/{ev['id']}", tok)
    ev["policies_readable"] = _ok(pol) and isinstance((pol[1].get("result") or {}).get("policies"), list)
    ev["write_policies"] = _write_policies((pol[1].get("result") or {}).get("policies")) if ev["policies_readable"] else []
    if worker:
        base = f"{API}/accounts/{account}/workers/scripts/{worker}"
        dep = fetch(base + "/deployments", tok)
        ev["deployments_read"], ev["settings_read"] = _ok(dep), _ok(fetch(base + "/settings", tok))
        ev["live_tag"] = None
        if ev["deployments_read"]:
            deps = (dep[1].get("result") or {}).get("deployments") or []
            full = [v for v in (deps[0].get("versions") or [] if deps else []) if int(v.get("percentage") or 0) == 100]
            if len(full) == 1:
                ver = fetch(f"{base}/versions/{full[0].get('version_id')}", tok)
                if _ok(ver):
                    r = ver[1].get("result") or {}
                    ann = (r.get("metadata") or {}).get("annotations") or r.get("annotations") or {}
                    tag = str(ann.get("workers/tag") or "").lower()
                    ev["live_tag"] = tag if SHA.match(tag) else None
    return ev


def _list_all(fetch, path: str, tok: str):
    items, page = [], 1
    while page <= 20:
        resp = fetch(f"{API}{path}?per_page=50&page={page}", tok)
        if not _ok(resp):
            return None
        chunk = resp[1].get("result") or []
        items += [t for t in chunk if isinstance(t, dict)]
        info = resp[1].get("result_info") or {}
        if len(chunk) < 50 or page >= int(info.get("total_pages") or page):
            return items
        page += 1
    return None


def collect(env: dict, account: str, registry: dict, inventory: dict, fetch) -> dict:
    ev = {"account": account, "inventory_findings": [f"{f['code']} {f['path']}" for f in inventory.get("findings", [])],
          "inventory_rows": len(inventory.get("rows", [])), "tokens": {}, "audit": {}, "readback": {},
          "manual_registered": bool(((registry.get("manual_operations") or {}).get(MANUAL_KEY) or {}).get("owner_written_authorization"))}
    for w, name in CANONICAL.items():
        ev["tokens"][name] = token_evidence(name, env.get(name, ""), account, fetch, worker=w)
    for name in SHARED + OTHER:
        ev["tokens"][name] = token_evidence(name, env.get(name, ""), account, fetch)
    tok = env.get(AUDIT, "")
    ev["audit"]["configured"] = bool(tok)
    if tok:
        acc = _list_all(fetch, f"/accounts/{account}/tokens", tok)
        usr = _list_all(fetch, "/user/tokens", tok)
        ev["audit"]["account_tokens"] = None if acc is None else [
            {"id": t.get("id"), "name": t.get("name"), "status": t.get("status"), "write_policies": _write_policies(t.get("policies"))} for t in acc]
        ev["audit"]["user_tokens"] = None if usr is None else [
            {"id": t.get("id"), "name": t.get("name"), "status": t.get("status"), "write_policies": _write_policies(t.get("policies"))} for t in usr]
    for w in CANONICAL:
        rb = ((registry.get("services") or {}).get(w) or {}).get("readback")
        if not rb:
            ev["readback"][w] = {"defined": False}
            continue
        st, body = fetch(rb["url"], None)
        val = body
        for part in str(rb["path"]).split("."):
            val = val.get(part) if isinstance(val, dict) else None
        sha = str(val or "").lower()
        ev["readback"][w] = {"defined": True, "status": st, "sha": sha if SHA.match(sha) else None}
    return ev


def verdict(ev: dict) -> tuple[str, list[str]]:
    reasons, account = [], ev.get("account", ACCOUNT)
    if ev.get("inventory_findings") is None or ev.get("inventory_rows", 0) < 1:
        reasons.append("I:inventory_missing")
    elif ev["inventory_findings"]:
        reasons.append(f"I:inventory_findings={len(ev['inventory_findings'])}")
    toks = ev.get("tokens") or {}
    for w, name in CANONICAL.items():
        t = toks.get(name) or {}
        if not t.get("configured"):
            reasons.append(f"W:{w}:{name}_not_configured")
            continue
        if t.get("status") != "active":
            reasons.append(f"W:{w}:{name}_status={t.get('status')}")
            continue
        if t.get("reach") != 1 or t.get("visible") != [w]:
            reasons.append(f"W:{w}:{name}_reach={t.get('reach')}_visible={','.join(t.get('visible') or [])[:80]}")
        if not t.get("policies_readable"):
            reasons.append(f"W:{w}:{name}_edit_permission_unproven")
        elif not t.get("write_policies"):
            reasons.append(f"W:{w}:{name}_edit_permission_missing")
        elif not limited_to(t["write_policies"], w, account):
            reasons.append(f"W:{w}:{name}_write_scope_not_limited")
        if not (t.get("deployments_read") and t.get("settings_read")):
            reasons.append(f"W:{w}:{name}_scope_not_ready")
    audit = ev.get("audit") or {}
    audit_ok = audit.get("configured") and audit.get("account_tokens") is not None and audit.get("user_tokens") is not None
    if not audit.get("configured"):
        reasons.append(f"A:{AUDIT}_not_configured")
    else:
        for k in ("account_tokens", "user_tokens"):
            if audit.get(k) is None:
                reasons.append(f"A:{k}_unreadable")
    if audit_ok:
        active = [t for t in audit["account_tokens"] + audit["user_tokens"] if t.get("status") == "active"]
        for w, name in CANONICAL.items():
            own = (toks.get(name) or {}).get("id")
            writers = sorted({t.get("id") for t in active if covers(t["write_policies"], w, account)})
            if writers != ([own] if own else []):
                others = [str(i)[:8] for i in writers if i != own]
                reasons.append(f"A:{w}:write_tokens_other_than_{name}=[{','.join(others)}]" if others else f"A:{w}:{name}_not_listed_as_writer")
    for name in SHARED:
        t = toks.get(name) or {}
        if t.get("configured"):
            if t.get("status") in ("active", "unknown", None):
                reasons.append(f"S:{name}_status={t.get('status')}_reach={t.get('reach')}")
        elif not audit_ok:
            reasons.append(f"S:{name}_not_configured_revocation_unproven")
    for name in OTHER:
        t = toks.get(name) or {}
        if not t.get("configured") or t.get("status") in ("invalid", "disabled", "expired"):
            continue
        if not t.get("policies_readable"):
            reasons.append(f"O:{name}_permissions_unproven")
        elif any(covers(t["write_policies"], w, account) for w in CANONICAL):
            reasons.append(f"O:{name}_can_write_a_canonical_worker")
    for w, name in CANONICAL.items():
        tag = (toks.get(name) or {}).get("live_tag")
        rb = (ev.get("readback") or {}).get(w) or {}
        if not tag:
            reasons.append(f"L:{w}:cloudflare_tag_unproven")
        if not rb.get("defined"):
            reasons.append(f"L:{w}:single_sha_source_no_readback")
        elif not rb.get("sha"):
            reasons.append(f"L:{w}:readback_unproven_status={rb.get('status')}")
        elif tag and rb["sha"] != tag:
            reasons.append(f"L:{w}:sha_mismatch_cloudflare={tag[:12]}_readback={rb['sha'][:12]}")
    if not ev.get("manual_registered"):
        reasons.append(f"M:{MANUAL_KEY}_not_registered_with_owner_written_authorization")
    return ("PROVEN" if not reasons else "NOT_PROVEN"), reasons


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--registry", default=os.path.join(os.path.dirname(__file__), "..", "..", "ops", "publishers.json"))
    ap.add_argument("--account", default=ACCOUNT)
    ap.add_argument("--mock")
    a = ap.parse_args(argv)
    try:
        inventory = json.load(open(a.inventory, encoding="utf-8"))
    except Exception:
        inventory = {}
    registry = json.load(open(a.registry, encoding="utf-8"))
    fetch = mock_fetch(json.load(open(a.mock, encoding="utf-8"))) if a.mock else http_fetch
    env = {k[2:]: v for k, v in os.environ.items() if k.startswith("T_")}
    ev = collect(env, a.account, registry, inventory if isinstance(inventory, dict) else {}, fetch)
    state, reasons = verdict(ev)
    for name, t in ev["tokens"].items():
        print(f"T1_TOKEN {name} configured={str(t.get('configured')).lower()} status={t.get('status')} "
              f"reach={t.get('reach')} policies_readable={t.get('policies_readable')} id={str(t.get('id') or '')[:8]}")
    for r in reasons:
        print(f"T1_EXCLUSIVITY_REASON {r}")
    print(f"T1_EXCLUSIVITY={state}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"exclusivity={state}\nreasons={';'.join(reasons)[:3000]}\n")
    return 0 if state == "PROVEN" else 1


if __name__ == "__main__":
    sys.exit(main())
