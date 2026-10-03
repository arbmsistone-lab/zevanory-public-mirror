#!/usr/bin/env python3
import json, os
try:
    status=json.load(open("/tmp/status.json"))
    health=json.load(open("/tmp/health.json"))
    control=json.load(open("/tmp/control.json"))
    core=json.load(open("/tmp/core.json"))
    zea10=json.load(open("/tmp/zea10.json"))
except Exception:
    raise SystemExit(1)
ok=(
    status.get("runtime",{}).get("sales")=="globally-blocked"
    and health.get("ready") is True
    and control.get("global_state")=="operational_commercial_blocked"
    and control.get("root_blocker")=="global_sale_disabled"
    and control.get("release",{}).get("deployment",{}).get("commit_sha")==os.environ["TARGET_RUNTIME_SHA"]
    and core.get("release_sha")==os.environ["TARGET_RUNTIME_SHA"]
    and core.get("architecture",{}).get("circular_dependency") is False
    and core.get("architecture",{}).get("flow")==["runtime-ci","ZEES-16","ZEA-10","ZEVANORY Control Core","Admin"]
    and core.get("invariants",{}).get("evidence_to_evaluation_unidirectional") is True
    and zea10.get("source_layer")=="ZEES-16"
    and zea10.get("authority") is False
)
raise SystemExit(0 if ok else 1)
