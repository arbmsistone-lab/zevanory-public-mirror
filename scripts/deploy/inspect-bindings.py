#!/usr/bin/env python3
import json
d=json.load(open("/tmp/settings.json"))
assert d.get("success") is True, d.get("errors")
for b in d.get("result",{}).get("bindings",[]):
    print("CURRENT_BINDING",b.get("name"),b.get("type"),b.get("service",""),b.get("namespace_id",""))
