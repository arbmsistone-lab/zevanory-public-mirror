#!/usr/bin/env python3
"""Testes negativos e de controle do gate P02 (scripts/p02/decision_registry_gate.py). Sem rede."""
from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("p02gate", ROOT / "scripts/p02/decision_registry_gate.py")
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)  # type: ignore[union-attr]

TODAY = dt.date(2026, 10, 25)
REG = json.loads((ROOT / "data/p02/decisions.json").read_text(encoding="utf-8"))


def rehash(rec: dict) -> dict:
    rec["record_sha256"] = gate.record_hash(rec)
    return rec


def with_decision(mutator, idx: int = 0, keep_hash: bool = False) -> dict:
    reg = copy.deepcopy(REG)
    mutator(reg["decisions"][idx])
    if not keep_hash:
        rehash(reg["decisions"][idx])
    return reg


def measured_decision() -> dict:
    """Controle positivo: decisão MANTER com amostra pré-registrada, n suficiente e fonte verificável."""
    d = copy.deepcopy(REG["decisions"][0])
    d["id"] = "D-2026-0003"
    d["outcome"] = "MANTER"
    d["observed"] = {"status": "MEASURED", "n": {"views_per_side": 250, "intent_events_total": 31},
                     "source": {"kind": "repo", "ref": "data/experiments.json", "contains": "\"minEventsTotal\": 20"}}
    return rehash(d)


class P02GateTest(unittest.TestCase):
    def errs(self, reg, base=None, root=ROOT):
        return gate.validate(root, reg, base, TODAY)

    def assertFailsWith(self, reg, needle, base=None, root=ROOT):
        errs = self.errs(reg, base, root)
        self.assertTrue(any(needle in e for e in errs), f"esperado erro contendo {needle!r}; obtido {errs}")

    def test_real_registry_passes(self):
        self.assertEqual(self.errs(REG), [])

    def test_append_only_against_itself_passes(self):
        self.assertEqual(self.errs(REG, base=copy.deepcopy(REG)), [])

    def test_measured_positive_control_passes(self):
        reg = copy.deepcopy(REG)
        reg["decisions"].append(measured_decision())
        self.assertEqual(self.errs(reg), [])

    def test_no_p01_link_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(p01_hypotheses=[])), "sem ligação a hipótese do P01")

    def test_unknown_p01_hypothesis_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(p01_hypotheses=["H-9999"])), "hipótese do P01 inexistente")

    def test_no_evidence_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(evidence=[])), "decisão sem evidência")

    def test_evidence_snippet_absent_fails(self):
        self.assertFailsWith(with_decision(lambda d: d["evidence"][0].update(contains="trecho que não existe em lugar nenhum")), "trecho citado não aparece")

    def test_evidence_file_missing_fails(self):
        self.assertFailsWith(with_decision(lambda d: d["evidence"][0].update(ref="data/nao-existe.json")), "arquivo de evidência não existe")

    def test_url_only_evidence_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(evidence=[{"kind": "url", "ref": "https://example.org/x"}])), "ao menos uma evidência verificável no repositório")

    def test_decision_without_preregistration_fails(self):
        def m(d):
            d["outcome"] = "REFORMULAR"
            d["observed"] = {"status": "MEASURED", "n": {"x": 10}, "source": {"kind": "repo", "ref": "data/experiments.json", "contains": "\"minEventsTotal\": 20"}}
        self.assertFailsWith(with_decision(m, idx=1), "sem amostra pré-registrada")

    def test_decision_with_not_available_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(outcome="MANTER")), "só pode ser INCONCLUSIVO")

    def test_sample_below_minimum_fails(self):
        reg = copy.deepcopy(REG)
        d = measured_decision()
        d["observed"]["n"]["views_per_side"] = 120
        reg["decisions"].append(rehash(d))
        self.assertFailsWith(reg, "abaixo do mínimo pré-registrado")

    def test_preregistration_same_day_fails(self):
        reg = copy.deepcopy(REG)
        d = measured_decision()
        d["pre_registration"]["registered_at"] = d["decided_at"]
        reg["decisions"].append(rehash(d))
        self.assertFailsWith(reg, "não é pré-registro")

    def test_class_d_without_owner_approval_fails(self):
        reg = copy.deepcopy(REG)
        d = measured_decision()
        d["decision_class"] = "D"
        reg["decisions"].append(rehash(d))
        self.assertFailsWith(reg, "exige aprovação do proprietário")

    def test_not_available_with_number_fails(self):
        self.assertFailsWith(with_decision(lambda d: d["observed"].update(n={"views_per_side": 300})), "número sem fonte")

    def test_tampered_record_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(action="Outra ação qualquer"), keep_hash=True), "record_sha256 não confere")

    def test_base_decision_removed_fails(self):
        reg = copy.deepcopy(REG)
        reg["decisions"] = reg["decisions"][:1]
        self.assertFailsWith(reg, "foi removida", base=copy.deepcopy(REG))

    def test_base_decision_altered_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(action="Ação reescrita depois")), "foi alterada", base=copy.deepcopy(REG))

    def test_future_date_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(decided_at="2026-12-31")), "no futuro")

    def test_non_increasing_id_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(id="D-2026-0001"), idx=1), "ids devem crescer")

    def test_inconclusive_without_reason_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(outcome_reason="curto")), "INCONCLUSIVO exige motivo")

    def test_scope_outside_products_fails(self):
        self.assertFailsWith(with_decision(lambda d: d.update(scope=["produto-inexistente"])), "scope deve listar produtos")

    def test_wrong_schema_version_fails(self):
        reg = copy.deepcopy(REG)
        reg["schema_version"] = 2
        self.assertFailsWith(reg, "schema_version deve ser 1")

    def test_p01_hypothesis_without_verifiable_source_fails(self):
        with tempfile.TemporaryDirectory() as td:
            t = Path(td)
            for rel in ("data/products.json", "data/experiments.json", "scripts/audit/experiments.mjs", "worker/cloudflare-worker.recovered.mjs"):
                (t / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / rel, t / rel)
            p01 = json.loads((ROOT / "data/p01/hypotheses.json").read_text(encoding="utf-8"))
            p01["hypotheses"][1]["sources"] = [{"kind": "repo", "ref": "data/experiments.json", "contains": "hipótese inventada sem fonte"}]
            (t / "data/p01").mkdir(parents=True)
            (t / "data/p01/hypotheses.json").write_text(json.dumps(p01, ensure_ascii=False), encoding="utf-8")
            self.assertFailsWith(REG, "P01 H-0002: hipótese sem fonte verificável", root=t)


if __name__ == "__main__":
    unittest.main(verbosity=2)
