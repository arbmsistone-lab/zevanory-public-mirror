#!/usr/bin/env python3
"""Testes da revisão semanal P25 e das travas do workflow agendado. Sem rede."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("p25", ROOT / "scripts/p25/weekly_learning_review.py")
p25 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(p25)  # type: ignore[union-attr]
WORKFLOW = ROOT / ".github/workflows/p25-weekly-learning.yml"


class P25ReviewTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = Path(self._td.name)
        for rel in ("data/experiments.json", "data/p01/hypotheses.json", "data/p02/decisions.json"):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, self.root / rel)

    def tearDown(self):
        self._td.cleanup()

    def add_experiment(self, exp_id: str, change_at: str):
        reg = json.loads((self.root / "data/experiments.json").read_text(encoding="utf-8"))
        reg["experiments"].append({"id": exp_id, "title": "teste", "hypothesis": "h", "metric": "m", "kind": "before_after",
                                   "changeAt": change_at, "windowDays": 14, "minViewsPerSide": 200, "cleanSince": "2026-01-01", "minEventsTotal": 20})
        (self.root / "data/experiments.json").write_text(json.dumps(reg, ensure_ascii=False), encoding="utf-8")

    def row(self, rep, exp_id):
        return next(r for r in rep["experiments"] if r["id"] == exp_id)

    def test_real_registries_are_honest_without_data(self):
        rep = p25.build(ROOT, dt.date(2026, 10, 25), {"run_id": None, "commit_sha": None})
        self.assertEqual(rep["decision"], "SEM_DADOS")
        funnel = next(s for s in rep["sources"] if s["name"].startswith("funil"))
        self.assertEqual(funnel["status"], "NOT_AVAILABLE")
        for r in rep["experiments"]:
            self.assertEqual(r["data"], "NOT_AVAILABLE")
            self.assertIn(r["decision"], ("SEM_DADOS", "INCONCLUSIVO"))
        self.assertEqual(rep["hypotheses_updated"], [])

    def test_non_comparable_design_is_inconclusive(self):
        rep = p25.build(ROOT, dt.date(2026, 10, 25), {})
        r = self.row(rep, "product-page-v2")
        self.assertEqual(r["decision"], "INCONCLUSIVO")
        self.assertFalse(r["window"]["comparable_design"])

    def test_closed_window_without_decision_is_overdue(self):
        self.add_experiment("teste-vencido", "2026-09-01")
        rep = p25.build(self.root, dt.date(2026, 10, 25), {})
        self.assertEqual(self.row(rep, "teste-vencido")["pi_7_days"], "VENCIDO")
        self.assertEqual(rep["pi_7_days"]["status"], "VENCIDO")

    def test_closed_window_inside_7_days_is_pending(self):
        self.add_experiment("teste-pendente", "2026-10-08")
        rep = p25.build(self.root, dt.date(2026, 10, 25), {})
        self.assertTrue(self.row(rep, "teste-pendente")["pi_7_days"].startswith("PENDENTE_ATE_"))

    def test_prior_review_counts_as_recorded_decision(self):
        self.add_experiment("teste-revisado", "2026-09-01")
        prior = self.root / "prior"
        prior.mkdir()
        (prior / "2026-W40.json").write_text(json.dumps({"experiments": [{"id": "teste-revisado", "decision": "INCONCLUSIVO"}]}), encoding="utf-8")
        rep = p25.build(self.root, dt.date(2026, 10, 25), {}, prior=str(prior))
        self.assertEqual(self.row(rep, "teste-revisado")["pi_7_days"], "DECISAO_REGISTRADA")

    def test_open_window(self):
        self.add_experiment("teste-aberto", "2026-10-20")
        rep = p25.build(self.root, dt.date(2026, 10, 25), {})
        self.assertEqual(self.row(rep, "teste-aberto")["pi_7_days"], "JANELA_ABERTA")

    def test_workflow_writes_only_to_evidence_branch_without_secrets(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('EVIDENCE_BRANCH: "evidence/p25-learning"', text)
        self.assertNotIn("secrets.", text)
        self.assertIsNone(re.search(r"HEAD:(refs/heads/)?gh-pages", text))
        self.assertIn('case "$EVIDENCE_BRANCH" in evidence/*)', text)
        self.assertIn("schedule:", text)
        self.assertNotIn("pull_request", text)
        self.assertNotIn("wrangler", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
