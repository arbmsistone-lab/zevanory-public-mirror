#!/usr/bin/env python3
import json,sys
path=sys.argv[1] if len(sys.argv)>1 else "/tmp/rollback-health.json"
h=json.load(open(path))
raise SystemExit(0 if h.get("live") is True and h.get("ready") is True else 1)
