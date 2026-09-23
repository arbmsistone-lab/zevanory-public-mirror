#!/usr/bin/env python3
import json, pathlib, sys, urllib.request, urllib.error, datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "zea10-autonomy" / "contract.json"
BUNDLE = ROOT / "worker" / "cloudflare-worker.recovered.mjs"
OUT = ROOT / "evidence" / "zea10-autonomy-current.json"

def live_json(url):
    req = urllib.request.Request(url, headers={"User-Agent":"ZEA10-Autonomy-Gate/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = r.read().decode("utf-8", "replace")
            return {"ok": 200 <= r.status < 300, "status": r.status, "json": json.loads(body)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def main():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    bundle = BUNDLE.read_text(encoding="utf-8", errors="replace")

    pillars = []
    all_pillars = True
    for p in contract["pillars"]:
        missing = [m for m in p["required_markers"] if m not in bundle]
        ok = not missing
        all_pillars &= ok
        pillars.append({"id":p["id"],"name":p["name"],"ok":ok,"missing":missing})

    journey_missing = [s for s in contract["required_journey_stages"] if s not in bundle]
    channels_missing = [s for s in contract["required_channels"] if s not in bundle]

    approval_markers = [
        "approval",
        "commercial_unlock",
        "fail-closed",
        "idempotency",
    ]
    approval_missing = [m for m in approval_markers if m not in bundle]

    unsafe_default = (
        'commercial_unlock: false' in bundle and
        'sales: false' in bundle and
        'checkout: false' in bundle and
        'financial: false' in bundle
    )

    live = {
        "status": live_json("https://zevanory.api.br/api/status"),
        "health": live_json("https://zevanory.api.br/api/health"),
        "control_plane": live_json("https://zevanory.api.br/api/control-plane")
    }
    live_core_ok = all(x.get("ok") for x in live.values())

    capability_green = (
        all_pillars and not journey_missing and not channels_missing
        and not approval_missing and unsafe_default
    )
    operational_green = capability_green and live_core_ok

    report = {
        "schema_version": 1,
        "gate": "ZEA10_AUTONOMY_GREEN_V1",
        "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "capability_green": capability_green,
        "operational_green": operational_green,
        "commercial_activation_green": False,
        "commercial_activation_note": "Separate gate. Never inferred from capability.",
        "pillars": pillars,
        "journey": {"ok": not journey_missing, "missing": journey_missing},
        "channels": {"ok": not channels_missing, "missing": channels_missing},
        "human_approval_boundary": {"ok": not approval_missing, "missing": approval_missing},
        "safe_default": {"ok": unsafe_default, "sales_enabled": False},
        "live": live,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))

    if not capability_green:
        return 2
    if not operational_green:
        return 3
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
