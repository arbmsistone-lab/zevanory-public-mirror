#!/usr/bin/env python3
import json
h=json.load(open("/tmp/predeploy-health.json"))
assert h.get("live") is True and h.get("ready") is True, h
print("LEGACY_PRODUCTION_BRIDGE_ROUTE_REACHABLE")
