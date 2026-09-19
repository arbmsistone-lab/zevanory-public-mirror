#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "evidence" / "zees16" / "current.json"
COVERAGE_DIR = ROOT / "evidence" / "zees16" / "coverage"
PROOFS_DIR = ROOT / "evidence" / "zees16" / "proofs"
ALLOWED_STATES = {"PROVADO", "PARTIAL", "BLOCKED", "N/A", "EXTERNAL"}
PILLARS = {f"P{i:02d}" for i in range(1, 17)}
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def fail(message: str) -> int:
    print(f"FAIL: {message}")
    return 1


def ok(message: str) -> None:
    print(f"PASS: {message}")


def main() -> int:
    errors = 0
    if not REGISTRY.exists():
        return fail("registry evidence/zees16/current.json ausente")

    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except Exception as exc:
        return fail(f"registry JSON invalido: {exc}")

    if data.get("schema") != "zees16-evidence-registry/v1":
        errors += fail("schema divergente")
    if data.get("version") != "ZEES-16/2026.09":
        errors += fail("versao ZEES divergente")
    if data.get("approval_mode") != "fail-closed":
        errors += fail("approval_mode precisa ser fail-closed")

    targets = data.get("targets")
    if not isinstance(targets, list) or not targets:
        errors += fail("targets ausente/vazio")
        targets = []

    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for target in targets:
        if not isinstance(target, dict):
            errors += fail("target invalido")
            continue
        tid = str(target.get("id", ""))
        name = str(target.get("name", ""))
        state = str(target.get("state", ""))
        canonical_sha = str(target.get("canonical_sha", ""))

        if not tid or tid in seen_ids:
            errors += fail(f"target id ausente/duplicado: {tid!r}")
        seen_ids.add(tid)
        if not name or name in seen_names:
            errors += fail(f"target name ausente/duplicado: {name!r}")
        seen_names.add(name)
        if state not in ALLOWED_STATES:
            errors += fail(f"{tid}: state invalido {state!r}")
        if not SHA40.fullmatch(canonical_sha):
            errors += fail(f"{tid}: canonical_sha invalido")

        evidence = target.get("evidence")
        if not isinstance(evidence, list):
            errors += fail(f"{tid}: evidence precisa ser lista")
            continue

        for idx, entry in enumerate(evidence, 1):
            if not isinstance(entry, dict):
                errors += fail(f"{tid}: evidence #{idx} invalida")
                continue
            pillar = str(entry.get("pillar", ""))
            ev_state = str(entry.get("state", ""))
            source = str(entry.get("source", ""))
            sha = str(entry.get("sha", ""))
            claim = str(entry.get("claim", ""))

            if pillar not in PILLARS:
                errors += fail(f"{tid}: evidence #{idx} pillar invalido {pillar!r}")
            if ev_state not in ALLOWED_STATES:
                errors += fail(f"{tid}/{pillar}: estado invalido {ev_state!r}")
            if not source.strip():
                errors += fail(f"{tid}/{pillar}: source ausente")
            if not claim.strip():
                errors += fail(f"{tid}/{pillar}: claim ausente")
            if sha and not SHA40.fullmatch(sha):
                errors += fail(f"{tid}/{pillar}: sha invalido")

            # PROVADO is intentionally difficult: the registry must provide a
            # reproducible command/path and an exact source SHA.
            if ev_state == "PROVADO":
                if not SHA40.fullmatch(sha):
                    errors += fail(f"{tid}/{pillar}: PROVADO sem SHA exato")
                if not str(entry.get("reproduce", "")).strip():
                    errors += fail(f"{tid}/{pillar}: PROVADO sem reproduce")
                proof_path = PROOFS_DIR / f"{tid}-{pillar}.json"
                if not proof_path.exists():
                    errors += fail(f"{tid}/{pillar}: PROVADO sem proof manifest")
                else:
                    try:
                        proof = json.loads(proof_path.read_text(encoding="utf-8"))
                        if proof.get("schema") != "zees16-proof/v1":
                            errors += fail(f"{tid}/{pillar}: proof schema invalido")
                        if proof.get("target") != tid or proof.get("pillar") != pillar:
                            errors += fail(f"{tid}/{pillar}: proof identidade divergente")
                        if proof.get("status") != "PASS":
                            errors += fail(f"{tid}/{pillar}: proof nao PASS")
                        if proof.get("target_sha") != canonical_sha:
                            errors += fail(f"{tid}/{pillar}: proof SHA nao canonico")
                        if not isinstance(proof.get("run_id"), int) or proof["run_id"] <= 0:
                            errors += fail(f"{tid}/{pillar}: proof run_id invalido")
                        artifact = proof.get("artifact") or {}
                        evidence_chain = proof.get("evidence") or []
                        if artifact:
                            if not SHA256.fullmatch(str(artifact.get("sha256", ""))):
                                errors += fail(f"{tid}/{pillar}: proof artifact digest invalido")
                        elif pillar == "P15":
                            providers = {str(e.get("provider", "")) for e in evidence_chain if isinstance(e, dict)}
                            hashes = [str(e.get("evidence_hash", "")) for e in evidence_chain if isinstance(e, dict) and e.get("evidence_hash")]
                            if len(providers) < 3 or len(hashes) < 2 or any(not SHA256.fullmatch(h) for h in hashes):
                                errors += fail(f"{tid}/{pillar}: proof quorum/provenance chain invalida")
                        else:
                            errors += fail(f"{tid}/{pillar}: proof artifact ausente")
                        if not str(proof.get("reproduce", "")).strip():
                            errors += fail(f"{tid}/{pillar}: proof sem reproducao")
                    except Exception as exc:
                        errors += fail(f"{tid}/{pillar}: proof invalido: {exc}")

            for artifact in entry.get("artifacts", []) or []:
                digest = str(artifact.get("sha256", ""))
                if not SHA256.fullmatch(digest):
                    errors += fail(f"{tid}/{pillar}: artifact sha256 invalido")

    # Identity isolation is a hard invariant.
    if "arbm-one-system" not in seen_ids:
        errors += fail("ARBM ONE privado ausente")
    if "ZEVANORY ONE" in seen_names and "ARBM ONE" not in seen_names:
        errors += fail("ZEVANORY ONE nao pode substituir ARBM ONE no registro")

    # The support registry must never masquerade as an approval manifest.
    raw = REGISTRY.read_text(encoding="utf-8")
    if '"status": "APPROVED"' in raw or '"approval": "APPROVED"' in raw:
        errors += fail("registry de apoio nao pode declarar APPROVED")

    parity = data.get("product_page_blob_parity", [])
    if not isinstance(parity, list):
        errors += fail("product_page_blob_parity invalido")
    else:
        for row in parity:
            if not isinstance(row, list) or len(row) != 2 or not SHA40.fullmatch(str(row[1])):
                errors += fail(f"blob parity invalido: {row!r}")

    index_path = COVERAGE_DIR / "index.json"
    if not index_path.exists():
        errors += fail("coverage/index.json ausente")
    else:
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
            targets = index.get("targets", [])
            if not isinstance(targets, list) or not targets:
                errors += fail("coverage index sem targets")
            for target_id in targets:
                path = COVERAGE_DIR / f"{target_id}.json"
                if not path.exists():
                    errors += fail(f"coverage ausente: {target_id}")
                    continue
                doc = json.loads(path.read_text(encoding="utf-8"))
                pillars = doc.get("pillars", [])
                ids = [str(item.get("id", "")) for item in pillars if isinstance(item, dict)]
                if len(pillars) != 16 or set(ids) != PILLARS:
                    errors += fail(f"{target_id}: deve conter exatamente P01..P16")
                for item in pillars:
                    if not isinstance(item, dict):
                        continue
                    state = str(item.get("state", ""))
                    if state not in ALLOWED_STATES:
                        errors += fail(f"{target_id}/{item.get('id')}: state invalido")
                    if state == "N/A" and not str(item.get("next", "")).startswith("N/A:"):
                        errors += fail(f"{target_id}/{item.get('id')}: N/A sem justificativa")
                    if state == "PROVADO":
                        pillar_id = str(item.get("id", ""))
                        proof_path = PROOFS_DIR / f"{target_id}-{pillar_id}.json"
                        if not proof_path.exists():
                            errors += fail(f"{target_id}/{pillar_id}: coverage PROVADO sem proof manifest")
                        else:
                            proof = json.loads(proof_path.read_text(encoding="utf-8"))
                            if proof.get("status") != "PASS" or proof.get("target") != target_id or proof.get("pillar") != pillar_id:
                                errors += fail(f"{target_id}/{pillar_id}: proof manifest nao fecha o coverage")
                            if not SHA40.fullmatch(str(proof.get("target_sha", ""))):
                                errors += fail(f"{target_id}/{pillar_id}: proof SHA invalido")
                            artifact = proof.get("artifact") or {}
                            evidence_chain = proof.get("evidence") or []
                            if artifact:
                                if not SHA256.fullmatch(str(artifact.get("sha256", ""))):
                                    errors += fail(f"{target_id}/{pillar_id}: proof artifact digest invalido")
                            elif pillar_id == "P15":
                                providers = {str(e.get("provider", "")) for e in evidence_chain if isinstance(e, dict)}
                                hashes = [str(e.get("evidence_hash", "")) for e in evidence_chain if isinstance(e, dict) and e.get("evidence_hash")]
                                if len(providers) < 3 or len(hashes) < 2 or any(not SHA256.fullmatch(h) for h in hashes):
                                    errors += fail(f"{target_id}/{pillar_id}: proof quorum/provenance chain invalida")
                            else:
                                errors += fail(f"{target_id}/{pillar_id}: proof artifact ausente")
                            if not str(proof.get("reproduce", "")).strip():
                                errors += fail(f"{target_id}/{pillar_id}: proof sem reproducao")
        except Exception as exc:
            errors += fail(f"coverage invalida: {exc}")

    if errors:
        print(f"\nZEES-16 EVIDENCE GATE: FAIL ({errors} erro(s))")
        return 2

    ok(f"registry valido: {len(targets)} targets, fail-closed preservado")
    print("ZEES-16 EVIDENCE GATE: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
