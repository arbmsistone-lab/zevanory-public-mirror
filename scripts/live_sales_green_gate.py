#!/usr/bin/env python3
import json, pathlib, urllib.request, datetime, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "evidence" / "live-sales-green-current.json"

ENDPOINTS = {
    "status": "https://zevanory.api.br/api/status",
    "health": "https://zevanory.api.br/api/health",
    "activation": "https://zevanory.api.br/api/activation/readiness",
}

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent":"ZEVANORY-Live-Sales-Gate/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body=r.read().decode("utf-8","replace")
            return {"ok":200 <= r.status < 300,"status":r.status,"json":json.loads(body)}
    except Exception as e:
        return {"ok":False,"error":str(e)}

def main():
    live={k:fetch_json(v) for k,v in ENDPOINTS.items()}
    status=live["status"].get("json",{}) if live["status"].get("ok") else {}
    health=live["health"].get("json",{}) if live["health"].get("ok") else {}
    activation=live["activation"].get("json",{}) if live["activation"].get("ok") else {}

    runtime=status.get("runtime",{}) if isinstance(status,dict) else {}
    engine=status.get("engine",{}) if isinstance(status,dict) else {}
    machine=status.get("sales_machine",{}) if isinstance(status,dict) else {}
    metrics=status.get("metrics",{}) if isinstance(status,dict) else {}

    checks = {
        "production_health": bool(live["health"].get("ok") and health.get("ready") is True),
        "engine_commercial_autonomy": engine.get("commercial_autonomy") == "approved",
        "outbound_execution": machine.get("outbound_execution") in ("ready","enabled_guarded","enabled"),
        "sales_runtime": runtime.get("sales") == "enabled",
        "checkout_runtime": runtime.get("checkout") == "enabled",
        "financial_runtime": runtime.get("financial") == "enabled",
        "whatsapp_runtime": runtime.get("whatsapp") == "enabled",
        "payment_observed": int(metrics.get("payments_confirmed",0) or 0) > 0,
        "checkout_observed": int(metrics.get("checkouts_started",0) or 0) > 0,
    }

    # Core readiness intentionally excludes WhatsApp and observed real payment.
    # This lets the company continue proving non-WhatsApp sales paths without
    # pretending that total live-sales readiness is complete.
    sales_core_ready = all(checks[k] for k in (
        "production_health",
        "engine_commercial_autonomy",
        "outbound_execution",
        "sales_runtime",
        "checkout_runtime",
        "financial_runtime",
    ))

    live_sales_green = all(checks.values())

    blockers=[k for k,v in checks.items() if not v]
    report={
        "schema_version":1,
        "gate":"ZEVANORY_LIVE_SALES_GREEN_V1",
        "observed_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sales_core_ready":sales_core_ready,
        "live_sales_green":live_sales_green,
        "checks":checks,
        "blockers":blockers,
        "status_snapshot":{
            "engine":engine,
            "sales_machine":machine,
            "runtime":runtime,
            "metrics":metrics,
        },
        "activation_snapshot":activation,
        "live":live,
        "policy":{
            "fail_closed":True,
            "whatsapp_required_for_live_sales_green":True,
            "real_reconciled_payment_required_for_live_sales_green":True,
            "sales_core_can_progress_without_whatsapp":True,
            "no_gate_can_infer_payment":True,
        }
    }
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if sales_core_ready else 2

if __name__=="__main__":
    raise SystemExit(main())
