#!/usr/bin/env python3
"""ZEVANORY Order 16 first-production-order watchdog.

READS only official public status and aggregates from the production Neon DB.
Only a verified paid-delivery breach triggers the existing emergency Cloudflare
KV closure and a sanitized owner alert. No checkout, MP, or PII operations.
"""
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = "https://zevanory.api.br"
ALERT_ISSUE = "https://api.github.com/repos/arbmsistone-lab/zevanory-public-mirror/issues/576/comments"


class WatchError(Exception):
    pass


def notice(key, value, warning=False):
    # No arbitrary provider errors or secret-containing responses in logs.
    key = "".join(c for c in str(key) if c.isupper() or c == "_")[:35]
    value = "".join(c for c in str(value) if c.isalnum() or c in "_-.")[:75]
    level = "warning" if warning else "notice"
    print(f"::{level} title=ZEVANORY_{key}::{value}", flush=True)


def get_status(path, fetch=None):
    if fetch is not None:
        return fetch(path)
    try:
        req = urllib.request.Request(ROOT + path, headers={
            "Accept": "application/json", "Cache-Control": "no-store",
            "User-Agent": "zevanory-first-order-watch-v1"
        }, method="GET")
        with urllib.request.urlopen(req, timeout=20) as reply:
            if reply.status != 200:
                return None
            return json.load(reply)
    except Exception:
        return None


def read_paid_delivery_counts(fetch=None):
    """Signed GET-only aggregate, using existing Worker HMAC. No DB credential in Actions."""
    import hashlib
    import hmac
    import time
    key = os.getenv("CERTIFICATION_E2E_TOKEN", "").strip()
    if len(key) < 32:
        raise WatchError("AUDIT_SECRET_MISSING")
    path = "/api/internal/watch/paid-delivery"
    ts = str(int(time.time()))
    signature = hmac.new(key.encode(), f"GET\n{path}\n{ts}".encode(), hashlib.sha256).hexdigest()
    headers = {
        "Accept": "application/json", "Cache-Control": "no-store",
        "User-Agent": "ZEVANORY-Order17-Watch/1.0",
        "x-zevanory-audit-ts": ts, "x-zevanory-audit-signature": signature,
    }
    if fetch:
        body = fetch(path, headers)
    else:
        try:
            req = urllib.request.Request(ROOT + path, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=25) as response:
                body = json.load(response) if response.status == 200 else None
        except Exception as exc:
            raise WatchError("SIGNED_WATCH_UNAVAILABLE") from exc
    if not isinstance(body, dict) or body.get("schema") != "zevanory.first-order-watch.v1":
        raise WatchError("SIGNED_WATCH_SCHEMA_INVALID")
    counts = body.get("counts")
    keys = ("checkouts", "paid", "delivered", "overdue_paid", "fulfillment_failed")
    if not isinstance(counts, dict) or not all(type(counts.get(k)) is int and 0 <= counts[k] <= 100000000 for k in keys):
        raise WatchError("SIGNED_WATCH_COUNTS_INVALID")
    if counts["delivered"] > counts["paid"] or counts["overdue_paid"] > counts["paid"] or counts["fulfillment_failed"] > counts["paid"]:
        raise WatchError("SIGNED_WATCH_COUNTS_INCONSISTENT")
    return {k: counts[k] for k in keys}


def evaluate(status, sales, counts):
    """No unverified 'paid' can be inferred from page views or checkouts."""
    public_open = isinstance(sales, dict) and sales.get("open") is True
    public_closed = isinstance(sales, dict) and sales.get("open") is False
    metrics = status.get("metrics", {}) if isinstance(status, dict) else {}
    gate = status.get("gate") if isinstance(status, dict) else None
    authority = (status.get("sales_authorization") or {}).get("state") if isinstance(status, dict) else None
    healthy = gate == "G3" and authority == "open_authorized"
    if not isinstance(counts, dict):
        raise WatchError("DB_COUNTS_MISSING")
    overdue = int(counts["overdue_paid"]) > 0
    delivery_failed = int(counts["fulfillment_failed"]) > 0
    # Failures in the webhook require explicit, authoritative evidence rather
    # than guessing from an empty order list or temporary HTTP errors.
    webhook_failed = isinstance(status, dict) and (status.get("webhook_health") == "failed" or
        isinstance(status.get("webhook_health"), dict) and status["webhook_health"].get("status") == "failed")
    breach = overdue or delivery_failed or webhook_failed
    reason = "PAID_UNDELIVERED_15M" if overdue else (
        "FULFILLMENT_FAILED" if delivery_failed else "WEBHOOK_FAILED" if webhook_failed else "NONE")
    return {
        "sales_open": public_open, "sales_closed": public_closed, "gate": gate,
        "authority": authority, "gate_healthy": healthy, "breach": breach, "reason": reason,
        "metrics": {k: metrics.get(k) for k in ("orders", "payments_confirmed", "checkouts_started")},
        "counts": counts,
    }


def authorized_canonical_job():
    return (os.getenv("GITHUB_REF") == "refs/heads/gh-pages"
            and os.getenv("GITHUB_EVENT_NAME") in ("schedule", "workflow_dispatch")
            and os.getenv("GITHUB_WORKFLOW_REF", "").split("@")[0].endswith(
                "/.github/workflows/zevanory-first-order-watch.yml"))


