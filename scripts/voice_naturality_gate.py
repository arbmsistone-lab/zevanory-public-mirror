#!/usr/bin/env python3
import json
from pathlib import Path

P=Path("evidence/voice-naturality-current.json")
if not P.exists():
    print("VOICE_NATURALITY=NOT_CERTIFIED evidence_missing")
    raise SystemExit(0)

d=json.loads(P.read_text(encoding="utf-8"))
cert=bool(d.get("certified"))
clips=int(d.get("clips",0) or 0)
ratings=int(d.get("blind_ratings",0) or 0)
natural=float(d.get("natural_acceptance_pct",0) or 0)
intellig=float(d.get("intelligibility_pct",0) or 0)
mean=float(d.get("mean_naturalness_5",0) or 0)
blind=bool(d.get("blinded"))
real=bool(d.get("real_tts_audio"))
ptbr=bool(d.get("pt_br"))

requirements={
  "clips>=20": clips>=20,
  "ratings>=100": ratings>=100,
  "blinded": blind,
  "real_tts_audio": real,
  "pt_br": ptbr,
  "natural_acceptance>=99": natural>=99.0,
  "intelligibility>=99": intellig>=99.0,
  "mean_naturalness>=4.8": mean>=4.8,
}
computed=all(requirements.values())
if cert and not computed:
    raise SystemExit("FALSE_GREEN: voice naturality marked certified without evidence thresholds")
print(json.dumps({"certified":computed,"requirements":requirements},ensure_ascii=False))
