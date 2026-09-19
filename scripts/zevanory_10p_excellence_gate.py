#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "compliance" / "zevanory-10p-policy.json"
EVIDENCE_DIR = ROOT / "evidence" / "approvals"
TECHNICAL_APPROVAL_RE = re.compile(
    r"(?:ZEVANORY[-_ ]?10P[^\n]{0,120}\b(?:APPROVED|APROVADO|CERTIFIED|CERTIFICADO)\b)"
    r"|(?:data-zevanory-certification\s*=\s*[\"']APPROVED[\"'])"
    r"|(?:\bGREEN_PROVEN\b)",
    re.I,
)

def fail(msg: str) -> int:
    print(f"FAIL: {msg}")
    return 1

def ok(msg: str) -> None:
    print(f"PASS: {msg}")

def load_json(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)

def valid_iso8601(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except Exception:
        return False

def verify_evidence_file(ref: str, expected_sha256: str) -> bool:
    p = (ROOT / ref).resolve()
    try:
        p.relative_to(ROOT.resolve())
    except ValueError:
        return False
    if not p.exists() or not p.is_file():
        return False
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    return digest == expected_sha256.lower()

def validate_manifest(path: Path, policy: dict) -> int:
    errors = 0
    data = load_json(path)
    item_id = data.get("item_id") or path.stem
    status = data.get("status", "UNSUBMITTED")

    allowed = set(policy["approval_requirements"]["allowed_statuses"])
    if status not in allowed:
        errors += fail(f"{path}: status inválido {status!r}")
        return errors

    if status != "APPROVED":
        ok(f"{item_id}: {status} (sem certificação; fail-closed preservado)")
        return errors

    if data.get("standard") != policy["standard"]:
        errors += fail(f"{item_id}: standard divergente")
    if float(data.get("confidence", 0)) < float(policy["minimum_confidence"]):
        errors += fail(f"{item_id}: confidence abaixo de {policy['minimum_confidence']}")
    if float(data.get("excellence", 0)) != float(policy["required_excellence"]):
        errors += fail(f"{item_id}: excellence deve ser exatamente {policy['required_excellence']}")

    pillars = data.get("pillars")
    if not isinstance(pillars, list):
        return errors + fail(f"{item_id}: pillars ausente/inválido")

    by_id = {p.get("id"): p for p in pillars if isinstance(p, dict)}
    for req in policy["pillars"]:
        pid = req["id"]
        p = by_id.get(pid)
        if not p:
            errors += fail(f"{item_id}: {pid} ausente")
            continue
        if p.get("result") != "PROVEN":
            errors += fail(f"{item_id}: {pid} não está PROVEN")
        if float(p.get("confidence", 0)) < float(policy["minimum_confidence"]):
            errors += fail(f"{item_id}: {pid} confidence insuficiente")
        if float(p.get("excellence", 0)) != float(policy["required_excellence"]):
            errors += fail(f"{item_id}: {pid} excellence != 1.0")

        ev = p.get("evidence")
        if not isinstance(ev, list) or not ev:
            errors += fail(f"{item_id}: {pid} sem evidência")
            continue

        for idx, entry in enumerate(ev, 1):
            if not isinstance(entry, dict):
                errors += fail(f"{item_id}: {pid} evidência #{idx} inválida")
                continue
            for key in ("ref", "sha256", "timestamp", "reproduce"):
                if not entry.get(key):
                    errors += fail(f"{item_id}: {pid} evidência #{idx} sem {key}")
            ref = entry.get("ref", "")
            sha = entry.get("sha256", "")
            if ref and sha and not verify_evidence_file(ref, sha):
                errors += fail(f"{item_id}: {pid} evidência #{idx} hash/arquivo inválido")
            if entry.get("timestamp") and not valid_iso8601(entry["timestamp"]):
                errors += fail(f"{item_id}: {pid} evidência #{idx} timestamp inválido")
            if entry.get("reproduce") and len(entry["reproduce"].strip()) < 4:
                errors += fail(f"{item_id}: {pid} evidência #{idx} reprodução insuficiente")

    missing = {p["id"] for p in policy["pillars"]} - set(by_id)
    if missing:
        errors += fail(f"{item_id}: pilares ausentes {sorted(missing)}")

    if errors == 0:
        ok(f"{item_id}: APPROVED com 10/10 pilares PROVEN, confidence>=99%, excellence=100%")
    return errors

def scan_false_approval_claims(manifests: dict[str, dict]) -> int:
    errors = 0
    approved_ids = {k for k, v in manifests.items() if v.get("status") == "APPROVED"}
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if ".git" in path.parts or path.suffix.lower() not in {".html", ".md", ".txt", ".json"}:
            continue
        if path == POLICY_PATH or EVIDENCE_DIR in path.parents:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        if TECHNICAL_APPROVAL_RE.search(text):
            rel = path.relative_to(ROOT).as_posix()
            if not any(item_id in rel or item_id in text for item_id in approved_ids):
                errors += fail(f"{rel}: claim técnico de certificação 10P sem manifesto APPROVED comprovado")
    return errors

def main() -> int:
    errors = 0
    if not POLICY_PATH.exists():
        fail("policy ZEVANORY-10P ausente")
        return 2

    policy = load_json(POLICY_PATH)
    expected_ids = [f"P{i}" for i in range(1, 11)]
    actual_ids = [p.get("id") for p in policy.get("pillars", [])]
    if actual_ids != expected_ids:
        errors += fail(f"policy: pilares devem ser exatamente {expected_ids}")
    if policy.get("approval_mode") != "fail-closed":
        errors += fail("policy: approval_mode deve ser fail-closed")
    if policy.get("score_compensation") is not False:
        errors += fail("policy: score compensation deve ser proibida")
    if policy.get("partial_approval") is not False:
        errors += fail("policy: partial approval deve ser proibida")

    manifests: dict[str, dict] = {}
    if EVIDENCE_DIR.exists():
        for path in sorted(EVIDENCE_DIR.glob("*.json")):
            try:
                data = load_json(path)
                manifests[data.get("item_id") or path.stem] = data
                errors += validate_manifest(path, policy)
            except Exception as exc:
                errors += fail(f"{path}: JSON inválido: {exc}")

    errors += scan_false_approval_claims(manifests)

    if errors:
        print(f"\nZEVANORY 10P EXCELLENCE GATE: FAIL ({errors} erro(s))")
        return 2

    print("\nZEVANORY 10P EXCELLENCE GATE: PASS")
    print("Regra ativa: nenhum item pode ser APPROVED sem 10/10 pilares individualmente PROVEN.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
