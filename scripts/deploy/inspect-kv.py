#!/usr/bin/env python3
import json
d=json.load(open("/tmp/kv.json"))
assert d.get("success") is True, d.get("errors")
for x in d.get("result",[]): print("KV_NAMESPACE",x.get("title"),x.get("id"))
