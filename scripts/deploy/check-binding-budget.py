#!/usr/bin/env python3
import json,sys

config=json.load(open(sys.argv[1],encoding="utf-8"))
settings=json.load(open(sys.argv[2],encoding="utf-8"))
bindings=(settings.get("result") or {}).get("bindings") or []
secret_names={row.get("name") for row in bindings if row.get("type") in {"secret_text","secret_key"}}
plain_names=set((config.get("vars") or {}).keys())
planned=secret_names|plain_names|{"CHANNEL_CREDENTIALS_JSON"}
if len(planned)>60:
    print(f"::error title=BINDING_BUDGET::exceeded planned={len(planned)} max=60 (secrets={len(secret_names)} vars={len(plain_names)})")
    raise SystemExit(f"BINDING_BUDGET_EXCEEDED planned={len(planned)} max=60")
print(f"BINDING_BUDGET_PASS planned={len(planned)} spare={64-len(planned)}")
