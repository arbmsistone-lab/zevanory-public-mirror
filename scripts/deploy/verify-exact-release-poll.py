#!/usr/bin/env python3
import json, os
diag=os.environ.get("VERIFY_DIAG")=="1"
def load(name):
    try:
        return json.load(open(f"/tmp/{name}.json"))
    except Exception as e:
        if diag: print(f"::error title=VERIFY_POLL_UNREADABLE::{name}.json {type(e).__name__}")
        return None
status,health,control,core,zea10=(load(n) or {} for n in ("status","health","control","core","zea10"))
sha=os.environ["TARGET_RUNTIME_SHA"]
checks={
    "status.runtime.sales": (status.get("runtime",{}).get("sales"), "globally-blocked"),
    "health.ready": (health.get("ready"), True),
    "control.global_state": (control.get("global_state"), "operational_commercial_blocked"),
    "control.root_blocker": (control.get("root_blocker"), "global_sale_disabled"),
    "control.release.deployment.commit_sha": (control.get("release",{}).get("deployment",{}).get("commit_sha"), sha),
    "core.release_sha": (core.get("release_sha"), sha),
    "core.architecture.circular_dependency": (core.get("architecture",{}).get("circular_dependency"), False),
    "core.architecture.flow": (core.get("architecture",{}).get("flow"), ["runtime-ci","ZEES-16","ZEA-10","ZEVANORY Control Core","Admin"]),
    "core.invariants.evidence_to_evaluation_unidirectional": (core.get("invariants",{}).get("evidence_to_evaluation_unidirectional"), True),
    "zea10.source_layer": (zea10.get("source_layer"), "ZEES-16"),
    "zea10.authority": (zea10.get("authority"), True),
}
failed=[k for k,(got,want) in checks.items() if got!=want]
if diag:
    for k in failed:
        got,want=checks[k]
        print(f"::error title=VERIFY_POLL_MISMATCH::{k} got={json.dumps(got)[:160]} want={json.dumps(want)[:160]}")
raise SystemExit(0 if not failed else 1)
