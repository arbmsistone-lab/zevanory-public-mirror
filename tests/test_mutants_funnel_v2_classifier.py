"""Contraprovas do runner de mutantes do Funil v2 (scripts/ci/mutants_funnel_v2.py) sobre o classificador
COMPARTILHADO scripts/ci/mutant_classifier.py (#901). Exigidas pelo auditor Sol para #893:
  (a) teste primário falhando em OUTRA asserção (marcador diferente)               => INCONCLUSIVE
  (b) todo (opção { todo: true } e t.todo())                                      => INCONCLUSIVE
  (c) TAP inconsistente: ponto removido, plano adulterado, resumo adulterado/ausente => INCONCLUSIVE
  (d) falha só em secundária                                                      => INCONCLUSIVE
e ainda: falha não relacionada, queda/sintaxe/TypeError/process.exit, timeout, TAP truncado => INCONCLUSIVE;
asserção primária casada => KILLED; resumo do Node 24 no formato spec ("ℹ skipped 0") lido igual a "# skipped 0".
Partes REAIS: Node roda suítes mínimas com marcadores; e o mutante Z9 roda contra a suíte verdadeira com a primária
certa ([FU16.3] => KILLED) e com a escolha ingênua ([FU16.4] => INCONCLUSIVE). Config validada antes de rodar.
Sem rede, sem segredo, sem PostgreSQL.
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
_spec = importlib.util.spec_from_file_location("mut_funnel_v2", ROOT / "scripts" / "ci" / "mutants_funnel_v2.py")
mut = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mut)
mut.REPO = ROOT
mc = mut.mc
CONFIG = ROOT / "scripts" / "ci" / "mutants_funnel_v2_config.json"
UNIT_TEST = ROOT / "tests" / "funnel-counting.test.mjs"
PG_TEST = ROOT / "tests" / "integration" / "funnel-own-sales-postgres.test.mjs"

HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\n'


def spec_for(primary="[T01.1]", secondary=()):
    return mc.load_mutant_config({"m": {
        "primary": [{"test_pattern": "T01 regra", "assertion_pattern": primary}],
        "secondary": [{"test_pattern": t, "assertion_pattern": a, "justification": "pré-condição da contraprova"} for t, a in secondary]}})["m"]


class RealNode(unittest.TestCase):
    """Suítes mínimas executadas pelo mesmo run_suite do runner (node --test, reporter TAP forçado)."""

    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente: contraprova não pode rodar (falha fechada)")
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tests").mkdir()
        self._old = dict(mut.SUITES["unit"])
        mut.SUITES["unit"]["test"] = "tests/s.test.mjs"

    def tearDown(self):
        mut.SUITES["unit"].clear()
        mut.SUITES["unit"].update(self._old)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_body(self, body):
        (self.tmp / "tests" / "s.test.mjs").write_text(HEAD + body, encoding="utf-8")
        return mut.run_suite(self.tmp, "unit")

    def verdict(self, run, spec, total=2):
        return mc.classify_run(total, run, expected=spec, allowlist=[], anchor_ok=True, mutant_id="m")

    KILL = 'test("T01 regra", () => { assert.equal(1, 2, "[T01.1] regra"); });\ntest("T02 outro", () => {});\n'

    def test_killed_on_primary_marker(self):
        r = self.verdict(self.run_body(self.KILL), spec_for())
        self.assertEqual(r["verdict"], mc.KILLED, r)
        self.assertEqual(r["assertion_ids"], ["[T01.1]"])

    def test_a_primary_test_failing_on_other_assertion_is_inconclusive(self):
        body = 'test("T01 regra", () => { assert.equal(1, 1, "[T01.1]"); assert.equal(1, 2, "[T01.2]"); });\ntest("T02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for("[T01.1]"))
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("unexpected_failure", r["reason"])

    def test_a_marker_prefix_collision_is_not_a_match(self):
        body = 'test("T01 regra", () => { assert.equal(1, 2, "[T01.10]"); });\ntest("T02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body), spec_for("[T01.1]"))["verdict"], mc.INCONCLUSIVE)

    def test_b_todo_is_inconclusive(self):
        body = 'test("T01 regra", { todo: true }, () => { assert.equal(1, 2, "[T01.1]"); });\ntest("T02 outro", () => {});\n'
        r = self.verdict(self.run_body(body), spec_for())
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        body2 = 'test("T01 regra", (t) => { t.todo("pendente"); assert.equal(1, 2, "[T01.1]"); });\ntest("T02 outro", () => {});\n'
        self.assertEqual(self.verdict(self.run_body(body2), spec_for())["verdict"], mc.INCONCLUSIVE)

    def test_c_inconsistent_tap_is_inconclusive(self):
        run = self.run_body(self.KILL)
        self.assertEqual(self.verdict(run, spec_for())["verdict"], mc.KILLED)
        out = run["stdout"]
        lines = out.split("\n")
        start = next(i for i, l in enumerate(lines) if l.startswith("ok 2 - T02 outro"))
        end = next(i for i in range(start + 1, len(lines)) if lines[i].startswith("1.."))
        cases = {
            "ponto removido": "\n".join(lines[:start] + lines[end:]),
            "plano adulterado": re.sub(r"^1\.\.2$", "1..3", out, flags=re.M),
            "resumo adulterado": re.sub(r"^# pass 1$", "# pass 2", out, flags=re.M),
            "resumo ausente": re.sub(r"^# (tests|pass|fail) \d+\n", "", out, flags=re.M),
            "truncado": out[: len(out) // 2],
        }
        for label, text in cases.items():
            self.assertEqual(self.verdict({**run, "stdout": text}, spec_for())["verdict"], mc.INCONCLUSIVE, label)

    def test_d_secondary_only_and_unrelated_are_inconclusive(self):
        body = 'test("T01 regra", () => {});\ntest("T02 outro", () => { assert.ok(false, "[T02.1]"); });\n'
        r = self.verdict(self.run_body(body), spec_for(secondary=[("T02 outro", "[T02.1]")]))
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("only_secondary_failures", r["reason"])
        r = self.verdict(self.run_body(body), spec_for())
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)

    def test_crash_syntax_type_error_exit_timeout_are_inconclusive(self):
        for body in ('import "./nao-existe.mjs";\ntest("T01 regra", () => {});\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { const = 1; });\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { null.x; });\ntest("T02 outro", () => {});\n',
                     'test("T01 regra", () => { process.exit(1); });\ntest("T02 outro", () => {});\n'):
            self.assertEqual(self.verdict(self.run_body(body), spec_for())["verdict"], mc.INCONCLUSIVE, body[:40])
        run = self.run_body(self.KILL)
        self.assertEqual(self.verdict({**run, "timed_out": True, "return_code": None}, spec_for())["verdict"], mc.INCONCLUSIVE)

    def test_node24_spec_summary_is_parsed(self):
        """Windows/Node 24: the summary may come as 'ℹ skipped 0' (spec reporter) instead of '# skipped 0'."""
        run = self.run_body(self.KILL)
        spec_style = re.sub(r"^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ", "ℹ \\1 ", run["stdout"], flags=re.M)
        self.assertIn("ℹ skipped 0", spec_style)
        a = mc.parse_tap(run["stdout"])["summary"]
        b = mc.parse_tap(spec_style)["summary"]
        for k in mc.COUNT_KEYS:
            self.assertEqual(a[k], b[k], k)
        self.assertEqual(b["skipped"], 0)
        self.assertEqual(self.verdict({**run, "stdout": spec_style}, spec_for())["verdict"], mc.KILLED)
        crlf = run["stdout"].replace("\n", "\r\n")
        self.assertEqual(self.verdict({**run, "stdout": crlf}, spec_for())["verdict"], mc.KILLED)


class RealSuite(unittest.TestCase):
    """The real unit suite with the real Z9 mutation: the reasoned primary kills, the naive one does not."""

    def setUp(self):
        self.assertTrue(shutil.which("node"), "node ausente (falha fechada)")
        self.cfg = mut.load_config()["unit"]

    def test_z9_reasoned_primary_kills_and_naive_primary_is_inconclusive(self):
        name = "Z9 link de contato no código novo"
        good = mut.run_mutant("unit", name, mut.M_UNIT[name], self.cfg[name], "unused")
        self.assertEqual(good["verdict"], mc.KILLED, good)
        self.assertEqual(good["assertion_ids"], ["[FU16.3]"])
        naive = mc.load_mutant_config({"z": {"primary": [{"test_pattern": "métricas antigas só-Hotmart removidas", "assertion_pattern": "[FU16.4]"}]}})["z"]
        bad = mut.run_mutant("unit", name, mut.M_UNIT[name], naive, "unused")
        self.assertEqual(bad["verdict"], mc.INCONCLUSIVE, bad)

    def test_f5_failing_only_in_secondaries_is_inconclusive(self):
        name = "F5 intenção contada em dias fechados"
        spec = mc.load_mutant_config({"f": {
            "primary": [{"test_pattern": "Worker de vendas: página de produto", "assertion_pattern": "[FU12.1]"}],
            "secondary": [{"test_pattern": "intenção transacional só com vendas abertas", "assertion_pattern": "[FU07.1]", "justification": "contraprova"},
                          {"test_pattern": "snapshot: Vendas (30d)", "assertion_pattern": "[FU14.6]", "justification": "contraprova"}]}})["f"]
        r = mut.run_mutant("unit", name, mut.M_UNIT[name], spec, "unused")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE, r)
        self.assertIn("only_secondary_failures", r["reason"])

    def test_missing_anchor_is_inconclusive(self):
        r = mut.run_mutant("unit", "x", (mut.FC, "âncora que não existe", ""), self.cfg["F1 rótulo Hotmart no ledger próprio é contado"], "unused")
        self.assertEqual(r["verdict"], mc.INCONCLUSIVE)
        self.assertEqual(r["reason"], "anchor_not_unique")


def unit_titles():
    run = mc.run_command([mut.NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", "tests/funnel-counting.test.mjs"], cwd=str(ROOT), timeout=300)
    return [p["test_id"] for p in mc.parse_tap(run["stdout"])["summary"]["points"]]


def pg_titles():
    return re.findall(r'^test\("((?:[^"\\]|\\.)*)"', PG_TEST.read_text(encoding="utf-8"), re.M)


class Config(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.titles = {"unit": unit_titles(), "pg": pg_titles()}

    def base(self):
        return json.loads(CONFIG.read_text(encoding="utf-8"))

    def write(self, data):
        f = Path(tempfile.mkdtemp()) / "c.json"
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return f

    def test_titles_are_the_pinned_totals(self):
        self.assertEqual(len(self.titles["unit"]), mut.SUITES["unit"]["total"])
        self.assertEqual(len(self.titles["pg"]), mut.SUITES["pg"]["total"])

    def test_shipped_config_valid_and_every_primary_marker_is_in_its_test(self):
        cfg = mut.load_config(CONFIG, self.titles)
        src = {"unit": UNIT_TEST.read_text(encoding="utf-8"), "pg": PG_TEST.read_text(encoding="utf-8")}
        rx = {"unit": r"^\[FU\d{2}\.\d+\]$", "pg": r"^\[FP\d\.\d+\]$"}
        for suite, mutants in cfg.items():
            self.assertEqual(set(mutants), set(mut.MUTANTS[suite]))
            for mid, s in mutants.items():
                self.assertTrue(1 <= len(s["primary"]) <= 3, mid)
                for e in s["primary"] + s["secondary"]:
                    if e["role"] == "primary" or e.get("assertion_pattern"):
                        self.assertRegex(e["assertion_pattern"], rx[suite], mid)
                        self.assertIn(e["assertion_pattern"], src[suite], mid)

    def test_primary_without_marker_rejected(self):
        d = self.base()
        first = sorted(d["unit"]["mutants"])[0]
        d["unit"]["mutants"][first]["primary"][0]["assertion_pattern"] = None
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))

    def test_secondary_without_justification_rejected(self):
        d = self.base()
        d["unit"]["mutants"]["F5 intenção contada em dias fechados"]["secondary"][0]["justification"] = " "
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))

    def test_more_than_four_tests_without_broad_reason_rejected(self):
        d = self.base()
        d["unit"]["mutants"]["K5 zero parcial publicado como zero"].pop("broad_reason")
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))

    def test_four_primaries_rejected(self):
        d = self.base()
        k6 = d["unit"]["mutants"]["K6 marcadores não exigidos para completo"]
        k6["primary"].append(dict(k6["secondary"][0]))
        k6["primary"][-1].pop("justification")
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))

    def test_unknown_or_ambiguous_test_rejected(self):
        for pattern in ("teste que não existe", "vendas: marcador"):
            d = self.base()
            d["unit"]["mutants"]["F1 rótulo Hotmart no ledger próprio é contado"]["primary"][0]["test_pattern"] = pattern
            with self.assertRaises(mc.ConfigError, msg=pattern):
                mut.load_config(self.write(d), self.titles)

    def test_missing_mutant_orphan_config_and_missing_change_rejected(self):
        d = self.base()
        d["pg"]["mutants"].pop("S1 failover na mesma sessão conta 2")
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))
        d = self.base()
        d["unit"]["mutants"]["Z99 inventado"] = d["unit"]["mutants"]["F1 rótulo Hotmart no ledger próprio é contado"]
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))
        d = self.base()
        d["unit"]["changes"].pop("F2 checkout próprio ausente vira zero")
        with self.assertRaises(mc.ConfigError):
            mut.load_config(self.write(d))

    def test_runner_refuses_to_start_with_invalid_config(self):
        d = self.base()
        d["unit"]["mutants"]["F1 rótulo Hotmart no ledger próprio é contado"]["primary"][0]["assertion_pattern"] = ""
        env = {**os.environ, "FUNNEL_MUTANTS_CONFIG": str(self.write(d)), "PYTHONDONTWRITEBYTECODE": "1", "FUNNEL_MUTANTS_UNIT_ONLY": "1"}
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "mutants_funnel_v2.py")], capture_output=True, text=True,
                           encoding="utf-8", env=env, timeout=300, stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, mc.EXIT_BAD_BASELINE, p.stdout[-400:])
        self.assertIn("CONFIG_INVALID", p.stdout)
        self.assertNotIn("BASELINE", p.stdout)
        self.assertNotIn("MUTANT ", p.stdout)

    def test_pg_suite_without_postgres_refuses(self):
        env = {k: v for k, v in os.environ.items() if k not in ("T4_PG_HOST", "FUNNEL_MUTANTS_UNIT_ONLY")}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        p = subprocess.run([sys.executable, str(ROOT / "scripts" / "ci" / "mutants_funnel_v2.py"), "--suite", "pg"], capture_output=True,
                           text=True, encoding="utf-8", env=env, timeout=120, stdin=subprocess.DEVNULL)
        self.assertEqual(p.returncode, mc.EXIT_BAD_BASELINE, p.stdout[-400:])
        self.assertNotIn("MUTANT ", p.stdout)

    def test_causality_doc_matches_config(self):
        raw = self.base()
        doc = (ROOT / mut.DOC_FILE).read_text(encoding="utf-8").replace("\r\n", "\n")
        self.assertEqual(doc, mut.render_doc(raw), "regenerar com: python3 scripts/ci/mutants_funnel_v2.py --write-doc")
        for suite in ("unit", "pg"):
            for mid in raw[suite]["mutants"]:
                self.assertIn(f"| {mid.split(' ')[0]} |", doc, mid)
        self.assertIn("| mutant | change | primary | justification | counter-proof |", doc)

    def test_no_contact_link_in_runner_config_or_doc(self):
        banned = re.compile(r"wa\.me|5588992545413|558892545413", re.I)
        for f in (CONFIG, ROOT / "scripts" / "ci" / "mutants_funnel_v2.py", ROOT / mut.DOC_FILE):
            self.assertIsNone(banned.search(f.read_text(encoding="utf-8")), f.name)


if __name__ == "__main__":
    unittest.main()