def emergency_close(reason, close_impl=None):
    if reason not in ("PAID_UNDELIVERED_15M", "FULFILLMENT_FAILED", "WEBHOOK_FAILED"):
        raise WatchError("CLOSE_REASON_UNAUTHORIZED")
    if not authorized_canonical_job():
        raise WatchError("CANONICAL_WATCH_REQUIRED")
    if close_impl is not None:
        return close_impl(reason)
    scripts = str(pathlib.Path(__file__).resolve().parent)
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import sales_switch_workflow as switch
    # Reuse the exact Cloudflare namespace, settings failover, KV safety write,
    # and 60-second public readback implemented for zevanory-close-sales.
    token, ns = switch.close_binding()
    switch.kv_write(token, ns, {"enabled": False, "at": switch.ISO(), "by": "auto-safety-watch"})
    if not switch.await_status(False):
        raise WatchError("CLOSE_NOT_CONFIRMED")
    return True


def send_owner_alert(reason, send=None):
    if send is not None:
        return bool(send(reason))
    key = os.getenv("RESEND_API_KEY", "")
    if not key:
        return False
    email = os.getenv("OWNER_ALERT_EMAIL", "zevanory@gmail.com")
    if not email or "\n" in email or "\r" in email or "@" not in email:
        return False
    from_addr = os.getenv("RESEND_FROM_ADDRESS", "ZEVANORY <contato@zevanory.api.br>")
    content = {
        "from": from_addr, "to": [email],
        "subject": "ZEVANORY: vendas fechadas por seguranca de entrega",
        "text": "O monitor independente identificou " + reason +
                ". A rotina oficial fechou o interruptor de vendas."
                "\nConfira o painel e a entrega, sem reabrir vendas automaticamente."
    }
    try:
        data = json.dumps(content).encode()
        req = urllib.request.Request("https://api.resend.com/emails", data=data,
            headers={"Authorization": "Bearer "+key, "Content-Type": "application/json",
                     "Idempotency-Key": "zevanory-first-order-watch-"+reason+"-"+dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def comment_orchestrator(reason):
    token = os.getenv("GITHUB_TOKEN", "")
    if not token:
        return False
    content = {
        "body": "ORDEM 16 | FIRST_ORDER_WATCH: " + reason +
                ". Emergencia de entrega identificada. Verifique imediatamente o interruptor de vendas, "
                "o webhook e o fulfillment; nenhum dado pessoal foi registrado."
    }
    try:
        req = urllib.request.Request(ALERT_ISSUE, data=json.dumps(content).encode(),
            headers={"Accept": "application/vnd.github+json", "Authorization": "Bearer "+token,
                     "Content-Type": "application/json", "User-Agent": "zevanory-first-order-watch"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status == 201
    except Exception:
        return False


def watch(status, sales, counts, close_impl=None, alert_impl=None, comment_impl=None):
    report = evaluate(status, sales, counts)
    notice("GATE", report["gate"] or "unavailable")
    notice("AUTHORITY", report["authority"] or "unavailable")
    notice("ORDERS", report["metrics"]["orders"] if report["metrics"]["orders"] is not None else "unknown")
    notice("PAID", report["counts"]["paid"])
    notice("CHECKOUTS", report["counts"]["checkouts"])
    notice("OVERDUE_15M", report["counts"]["overdue_paid"])
    if not report["breach"]:
        notice("WATCH_RESULT", "NO_DELIVERY_BREACH")
        return report
    notice("SAFETY_BREACH", report["reason"], warning=True)
    # Already closed: neither reopen nor send a duplicate notification.
    if report["sales_closed"]:
        notice("ALREADY_CLOSED", "TRUE")
        return report
    try:
        emergency_close(report["reason"], close_impl=close_impl)
        notice("EMERGENCY_CLOSE", "CONFIRMED", warning=True)
        report["closed"] = True
    except Exception:
        notice("EMERGENCY_CLOSE", "FAILED", warning=True)
        report["closed"] = False
    sent = send_owner_alert(report["reason"], send=alert_impl) if report["closed"] else False
    notice("OWNER_EMAIL", "SENT" if sent else "NOT_CONFIRMED", warning=not sent)
    commented = bool(comment_impl(report["reason"])) if comment_impl is not None else comment_orchestrator(report["reason"])
    notice("ORCHESTRATOR_ALERT", "RECORDED" if commented else "NOT_CONFIRMED", warning=not commented)
    if not report["closed"] or not sent:
        raise WatchError("EMERGENCY_RESPONSE_INCOMPLETE")
    return report


def main():
    if not authorized_canonical_job():
        notice("CANONICAL_JOB", "DENIED", warning=True)
        return 2
    status = get_status("/api/status")
    sales = get_status("/api/sales/status")
    try:
        counts = read_paid_delivery_counts()
        outcome = watch(status, sales, counts)
        if not outcome["breach"] and not outcome["gate_healthy"] and not outcome["sales_closed"]:
            notice("COMMERCIAL_STATUS", "NOT_G3_OR_UNVERIFIED", warning=True)
            return 1
        return 0
    except WatchError as exc:
        notice("WATCH_ERROR", str(exc), warning=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
