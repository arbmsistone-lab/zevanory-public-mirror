#!/usr/bin/env python3
from __future__ import annotations
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence" / "provider-independence.json"

def fail(msg: str) -> int:
    print(f"FAIL: {msg}")
    return 2

def main() -> int:
    try:
        c = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    except Exception as exc:
        return fail(f"provider evidence invalid: {exc}")

    if c.get("min_operational_channel_quorum") != 3:
        return fail("min_operational_channel_quorum must be 3")
    if c.get("whatsapp_dependency_required") is not False:
        return fail("WhatsApp must remain optional for continuity")
    if c.get("commercial_actions_remain_fail_closed") is not True:
        return fail("commercial actions must remain fail-closed")
    if c.get("rollback_version") != "52a989a2":
        return fail("rollback_version mismatch")

    node = r'''
import { buildContinuityPlan } from "./worker/continuity-router.mjs";
const productionBlocked = {scope_status:"active",release_gate:"globally-blocked",commercial_execution:"blocked"};
const transportDown = {scope_status:"down",release_gate:"globally-blocked",commercial_execution:"blocked"};
const status = {
  runtime:{sales:"globally-blocked"},
  channel_readiness:{
    zevanory:productionBlocked,email:productionBlocked,instagram:productionBlocked,
    facebook:productionBlocked,youtube:productionBlocked,mercado_livre:productionBlocked,
    whatsapp:transportDown
  }
};
const plan=buildContinuityPlan(status,{minQuorum:3});
if(!plan.quorum_ok) throw new Error("technical quorum must survive commercial lock");
if(plan.mode!=="provider_independent") throw new Error("wrong technical continuity mode");
if(plan.available_channels.length<3) throw new Error("insufficient transport fallbacks");
if(plan.commercial_available_channels.length!==0) throw new Error("commercial fail-closed regression");
if(plan.whatsapp_dependency_required!==false) throw new Error("WhatsApp dependency regression");
if(plan.whatsapp_transport_operational!==false) throw new Error("WhatsApp transport should be down");
if(plan.sales_state!=="globally-blocked") throw new Error("sales lock regression");
const degraded=buildContinuityPlan({
  runtime:{sales:"globally-blocked"},
  channel_readiness:{zevanory:productionBlocked,email:transportDown,instagram:transportDown}
},{minQuorum:3});
if(degraded.quorum_ok) throw new Error("below-quorum transport must fail closed");
if(degraded.mode!=="degraded_fail_closed") throw new Error("degraded mode mismatch");
'''
    subprocess.run(["node", "--input-type=module", "-e", node], cwd=ROOT, check=True)

    req = urllib.request.Request(
        "https://zevanory.api.br/api/status",
        headers={"User-Agent":"ZEVANORY-Provider-Independence/3.0","Accept":"application/json"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        if r.status != 200:
            return fail(f"production status HTTP {r.status}")
        body = json.loads(r.read().decode())

    channels = body.get("channel_readiness", {})
    technical = [
        name for name, state in channels.items()
        if str(state.get("scope_status", "")).lower() == "active" and name != "whatsapp"
    ]
    commercial = [
        name for name, state in channels.items()
        if str(state.get("scope_status", "")).lower() == "active"
        and str(state.get("release_gate", "")).lower() not in ("blocked","globally-blocked","disabled")
        and str(state.get("commercial_execution", "")).lower() not in ("blocked","globally-blocked","disabled")
    ]
    if len(technical) < 3:
        return fail(f"technical quorum below 3: {technical}")
    if body.get("runtime", {}).get("sales") != "globally-blocked":
        return fail("sales fail-closed state regressed")
    if commercial:
        return fail(f"commercial channels unexpectedly active: {commercial}")

    cfg = ROOT / "wrangler.continuity-proof.jsonc"
    cfg.write_text("""{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "zevanory-continuity-proof",
  "main": "worker/cloudflare-worker.compat.mjs",
  "compatibility_date": "2026-09-04",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": true
}
""", encoding="utf-8")
    try:
        with tempfile.TemporaryDirectory() as outdir:
            subprocess.run(
                ["npx","--yes","wrangler@4.135.0","deploy","--dry-run","--config",str(cfg),"--outdir",outdir],
                cwd=ROOT, check=True
            )
            if not any(pathlib.Path(outdir).glob("*.js")) and not any(pathlib.Path(outdir).glob("*.mjs")):
                return fail("Wrangler dry-run produced no worker bundle")
    finally:
        cfg.unlink(missing_ok=True)

    print("P14 PROVIDER INDEPENDENCE: PASS")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
