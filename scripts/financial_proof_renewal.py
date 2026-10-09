#!/usr/bin/env python3
"""Order 12-A: authenticated GET-only, fail-closed financial proof renewal.

Calls the existing audited Worker route. No direct writes to provider, database,
checkout, sales switch, or payment state; the audited Worker persists only its
validated derived snapshot. Never print provider IDs, tokens, or raw responses.
"""
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

BASE = "https://zevanory.api.br"
AUDIT_PATH = "/api/internal/audit/financial-classification"
SHA = re.compile(r"^[a-f0-9]{40}$")


class RenewalError(Exception):
    pass


def signature(secret, path, at):
    return hmac.new(secret.encode(), f"GET\n{path}\n{at}".encode(), hashlib.sha256).hexdigest()


def get_json(path, secret="", timeout=28):
    headers = {"Accept": "application/json", "User-Agent": "ZEVANORY-Order12A-ReadOnly/1.0", "Cache-Control": "no-cache"}
    if secret:
        timestamp = str(int(time.time()))
        headers.update({"x-zevanory-audit-ts": timestamp, "x-zevanory-audit-signature": signature(secret, path, timestamp)})
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=headers, method="GET"), timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, {}
    except Exception:
        return 0, {}


def validate_audit(code, body):
    if code != 200:
        raise RenewalError("AUDIT_HTTP_" + str(code))
    if not isinstance(body, dict):
        raise RenewalError("AUDIT_BAD_RESPONSE")
    if body.get("complete") is not True or body.get("ambiguous") != 0:
        raise RenewalError("AUDIT_NOT_COMPLETE_OR_AMBIGUOUS")
    if body.get("snapshot_persist") != "proven":
        raise RenewalError("SNAPSHOT_NOT_PERSISTED")
    snap = body.get("financial_snapshot") or {}
    if not (snap.get("accepted") is True and snap.get("verified_flag") is True
            and snap.get("release_matches") is True and snap.get("schema_ok") is True
            and snap.get("ambiguous") == 0
            and isinstance(snap.get("age_minutes"), (int, float))
            and 0 <= snap["age_minutes"] <= 5):
        raise RenewalError("SNAPSHOT_NOT_ACCEPTED")
    return {"accepted": True, "snapshot_age_minutes": snap["age_minutes"]}


def validate_status(code, body, sha):
    if code != 200 or not isinstance(body, dict):
        raise RenewalError("STATUS_HTTP_" + str(code))
    authorization = body.get("sales_authorization") or {}
    proof = body.get("commercial_metrics_provenance") or {}
    if authorization.get("state") != "open_authorized" or authorization.get("authorized_by_owner") is not True:
        raise RenewalError("OWNER_SALES_AUTHORITY_MISMATCH")
    if body.get("gate") != "G3" or body.get("runtime", {}).get("sales") != "enabled":
        raise RenewalError("COMMERCIAL_RUNTIME_NOT_G3")
    if (proof.get("state") != "PROVEN" or proof.get("commercial_release_allowed") is not True
            or proof.get("exact_release") is not True):
        raise RenewalError("STATUS_PROOF_NOT_LIVE")
    observed = (body.get("release") or {}).get("deployment", {}).get("commit_sha")
    if observed is not None and observed != sha:
        raise RenewalError("STATUS_RELEASE_MISMATCH")
    return {"gate": "G3", "authorized": True, "proven": True}


def renew(secret, fetch=get_json, retries=4, pause=time.sleep):
    if len(secret) < 32:
        raise RenewalError("AUDIT_SECRET_MISSING")
    rc, release = fetch("/api/release")
    sha = ((release.get("deployment") or {}).get("commit_sha") if isinstance(release, dict) else None)
    if rc != 200 or not isinstance(sha, str) or not SHA.fullmatch(sha):
        raise RenewalError("LIVE_RELEASE_UNVERIFIED")
    sw_code, sw = fetch("/api/sales/status")
    if sw_code != 200 or sw.get("open") is not True:
        raise RenewalError("OWNER_SALES_SWITCH_NOT_OPEN")
    audit_code, audit = fetch(AUDIT_PATH, secret)
    snap = validate_audit(audit_code, audit)
    last_error = "STATUS_UNAVAILABLE"
    for i in range(retries):
        st_code, status = fetch("/api/status")
        try:
            proof = validate_status(st_code, status, sha)
            return {"release_sha12": sha[:12], **snap, **proof}
        except RenewalError as exc:
            last_error = str(exc)
            if i < retries - 1:
                pause(10)
    raise RenewalError(last_error)


def main():
    try:
        result = renew(os.getenv("CERTIFICATION_E2E_TOKEN", "").strip())
    except RenewalError as exc:
        print("::error title=ORD12A_FINANCIAL_RENEWAL::" + str(exc))
        return 2
    # Fixed allowlist output only. No raw audit JSON, customer or payment IDs.
    print("ORD12A_FINANCIAL_SNAPSHOT=ACCEPTED")
    print("ORD12A_STATUS=G3")
    print("ORD12A_RELEASE_SHA12=" + result["release_sha12"])
    output = os.getenv("GITHUB_STEP_SUMMARY")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write("## Ordem 12-A: prova financeira renovada\n\n"
                     f"- Snapshot: **ACCEPTED** (idade {result['snapshot_age_minutes']} min)\n"
                     f"- Estado comercial: **G3 / open_authorized**\n"
                     f"- Release: \`{result['release_sha12']}\`\n"
                     "- Auditoria: GET assinado, sem escrita financeira e sem PII\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
