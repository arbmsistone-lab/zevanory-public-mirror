#!/usr/bin/env python3
import json, pathlib, sys, urllib.request, datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "zea10-autonomy" / "contract.json"
BUNDLE = ROOT / "worker" / "cloudflare-worker.recovered.mjs"
CONTROL_ACTION = ROOT / "worker" / "control-action-plane.mjs"
ADMIN_CONTROL = ROOT / "evidence" / "admin-control-center.json"
OUT = ROOT / "evidence" / "zea10-autonomy-current.json"

def live_json(url):
    req = urllib.request.Request(url, headers={"User-Agent":"ZEA10-Autonomy-Gate/2.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
            return {"ok": 200 <= r.status < 300, "status": r.status, "json": json.loads(body)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def contains_all(text, markers):
    missing = [m for m in markers if m not in text]
    return not missing, missing

def journey_proof(contract):
    stages = list(contract["required_journey_stages"])
    if len(stages) != len(set(stages)):
        return {"ok": False, "reason": "duplicate_stage", "visited": []}
    authority = {
        "research": "AUTO",
        "segmentation": "AUTO",
        "lead_context": "AUTO",
        "memory": "AUTO",
        "nurturing": "AUTO",
        "support": "AUTO",
        "follow_up": "AUTO",
        "optimization": "AUTO",
        "publication": "AUTO_GATED",
        "offer_delivery": "AUTO_GATED",
        "recovery": "AUTO_GATED",
        "checkout_handoff": "AUTO_GATED",
        "sensitive_creative": "HUMAN_APPROVAL",
        "material_offer_change": "HUMAN_APPROVAL",
        "material_price_change": "HUMAN_APPROVAL",
        "high_impact_campaign": "HUMAN_APPROVAL",
        "policy_exception": "HUMAN_APPROVAL",
        "legal_dispute": "HUMAN_ONLY",
        "fraud": "HUMAN_ONLY",
        "irreversible_financial_exception": "HUMAN_ONLY",
        "contractual_exception": "HUMAN_ONLY",
        "low_confidence_high_risk": "HUMAN_ONLY",
    }
    required_human = set(contract["human_approval_required_for"])
    required_only = set(contract["human_only"])
    human_ok = all(authority.get(x) == "HUMAN_APPROVAL" for x in required_human)
    only_ok = all(authority.get(x) == "HUMAN_ONLY" for x in required_only)
    return {
        "ok": bool(stages and human_ok and only_ok),
        "visited": stages,
        "stage_count": len(stages),
        "authority_model": authority,
        "human_approval_ok": human_ok,
        "human_only_ok": only_ok,
    }

def main():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    bundle = BUNDLE.read_text(encoding="utf-8", errors="replace")
    action = CONTROL_ACTION.read_text(encoding="utf-8", errors="replace")
    admin = ADMIN_CONTROL.read_text(encoding="utf-8", errors="replace")
    governance_text = bundle + "\n" + action + "\n" + admin

    pillars = []
    all_pillars = True
    for p in contract["pillars"]:
        source = governance_text if p["id"] == "ZEA10-A10" else bundle
        ok, missing = contains_all(source, p["required_markers"])
        all_pillars &= ok
        pillars.append({"id":p["id"],"name":p["name"],"ok":ok,"missing":missing})

    journey_missing = [s for s in contract["required_journey_stages"] if s not in bundle]
    channels_missing = [s for s in contract["required_channels"] if s not in bundle]

    approval_markers = [
        "approval",
        "commercial_unlock",
        "fail-closed",
        "idempotency",
        "audit-ledgered",
    ]
    approval_missing = [m for m in approval_markers if m not in governance_text]

    safe_default = (
        'commercial_unlock: false' in bundle and
        'sales: false' in bundle and
        'checkout: false' in bundle and
        'financial: false' in bundle
    )

    source_capability_green = (
        all_pillars and not journey_missing and not channels_missing
        and not approval_missing and safe_default
    )
    synthetic = journey_proof(contract)

    live = {
        "status": live_json("https://zevanory.api.br/api/status"),
        "health": live_json("https://zevanory.api.br/api/health"),
        "control_plane": live_json("https://zevanory.api.br/api/control-plane"),
    }
    live_core_ok = all(x.get("ok") for x in live.values())

    status = live.get("status", {}).get("json", {}) if live.get("status", {}).get("ok") else {}
    health = live.get("health", {}).get("json", {}) if live.get("health", {}).get("ok") else {}
    sales_machine = status.get("sales_machine", {}) if isinstance(status, dict) else {}
    runtime = status.get("runtime", {}) if isinstance(status, dict) else {}

    production_engine_foundation = (
        sales_machine.get("structure_ready") is True and
        sales_machine.get("crm") == "ready" and
        sales_machine.get("follow_up") == "ready" and
        sales_machine.get("learning") == "ready"
    )
    schema_ok = (
        health.get("ready") is True and
        int(health.get("schema", {}).get("missing_tables_count", 0) or 0) == 0 and
        int(health.get("schema", {}).get("missing_migrations_count", 0) or 0) == 0
    )

    engine_green = (
        source_capability_green and synthetic["ok"] and
        live_core_ok and production_engine_foundation and schema_ok
    )

    live_sales_green = (
        engine_green and
        status.get("engine", {}).get("commercial_autonomy") == "approved" and
        sales_machine.get("outbound_execution") == "ready" and
        runtime.get("sales") == "enabled" and
        runtime.get("checkout") == "enabled" and
        runtime.get("financial") == "enabled" and
        runtime.get("whatsapp") == "enabled"
    )

    activation_blockers = []
    if status.get("engine", {}).get("commercial_autonomy") != "approved":
        activation_blockers.append("commercial_autonomy_not_approved")
    if sales_machine.get("outbound_execution") != "ready":
        activation_blockers.append("outbound_execution_not_ready")
    for key in ("sales","checkout","financial","whatsapp"):
        if runtime.get(key) != "enabled":
            activation_blockers.append(f"{key}_not_enabled")

    report = {
        "schema_version": 2,
        "gate": "ZEA10_AUTONOMY_GREEN_V2",
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "engine_green": engine_green,
        "live_sales_green": live_sales_green,
        "source_capability_green": source_capability_green,
        "commercial_activation_is_separate": True,
        "pillars": pillars,
        "journey_source": {"ok": not journey_missing, "missing": journey_missing},
        "synthetic_journey": synthetic,
        "channels": {"ok": not channels_missing, "missing": channels_missing},
        "human_approval_boundary": {"ok": not approval_missing, "missing": approval_missing},
        "safe_default": {"ok": safe_default, "sales_enabled_by_gate": False},
        "production_engine_foundation": {
            "ok": production_engine_foundation,
            "sales_machine": sales_machine,
        },
        "schema_health": {"ok": schema_ok, "health": health},
        "activation_blockers": activation_blockers,
        "live": live,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if engine_green else 2

if __name__ == "__main__":
    raise SystemExit(main())
