#!/usr/bin/env python3
"""DEC-14 inventory (static proof): 178 CP mutants = active (scripts/ci/mutants_conteudo_pronto.py) + retired
(docs/ops/dec14-cp-retirement-registry.json). Fails when:
  - an id is missing, duplicated or both active and retired (the union must be exactly M01..M178);
  - an ACTIVE mutant's anchor does not occur exactly once (it would be INCONCLUSIVE, not a real kill);
  - a RETIRED mutant's anchor still occurs in the repository (its target still exists: it must stay active);
  - a retired item has no reason/removed_code/replacement, or a retired test is still defined in its file;
  - worker/content-service.mjs still has a direct KV write (DEC-14(b)).
It does not run the mutants (the mutants job does) and never declares a mutant killed."""
import json, re, sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutants_conteudo_pronto as m  # noqa: E402

root = Path(__file__).resolve().parents[2]
reg = json.loads((root / "docs/ops/dec14-cp-retirement-registry.json").read_text(encoding="utf-8"))
read = lambda rel: (root / rel).read_text(encoding="utf-8").replace("\r\n", "\n") if (root / rel).exists() else ""
problems = []
active = {}
for name, (path, old, new, assertion) in m.M.items():
    mid = name.split()[0]
    if mid in active: problems.append(f"{mid}: duplicated active id")
    active[mid] = path
    hits = read(path).count(old)
    if hits != 1: problems.append(f"{mid}: active anchor occurs {hits} time(s) in {path}")
retired = {}
for e in reg["mutants"]["retired_items"]:
    mid = e["id"]
    if mid in retired: problems.append(f"{mid}: duplicated retired id")
    retired[mid] = e
    if mid in active: problems.append(f"{mid}: both active and retired")
    if read(e["file"]).count(e["anchor"]) != 0: problems.append(f"{mid}: retired but its anchor is still present in {e['file']}")
    for k in ("reason", "removed_code", "removed_by", "replacement", "category"):
        if not e.get(k): problems.append(f"{mid}: retired without {k}")
expected = {f"M{i:02d}" for i in range(1, 179)}
union = set(active) | set(retired)
if union != expected:
    problems.append(f"census != M01..M178: missing={sorted(expected - union)} extra={sorted(union - expected)}")
if sorted(active, key=lambda x: int(x[1:])) != reg["mutants"]["active_ids"]: problems.append("registry active_ids differs from the runner")
for t in reg["tests"]["items"]:
    if t["state"] == "RETIRED":
        if f'test("{t["title"]}"' in read(t["file"]): problems.append(f"{t['id']}: retired test still defined in {t['file']}")
        for k in ("reason", "removed_code", "replacement"):
            if not t.get(k): problems.append(f"{t['id']}: retired test without {k}")
kv = [i + 1 for i, line in enumerate(read("worker/content-service.mjs").split("\n"))
      if re.search(r"\b(?:kv|kv0|raw)\.(?:put|delete)\s*\(|\bputJson\s*\(", line)]
if kv: problems.append(f"worker/content-service.mjs still writes KV at lines {kv}")
print(json.dumps({"total": len(union), "active": len(active), "retired": len(retired),
                  "retired_tests": sum(t["state"] == "RETIRED" for t in reg["tests"]["items"]),
                  "content_service_kv_writes": len(kv), "problems": problems}, ensure_ascii=False, indent=2))
sys.exit(1 if problems else 0)
