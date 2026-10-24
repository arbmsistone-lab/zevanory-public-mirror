"""Contraprovas do runner de mutantes do suporte@ (scripts/ci/mutants_support_email.py) sobre o classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (#901). Específicas de #900 (auditor Sol):
  (a) teste primário falhando em OUTRA asserção (marcador diferente)        => INCONCLUSIVE
  (b) todo / todo inesperado                                                 => INCONCLUSIVE
  (c) contagem de pontos TAP incoerente com o plano ou com o resumo          => INCONCLUSIVE
e ainda: falha só em secundário, falha não relacionada, queda/sintaxe/timeout => INCONCLUSIVE; asserção primária
casada => KILLED. A config é validada antes (sem justificativa, primary sem marcador, teste inexistente => recusa).
Parte REAL (node roda suítes mínimas com marcadores [Xnn.k]) e parte com TAP real adulterado. Sem rede, sem segredo.
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("mut_support", ROOT / "scripts" / "ci" / "mutants_support_email.py")
mut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mut)
mc = mut.mc

SUITE = '''import test from "node:test";
import assert from "node:assert/strict";
'''


def spec_for(primary_label="[T01.1]", secondary=()):
    return mc.load_mutant_config({"m": {
        "primary": [{"test_pattern": "T01 regra", "assertion_pattern": primary_label}],
        "secondary": [{"test_pattern": t, "assertion_pattern": None, "justification": "pré-condição"} for t in secondary]}})["m"]


class RealNode(unittest.TestCase):
    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente: contraprova não pode rodar (falha fechada)")
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tests").mkdir()
        self._old = mut.TEST
        mut.TEST = "tests/s.test.mjs"

    def tearDown(self):
        mut.TEST = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_body(self, body):
        (self.tmp / "tests" / "s.test.mjs").write_text(SUITE + body, encoding="utf-8")
        return mut.run_suite(str(self.tmp))

    def verdict(self, run, spec, total=2):
        return mc.classify_run(total, run, expected=spec, allowlist=[], anchor_ok=True, mutant_id="m")

    def test_killed_on_primary_marker(self):
        run = self.run_body('test("T01 regra", () => { assert.equal(1, 2, "[T01.1]"); });\ntest("T02 outro", () => {});\n')
        self.assertEqual(self.verdict(run, spec_for())["verdict"], mc.KILLED)

    def test_a_primary_test_failing_on_other_assertion_is_inconclusive(self):
        body = 'test("T01 regra", () => { assert.equal(1, 1, "[T01.1]"); assert.equal(1, 2, "[T01.2]"); });\ntest("T02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for("[T01.1]"))
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)

    def test_a_marker_prefix_collision_is_not_a_match(self):
        body = 'test("T01 regra", () => { assert.equal(1, 2, "[T01.10]"); });\ntest("T02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for("[T01.1]"))["verdict"], mc.INCONCLUSIVE)

    def test_b_todo_is_inconclusive(self):
        body = 'test("T01 regra", { todo: true }, () => { assert.equal(1, 2, "[T01.1]"); });\ntest("T02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for())
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        body2 = 'test("T01 regra", (t) => { t.todo("pendente"); });\ntest("T02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body2), spec_for())["verdict"], mc.INCONCLUSIVE)

    def test_secondary_only_and_unrelated_are_inconclusive(self):
        body = 'test("T01 regra", () => {});\ntest("T02 outro", () => { assert.ok(false, "[T02.1]"); });\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for(secondary=("T02 outro",)))["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE)

    def test_crash_syntax_and_non_assertion_are_inconclusive(self):
        for body in ('import "./nao-existe.mjs";\ntest("T01 regra", () => {});\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { const = 1; });\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { null.x; });\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { process.exit(1); });\ntest("T02 outro", () => {});\n'):
            self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE, body[:40])

    def test_c_point_count_inconsistent_with_plan_or_summary(self):
        run = self.run_body('test("T01 regra", () => { assert.equal(1, 2, "[T01.1]"); });\ntest("T02 outro", () => {});\n')
        self.assertEqual(self.verdict(run, spec_for())["verdict"], mc.KILLED)
        out = run["stdout"]
        # (c1) um ponto TAP removido: plano e resumo dizem 2, só 1 ponto de topo.
        lines = out.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("ok 2 - T02 outro"))
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("1.."))
        cut = "\n".join(lines[:start] + lines[end:])
        self.assertEqual(self.verdict({**run, "stdout": cut}, spec_for())["verdict"], mc.INCONCLUSIVE)
        # (c2) plano adulterado (1..3) com resumo/pontos em 2.
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^1\.\.2$", "1..3", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE)
        # (c3) resumo adulterado (# pass 2) incoerente com os pontos.
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^# pass 1$", "# pass 2", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE)
        # (c4) resumo ausente.
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^# (tests|pass|fail) \d+$\n", "", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE)


class Config(unittest.TestCase):
    def titles(self, rel):
        return [re.match(r'^test\("((?:[^"\\]|\\.)*)"', l).group(1) for l in (ROOT / rel).read_text(encoding="utf-8").split("\n") if l.startswith('test("')]

    def test_shipped_configs_valid_with_markers_on_every_primary(self):
        unit = mut.load_config(ROOT / "scripts" / "ci" / "mutants_support_email_allow.json", self.titles("tests/support-email-forward.test.mjs"), mut.M)
        pg = mut.load_config(ROOT / "scripts" / "ci" / "mutants_support_email_pg_allow.json", self.titles("tests/integration/support-outbox-postgres.test.mjs"), mut.M_PG)
        for cfg in (unit, pg):
            for mid, s in cfg.items():
                for e in s["primary"]:
                    self.assertTrue(re.search(r"\[[UO]\d+\\?\.|U\d+\\\.|O\d+\\\.", e["assertion_pattern"]), (mid, e["assertion_pattern"]))

    def write(self, data):
        tmp = Path(tempfile.mkdtemp())
        f = tmp / "c.json"
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return f

    def base(self):
        return json.loads((ROOT / "scripts" / "ci" / "mutants_support_email_allow.json").read_text(encoding="utf-8"))

    def test_primary_without_marker_rejected(self):
        d = self.base()
        first = sorted(d["mutants"])[0]
        d["mutants"][first]["primary"][0]["assertion_pattern"] = None
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_secondary_without_justification_rejected(self):
        d = self.base()
        mid = next(k for k, v in d["mutants"].items() if v.get("secondary"))
        d["mutants"][mid]["secondary"][0]["justification"] = ""
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_unknown_test_and_missing_mutant_rejected(self):
        d = self.base()
        first = sorted(d["mutants"])[0]
        d["mutants"][first]["primary"][0]["test_pattern"] = "teste que não existe"
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), self.titles("tests/support-email-forward.test.mjs"), mut.M)
        d = self.base()
        d["mutants"].pop(sorted(d["mutants"])[0])
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_runner_refuses_to_start_with_invalid_config(self):
        d = self.base()
        first = sorted(d["mutants"])[0]
        d["mutants"][first]["primary"][0]["assertion_pattern"] = ""
        f = self.write(d)
        env = {**os.environ, "SUPPORT_MUTANTS_ALLOW_FILE": str(f), "PYTHONDONTWRITEBYTECODE": "1"}
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "mutants_support_email.py")], capture_output=True, text=True,
                           encoding="utf-8", env=env, timeout=300, stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, 2, p.stdout[-400:])
        self.assertIn("CONFIG_INVALID", p.stdout)
        self.assertNotIn("MUTANT ", p.stdout)

    def test_causality_doc_lists_every_mutant_and_archives_k3(self):
        doc = (ROOT / "docs" / "evidence" / "support-email-mutant-causality.md").read_text(encoding="utf-8")
        for name in list(mut.M) + list(mut.M_PG):
            self.assertIn(f"| {name.split(' ')[0]} |", doc, name)
        self.assertIn("K3 drain token window widened", doc)
        self.assertIn("K3 drain signature ignores method/path", doc)


if __name__ == "__main__":
    unittest.main()
