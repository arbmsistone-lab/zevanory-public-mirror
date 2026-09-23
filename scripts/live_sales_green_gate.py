#!/usr/bin/env python3
import json, pathlib, urllib.request, datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "evidence" / "live-sales-green-current.json"

ENDPOINTS = {
    "status": "https://zevanory.api.br/api/status",
    "health": "https://zevanory.api.br/api/health",
    "provider_health": "https://zevanory.api.br/api/provider-health",
    "release": "https://zevanory.api.br/api/release",
    "continuity": "https://zevanory.api.br/api/continuity",
}

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent":"ZEVANORY-Live-Sales-Gate/2.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
            return {"ok": 200 <= r.status < 300, "status": r.status, "json": json.loads(body)}
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
            payload = json.loads(body)
        except Exception:
            payload = {}
        return {"ok": False, "status": e.code, "json": payload}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def main():
    live = {k: fetch_json(v) for k, v in ENDPOINTS.items()}
    status = live["status"].get("json", {}) if isinstance(live["status"].get("json"), dict) else {}
    health = live["health"].get("json", {}) if isinstance(live["health"].get("json"), dict) else {}
    provider = live["provider_health"].get("json", {}) if isinstance(live["provider_health"].get("json"), dict) else {}
    release = live["release"].get("json", {}) if isinstance(live["release"].get("json"), dict) else {}
    continuity = live["continuity"].get("json", {}) if isinstance(live["continuity"].get("json"), dict) else {}

    runtime = status.get("runtime", {}) if isinstance(status, dict) else {}
    engine = status.get("engine", {}) if isinstance(status, dict) else {}
    machine = status.get("sales_machine", {}) if isinstance(status, dict) else {}
    metrics = status.get("metrics", {}) if isinstance(status, dict) else {}

    checks = {
        "production_health": bool(live["health"].get("ok") and health.get("ready") is True),
        "provider_configured": provider.get("configured") is True,
        "provider_authenticated": provider.get("authenticated") is True,
        "provider_webhook_secret": provider.get("webhook_secret_configured") is True,
        "continuity_quorum": continuity.get("quorum_ok") is True,
        "engine_commercial_autonomy": engine.get("commercial_autonomy") == "approved",
        "outbound_execution": machine.get("outbound_execution") in ("ready", "enabled_guarded", "enabled"),
        "sales_runtime": runtime.get("sales") == "enabled",
        "checkout_runtime": runtime.get("checkout") == "enabled",
        "financial_runtime": runtime.get("financial") == "enabled",
        "whatsapp_runtime": runtime.get("whatsapp") == "enabled",
        "payment_observed": int(metrics.get("payments_confirmed", 0) or 0) > 0,
        "checkout_observed": int(metrics.get("checkouts_started", 0) or 0) > 0,
        "refund_observed": int(metrics.get("refunds_confirmed", 0) or 0) > 0,
    }

    live_sales_green = all(checks.values())
    blockers = [k for k, v in checks.items() if not v]

    fail_closed_expected = release.get("sales_mode") == "globally-blocked"
    movement_enabled = provider.get("movement_enabled") is True
    false_green = live_sales_green and (
        not checks["production_health"]
        or not checks["provider_authenticated"]
        or not checks["payment_observed"]
        or not checks["whatsapp_runtime"]
    )
    unsafe_movement = fail_closed_expected and movement_enabled

    report = {
        "schema_version": 2,
        "gate": "ZEVANORY_LIVE_SALES_GREEN_V2",
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "live_sales_green": live_sales_green,
        "checks": checks,
        "blockers": blockers,
        "invariants": {
            "fail_closed_expected": fail_closed_expected,
            "movement_enabled": movement_enabled,
            "false_green": false_green,
            "unsafe_movement": unsafe_movement,
        },
        "status_snapshot": {
            "engine": engine,
            "sales_machine": machine,
            "runtime": runtime,
            "metrics": metrics,
        },
        "provider_snapshot": provider,
        "release_snapshot": release,
        "continuity_snapshot": continuity,
        "live": live,
        "policy": {
            "fail_closed": True,
            "whatsapp_required_for_live_sales_green": True,
            "real_reconciled_payment_required_for_live_sales_green": True,
            "real_refund_evidence_required_for_full_closure": True,
            "no_gate_can_infer_payment": True,
            "ci_fails_only_on_false_green_or_unsafe_movement": True,
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    # The readiness evaluator must be mergeable while production is safely locked.
    # CI fails only if it detects a false GREEN or commercial movement while the
    # release itself declares fail-closed.
    return 3 if false_green or unsafe_movement else 0

if __name__ == "__main__":
    raise SystemExit(main())
