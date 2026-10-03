#!/usr/bin/env python3
import json
d=json.load(open("/tmp/scripts.json"))
assert d.get("success") is True, d.get("errors")
for x in d.get("result",[]): print("WORKER_SCRIPT",x.get("id"))
