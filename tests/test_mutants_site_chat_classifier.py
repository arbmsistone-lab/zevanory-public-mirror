"""Contraprovas do runner de mutantes do chat do site (scripts/ci/mutants_site_chat.py) sobre o classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (#901). Exigidas pelo auditor Sol (#897), todas => INCONCLUSIVE:
  (a) teste primário falhando em OUTRA asserção (marcador diferente, inclusive prefixo [SC01.10] x [SC01.1])
  (b) todo (opção todo e t.todo)
  (c) TAP incoerente: ponto removido, plano adulterado, resumo adulterado ou ausente
  (d) falha só em teste secundário
e ainda: falha fora da lista, TypeError/módulo ausente/process.exit => INCONCLUSIVE; asserção primária casada => KILLED.
A config é validada antes de rodar (sem justificativa, primária sem marcador, teste ou marcador inexistente, mutante sem
config, allowlist causal => recusa, exit 2). Parte REAL (node roda suítes mínimas com marcadores [SCnn.k]) e parte com
TAP real adulterado. Sem rede, sem segredo.
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
spec = importlib.util.spec_from_file_location("mut_site_chat", ROOT / "scripts" / "ci" / "mutants_site_chat.py")
mut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mut)
mc = mut.mc
CONFIG = ROOT / "scripts" / "ci" / "mutants_site_chat_allow.json"

HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\n'


def spec_for(primary_label="[SC01.1]", secondary=()):
    return mc.load_mutant_config({"m": {
        "primary": [{"test_pattern": "SC01", "assertion_pattern": primary_label}],
        "secondary": [{"test_pattern": t, "assertion_pattern": None, "justification": "pré-condição"} for t in secondary]}})["m"]


class RealNode(unittest.TestCase):
    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente: contraprova não pode rodar (falha fechada)")
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tests").mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_body(self, body):
        (self.tmp / "tests" / "s.test.mjs").write_text(HEAD + body, encoding="utf-8")
        return mut.run_suite(self.tmp, suites=["tests/s.test.mjs"])

    def verdict(self, run, spec, total=2):
        return mc.classify_run(total, run, expected=spec, allowlist=[], anchor_ok=True, mutant_id="m")

    def test_killed_only_on_primary_marker(self):
        run = self.run_body('test("SC01 regra", () => { assert.equal(1, 2, "[SC01.1] regra"); });\ntest("SC02 outro", () => {});\n')
        r = self.verdict(run, spec_for())
        self.assertEqual(r["verdict"], mc.KILLED, r)
        self.assertEqual(r["killing_tests"], ["SC01 regra"])

    def test_a_primary_test_failing_on_other_assertion_is_inconclusive(self):
        body = 'test("SC01 regra", () => { assert.equal(1, 1, "[SC01.1]"); assert.equal(1, 2, "[SC01.2]"); });\ntest("SC02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for("[SC01.1]"))
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        # assert sem marcador nenhum no teste primário também não mata
        body = 'test("SC01 regra", () => { assert.equal(1, 2); });\ntest("SC02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for("[SC01.1]"))["verdict"], mc.INCONCLUSIVE)

    def test_a_marker_prefix_collision_is_not_a_match(self):
        body = 'test("SC01 regra", () => { assert.equal(1, 2, "[SC01.10]"); });\ntest("SC02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for("[SC01.1]"))["verdict"], mc.INCONCLUSIVE)
        # e o id do teste também casa por fronteira: "SC01" não casa "SC010 ..."
        body = 'test("SC010 regra", () => { assert.equal(1, 2, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for("[SC01.1]"))["verdict"], mc.INCONCLUSIVE)

    def test_b_todo_is_inconclusive(self):
        body = 'test("SC01 regra", { todo: true }, () => { assert.equal(1, 2, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for())
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        body2 = 'test("SC01 regra", (t) => { t.todo("pendente"); assert.equal(1, 2, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body2), spec_for())["verdict"], mc.INCONCLUSIVE)
        body3 = 'test("SC01 regra", { skip: true }, () => { assert.equal(1, 2, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body3), spec_for())["verdict"], mc.INCONCLUSIVE)

    def test_c_inconsistent_tap_is_inconclusive(self):
        run = self.run_body('test("SC01 regra", () => { assert.equal(1, 2, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n')
        self.assertEqual(self.verdict(run, spec_for())["verdict"], mc.KILLED)
        out = run["stdout"]
        lines = out.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("ok 2 - SC02 outro"))
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("1.."))
        self.assertEqual(self.verdict({**run, "stdout": "\n".join(lines[:start] + lines[end:])}, spec_for())["verdict"], mc.INCONCLUSIVE, "ponto removido")
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^1\.\.2$", "1..3", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE, "plano")
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^# pass 1$", "# pass 2", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE, "resumo")
        self.assertEqual(self.verdict({**run, "stdout": re.sub(r"^# (tests|pass|fail) \d+$\n", "", out, flags=re.M)}, spec_for())["verdict"], mc.INCONCLUSIVE, "resumo ausente")
        self.assertEqual(self.verdict({**run, "stdout": out[: len(out) // 2]}, spec_for())["verdict"], mc.INCONCLUSIVE, "truncado")
        self.assertEqual(self.verdict({**run, "return_code": 0}, spec_for())["verdict"], mc.INCONCLUSIVE, "rc incoerente")
        self.assertEqual(self.verdict(run, spec_for(), total=3)["verdict"], mc.INCONCLUSIVE, "contagem diferente da baseline")

    def test_d_secondary_only_and_unrelated_are_inconclusive(self):
        body = 'test("SC01 regra", () => {});\ntest("SC02 outro", () => { assert.ok(false, "[SC02.1]"); });\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for(secondary=("SC02",)))["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE)
        # primário + falha fora de primary ∪ secondary também não mata
        body = 'test("SC01 regra", () => { assert.ok(false, "[SC01.1]"); });\ntest("SC02 outro", () => { assert.ok(false, "[SC02.1]"); });\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(self.verdict(self.run_body(body), spec_for(secondary=("SC02",)))["verdict"], mc.KILLED)

    def test_crash_type_error_and_exit_are_inconclusive(self):
        for body in ('import "./nao-existe.mjs";\ntest("SC01 regra", () => {});\ntest("SC02 outro", () => {});\n',
                     'test("SC01 regra", () => { const = 1; });\ntest("SC02 outro", () => {});\n',
                     'test("SC01 regra", () => { null.x; assert.ok(false, "[SC01.1]"); });\ntest("SC02 outro", () => {});\n',
                     'test("SC01 regra", () => { process.exit(1); });\ntest("SC02 outro", () => {});\n'):
            self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE, body[:40])

    def test_anchor_not_unique_is_inconclusive(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            old_repo = mut.REPO
            mut.REPO = ROOT
            ok = mut.build(str(tmp), ("worker/site-chat.mjs", "const ", "let "))
            self.assertFalse(ok, "âncora repetida precisa ser recusada")
        finally:
            mut.REPO = old_repo
            shutil.rmtree(tmp, ignore_errors=True)
        r = mc.classify_run(2, {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None},
                            expected=spec_for(), allowlist=[], anchor_ok=False, mutant_id="m")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE)


class Config(unittest.TestCase):
    def titles(self):
        out = []
        for rel in mut.SUITES:
            out += [re.match(r'^test\("((?:[^"\\]|\\.)*)"', l).group(1) for l in (ROOT / rel).read_text(encoding="utf-8").split("\n") if l.startswith('test("')]
        return out

    def base(self):
        return json.loads(CONFIG.read_text(encoding="utf-8"))

    def write(self, data):
        tmp = Path(tempfile.mkdtemp())
        f = tmp / "c.json"
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return f

    def test_baseline_total_matches_suite(self):
        self.assertEqual(len(self.titles()), mut.BASELINE_TOTAL)

    def test_shipped_config_valid_markers_exist_and_no_allowlist(self):
        cfg = mut.load_config(CONFIG, self.titles(), mut.M, mut.test_sources())
        self.assertEqual(set(cfg), set(mut.M))
        for mid, s in cfg.items():
            self.assertEqual(s["allowlist"], [], mid)
            self.assertTrue(1 <= len(s["primary"]) <= 3, mid)
            for e in s["primary"]:
                self.assertRegex(e["assertion_pattern"], r"^\[S[CWGE]\d{2}\.\d+\]$", mid)
                self.assertTrue(e["assertion_pattern"].startswith("[" + e["test_pattern"] + "."), (mid, "marcador de outro teste"))
            for e in s["secondary"]:
                self.assertTrue(e["justification"].strip(), mid)

    def test_primary_without_marker_rejected(self):
        d = self.base()
        first = next(iter(d["mutants"]))
        d["mutants"][first]["primary"][0]["assertion_pattern"] = None
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_secondary_without_justification_rejected(self):
        d = self.base()
        mid = next(k for k, v in d["mutants"].items() if v.get("secondary"))
        d["mutants"][mid]["secondary"][0]["justification"] = " "
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_broad_without_reason_and_too_many_primaries_rejected(self):
        d = self.base()
        mid = next(k for k, v in d["mutants"].items() if v.get("broad_reason"))
        d["mutants"][mid].pop("broad_reason")
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)
        d = self.base()
        first = next(iter(d["mutants"]))
        d["mutants"][first]["primary"] = [{"test_pattern": f"SC0{i}", "assertion_pattern": f"[SC0{i}.1]"} for i in range(1, 5)]
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_unknown_test_unknown_marker_missing_mutant_and_allowlist_rejected(self):
        d = self.base()
        first = next(iter(d["mutants"]))
        d["mutants"][first]["primary"][0]["test_pattern"] = "SC99"
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), self.titles(), mut.M)
        d = self.base()
        d["mutants"][first]["primary"][0]["assertion_pattern"] = "[SC01.99]"
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M, mut.test_sources())
        d = self.base()
        d["mutants"].pop(first)
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)
        d = self.base()
        d["mutants"][first]["allowlist"] = [{"id": "x", "test_pattern": "SC01", "regex": ".", "why": "qualquer coisa"}]
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d), None, mut.M)

    def test_runner_refuses_to_start_with_invalid_config(self):
        d = self.base()
        first = next(iter(d["mutants"]))
        d["mutants"][first]["primary"][0]["assertion_pattern"] = ""
        f = self.write(d)
        env = {**os.environ, "SITE_CHAT_MUTANTS_ALLOW_FILE": str(f), "PYTHONDONTWRITEBYTECODE": "1"}
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "mutants_site_chat.py")], capture_output=True, text=True,
                           encoding="utf-8", env=env, timeout=300, stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, 2, p.stdout[-400:])
        self.assertIn("CONFIG_INVALID", p.stdout)
        self.assertNotIn("MUTANT ", p.stdout)

    def test_causality_doc_in_sync_with_config(self):
        doc = (ROOT / "docs" / "evidence" / "site-chat-mutant-causality.md").read_text(encoding="utf-8")
        self.assertIn(mut.doc_table(CONFIG), doc, "rode: python3 scripts/ci/mutants_site_chat.py --doc")
        for name in mut.M:
            self.assertIn(f"| {name.split(' ')[0]} |", doc, name)


if __name__ == "__main__":
    unittest.main()
