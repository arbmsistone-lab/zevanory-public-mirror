#!/usr/bin/env python3
"""T1: which workflows can change production Workers, how, and with which credentials.

Separates CODE authority (deploy / rollback / version deploy / deploy script) from CONFIG
authority (secret writes, settings or deployment API calls). Prints a Markdown table and a JSON
summary. This is a static inventory of the code in this repository: it does NOT prove what a
credential is allowed to do at Cloudflare. Effective token permissions must be checked in the
Cloudflare dashboard (see the T1 report).
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
WF = ROOT / ".github" / "workflows"
REG = json.loads((ROOT / "ops" / "publishers.json").read_text(encoding="utf-8"))

CODE = [
    re.compile(r"npx(?: --yes)? wrangler(?:@[\d.]+)? (?:deploy|rollback|versions deploy)\b(?![^\n]*--dry-run)"),
    re.compile(r"node [^\n]*cloudflare-authoritative-repair\.mjs"),
]
CONFIG = [
    re.compile(r"npx(?: --yes)? wrangler(?:@[\d.]+)? secret (?:put|delete|bulk)\b"),
    # Config writer that wraps `wrangler versions secret bulk|delete` + `versions deploy` (T3).
    re.compile(r"worker_secret_rotate\.py[^\n]*--apply"),
    re.compile(r"-X (?:POST|PUT|PATCH|DELETE)\b[^\n]*workers/scripts|workers/scripts[^\n]*-X (?:POST|PUT|PATCH|DELETE)\b"),
]
SECRET = re.compile(r"secrets\.([A-Z0-9_]+)")


def service_of(name: str) -> str:
    for svc, s in REG["services"].items():
        if name in [s["canonical"], *s.get("config_publishers", []), *s.get("pending_owner_authorization", [])]:
            return svc
    if name in REG.get("isolated", {}).values():
        return "isolated"
    if name in REG.get("unserialized_known", {}):
        return "unserialized"
    return "UNREGISTERED"


def rows():
    out = []
    for f in sorted(WF.glob("*.yml")):
        t = f.read_text(encoding="utf-8")
        code = any(r.search(t) for r in CODE)
        config = any(r.search(t) for r in CONFIG)
        if not (code or config):
            continue
        creds = sorted({s for s in SECRET.findall(t) if s.startswith(("CLOUDFLARE", "CF_"))})
        out.append({"workflow": f.name, "service": service_of(f.name),
                    "authority": "code+config" if code and config else ("code" if code else "config"),
                    "cloudflare_credentials": creds})
    return out


def main() -> int:
    data = rows()
    print("| Workflow | Worker | Autoridade | Credenciais Cloudflare |")
    print("|---|---|---|---|")
    for r in data:
        print(f"| {r['workflow']} | {r['service']} | {r['authority']} | {', '.join(r['cloudflare_credentials']) or '-'} |")
    summary = {
        "workflows": len(data),
        "code": sum(r["authority"] != "config" for r in data),
        "config_only": sum(r["authority"] == "config" for r in data),
        "credentials": sorted({c for r in data for c in r["cloudflare_credentials"]}),
        "unregistered": [r["workflow"] for r in data if r["service"] == "UNREGISTERED"],
    }
    print("CREDENTIAL_INVENTORY=" + json.dumps(summary, sort_keys=True))
    return 1 if summary["unregistered"] else 0


if __name__ == "__main__":
    sys.exit(main())
