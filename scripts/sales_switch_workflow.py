#!/usr/bin/env python3
"""Owner-controlled KV sales switch. No Mercado Pago write calls."""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = "arbmsistone-lab/zevanory-public-mirror"
CF_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
KEY = "sales:open:v1"
PREFLIGHT = "zpc-sales-preflight:v1"
ROOT = "https://zevanory.api.br"
ISO = lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def annotate(label, value):
    clean = re.sub(r"[^A-Za-z0-9_.,:/#\[\]-]", "", str(value))[:300]
    print("::warning::" + label + "=" + clean, flush=True)


def request(url, method="GET", token=None, body=None, cf=False):
    headers = {"Accept": "application/json", "User-Agent": "zevanory-sales-owner-gate/1.0"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        output = resp.read(65536)
        status = resp.status
    if status < 200 or status >= 300:
        raise RuntimeError("HTTP_REQUEST_FAILED")
    if cf and method in ("PUT", "POST"):
        answer = json.loads(output)
        if answer.get("success") is not True:
            raise RuntimeError("CLOUDFLARE_WRITE_REJECTED")
    return output


def github_json(endpoint):
    t = os.environ.get("GH_TOKEN", "")
    if not t:
        raise RuntimeError("GITHUB_READ_TOKEN_UNAVAILABLE")
    return json.loads(request("https://api.github.com/repos/" + REPO + endpoint, token=t))


def production_sha_and_deploy():
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or os.environ.get("GITHUB_REF") != "refs/heads/gh-pages":
        raise RuntimeError("CANONICAL_DISPATCH_REQUIRED")
    actual = github_json("/branches/gh-pages")["commit"]["sha"]
    if actual != os.environ.get("GITHUB_SHA") or not re.fullmatch("[a-f0-9]{40}", actual):
        raise RuntimeError("CANONICAL_SHA_CHANGED")
    history = github_json("/actions/runs?head_sha=" + actual + "&per_page=100")
    deployments = [w for w in history.get("workflow_runs", []) if w.get("name") == "ZEVANORY central production deploy"
                   and w.get("head_sha") == actual and w.get("conclusion") == "success"]
    if not deployments:
        raise RuntimeError("CENTRAL_DEPLOY_NOT_SUCCESS_ON_CANONICAL_SHA")
    return actual, deployments[0]["id"]


def cf_binding():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("CLOUDFLARE_TOKEN_UNAVAILABLE")
    settings = json.loads(request(
        "https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT + "/workers/scripts/zevanory/settings",
        token=token))
    if settings.get("success") is not True:
        raise RuntimeError("CLOUDFLARE_SETTINGS_UNVERIFIED")
    matches = [b.get("namespace_id") for b in settings.get("result", {}).get("bindings", [])
               if b.get("name") == "ZEVANORY_PRIVATE_ARTIFACTS" and b.get("type") == "kv_namespace"]
    if len(matches) != 1 or not re.fullmatch("[a-f0-9]{32}", str(matches[0])):
        raise RuntimeError("SALES_KV_BINDING_NOT_UNIQUE")
    return token, matches[0]


def kv_url(namespace, key):
    return ("https://api.cloudflare.com/client/v4/accounts/" + CF_ACCOUNT +
            "/storage/kv/namespaces/" + namespace + "/values/" +
            urllib.parse.quote(key, safe=""))


def kv_read(token, namespace, key):
    return json.loads(request(kv_url(namespace, key), token=token))


def kv_write(token, namespace, value):
    request(kv_url(namespace, KEY), method="PUT", token=token,
            body=json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode(), cf=True)


def validate_ref(ref):
    if len(ref) < 20 or len(ref) > 200:
        return False
    parsed = urllib.parse.urlsplit(ref)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment or parsed.query:
        return False
    if parsed.hostname == "github.com":
        return bool(re.fullmatch(r"/arbmsistone-lab/zevanory-public-mirror/(?:issues|pull)/\d+", parsed.path))
    if parsed.hostname in ("chatgpt.com", "chat.openai.com"):
        return bool(re.fullmatch(r"/c/[a-zA-Z0-9-]{12,80}", parsed.path))
    return False


def preflight_guard(raw):
    if raw.get("ok") is not True:
        raise RuntimeError("SALES_PREFLIGHT_NOT_GREEN")
    timestamp = raw.get("at")
    try:
        t = dt.datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        if t.tzinfo is None:
            raise ValueError("no tz")
        age = (dt.datetime.now(dt.timezone.utc) - t).total_seconds()
    except Exception as exc:
        raise RuntimeError("SALES_PREFLIGHT_TIMESTAMP_INVALID") from exc
    if age < 0 or age >= 3 * 3600:
        raise RuntimeError("SALES_PREFLIGHT_STALE")
    checks = raw.get("checks")
    if isinstance(checks, dict):
        checks = [{"id": k, **(v if isinstance(v, dict) else {"ok": bool(v)})} for k, v in checks.items()]
    if not isinstance(checks, list) or len(checks) != 8 or not all(isinstance(x, dict) and x.get("ok") is True for x in checks):
        raise RuntimeError("SALES_PREFLIGHT_8_OF_8_NOT_VERIFIED")
    return age


def public_sales_open():
    return json.loads(request(ROOT + "/api/sales/status"))


def await_status(expected):
    # 11 GET reads at 0..50 s; bound < 60 s, account for the 10 s worker cache.
    for n in range(11):
        out = public_sales_open()
        if out.get("open") is expected:
            return True
        if n < 10:
            time.sleep(5)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["open", "close"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.action == "open":
        confirm = os.environ.get("CONFIRM", "")
        ref = os.environ.get("ORDER_REF", "")
        if confirm != "LIBERAR VENDAS" or not validate_ref(ref):
            raise RuntimeError("OWNER_ORDER_CONFIRMATION_INVALID")
        if args.dry_run:
            annotate("OPEN_SALES_DRY_RUN", "PASS_NO_KV_WRITE_NO_NETWORK")
            return
        if os.environ.get("ZEVANORY_LAUNCH_AUTHORIZATION") != "AUTORIZO COMPRA REAL":
            raise RuntimeError("LAUNCH_AUTHORIZATION_NOT_PRESENT")
        if os.environ.get("MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED") != "true":
            raise RuntimeError("PRODUCTION_WEBHOOK_NOT_ATTESTED")
        if not re.fullmatch(r"[a-f0-9]{16}", os.environ.get("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16", "")):
            raise RuntimeError("COLLECTOR_HASH_PROOF_NOT_SET")
        sha, deploy_run = production_sha_and_deploy()
        annotate("OPEN_DEPLOY_SHA", sha)
        annotate("OPEN_DEPLOY_RUN", deploy_run)
        token, ns = cf_binding()
        age = preflight_guard(kv_read(token, ns, PREFLIGHT))
        annotate("OPEN_PREFLIGHT_8_OF_8", "PASS")
        annotate("OPEN_PREFLIGHT_AGE_SECONDS", int(age))
        if public_sales_open().get("open") is not False:
            raise RuntimeError("SALES_NOT_CONFIRMED_CLOSED_BEFORE_OPEN")
        record = {"enabled": True, "authorization": "LIBERAR VENDAS",
                  "by": "owner", "at": ISO(), "ref": ref}
        kv_write(token, ns, record)
        try:
            if not await_status(True):
                raise RuntimeError("OPEN_SALES_NOT_OBSERVED_WITHIN_60_SECONDS")
            annotate("OPEN_SALES", "PASS")
        except Exception:
            # Emergency rollback never depends on preflight or deploy checks.
            kv_write(token, ns, {"enabled": False})
            annotate("OPEN_SALES_ROLLBACK", "CLOSED_ON_VERIFICATION_ERROR")
            raise
    else:
        if args.dry_run:
            annotate("CLOSE_SALES_DRY_RUN", "PASS_NO_KV_WRITE_NO_NETWORK")
            return
        if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or os.environ.get("GITHUB_REF") != "refs/heads/gh-pages":
            raise RuntimeError("CANONICAL_DISPATCH_REQUIRED")
        token, ns = cf_binding()
        kv_write(token, ns, {"enabled": False})
        annotate("CLOSE_SALES_KV", "ENABLED_FALSE")
        if not await_status(False):
            raise RuntimeError("CLOSE_SALES_STATUS_NOT_OBSERVED_WITHIN_60_SECONDS")
        annotate("CLOSE_SALES", "PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Print only local error identifiers, never raw HTTP bodies, URLs or tokens.
        annotate("SALES_SWITCH_ERROR", type(error).__name__ + ":" + str(error)[:90])
        sys.exit(1)
