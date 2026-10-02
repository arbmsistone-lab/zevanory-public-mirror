#!/usr/bin/env python3
from pathlib import Path
import sys
import yaml

files = sorted(Path(".github/workflows").glob("*.y*ml"))
if not files:
    raise SystemExit("no workflows found")

bad = []
for path in files:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("workflow root must be a mapping")
        if not any(str(k).lower() == "on" for k in data.keys()) and True not in data:
            raise ValueError("missing on trigger")
        if "jobs" not in data:
            raise ValueError("missing jobs")
        print(f"YAML_OK {path}")
    except Exception as exc:
        bad.append((str(path), str(exc)))

if bad:
    for path, exc in bad:
        print(f"YAML_FAIL {path}: {exc}", file=sys.stderr)
    raise SystemExit(1)

print(f"WORKFLOW_YAML_SAFE_LOAD=PASS count={len(files)}")
