"""Meta-testes do runner do Conteúdo Pronto sobre o classificador COMPARTILHADO (scripts/ci/mutant_classifier.py).

Os mesmos casos do antigo classificador local (scripts/ci/mutant_tap.py, removido na migração) agora passam pelo
adaptador do runner (to_expected: mapa causal p/s/broad -> primary/secondary/broad_reason) e por
mutant_classifier.classify_run, provando que a semântica de KILLED/SURVIVED/INCONCLUSIVE foi preservada.
Uso: python3 -B scripts/ci/test_mutants_conteudo_pronto_classifier.py
"""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
import mutant_classifier as mc  # noqa: E402

_spec = importlib.util.spec_from_file_location("mcp_runner", _HERE / "mutants_conteudo_pronto.py")
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


class T:
    KILLED, SURVIVED, INCONCLUSIVE = mc.KILLED, mc.SURVIVED, mc.INCONCLUSIVE

    @staticmethod
    def classify(rc, out, total, primary, secondary=None):
        spec = {"p": primary, "s": secondary or {}, "why": "meta-teste: asserção primária do caso"}
        exp = runner.to_expected(spec)
        r = {"return_code": rc, "stdout": out, "stderr": "", "timed_out": rc is None, "signal": None, "missing_tool": None}
        res = mc.classify_run(total, r, expected=exp, allowlist=exp["allowlist"], anchor_ok=True, mutant_id="MX")
        return res["verdict"], res["reason"]

    @staticmethod
    def validate_spec(mid, spec):
        return runner.spec_problems(mid, spec)


def tap(results, *, tests=None, pass_=None, fail=None, cancelled=0, skipped=0, todo=0, tail=True):
    """Gera TAP no formato do node --test: results = [(ok, nome, erro|None)]."""
    out = ["TAP version 13"]
    for i, (ok, name, err) in enumerate(results, 1):
        out.append(f"# Subtest: {name}")
        out.append(f"{'ok' if ok else 'not ok'} {i} - {name}")
        out.append("  ---")
        out.append("  duration_ms: 1.0")
        if not ok:
            out.append("  failureType: 'testCodeFailure'")
            out.append("  error: |-")
            out.append(f"    {err}")
            out.append("  code: 'ERR_ASSERTION'")
            out.append("  stack: |-")
            out.append("    at file.mjs:1:1")
        out.append("  ...")
    if tail:
        n = len(results)
        f = sum(1 for r in results if not r[0])
        out += [f"1..{n}", f"# tests {n if tests is None else tests}", "# suites 0",
                f"# pass {n - f if pass_ is None else pass_}", f"# fail {f if fail is None else fail}",
                f"# cancelled {cancelled}", f"# skipped {skipped}", f"# todo {todo}", "# duration_ms 10"]
    return "\n".join(out) + "\n"


GREEN = [(True, "(a) contrato", None), (True, "(g1) envio", None), (True, "(g2) dead", None)]


P1 = [("(g1)", "[regen-idem]")]


class Classifier(unittest.TestCase):
    def test_killed_primary_failure(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.KILLED)

    def test_killed_primary_plus_justified_secondary(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem] chave presente"), (False, "(g2) dead", "outra asserção")])
        self.assertEqual(T.classify(1, out, 3, P1, {"(g2)": "o fluxo do dead depende da mesma chave de envio"})[0], T.KILLED)

    def test_failure_only_in_secondary_is_inconclusive(self):
        out = tap([(True, "(a) contrato", None), (True, "(g1) envio", None), (False, "(g2) dead", "[regen-idem] também aqui")])
        verdict, why = T.classify(1, out, 3, P1, {"(g2)": "o fluxo do dead depende da mesma chave de envio"})
        self.assertEqual(verdict, T.INCONCLUSIVE)
        # Shared classifier: the PRIMARY label found only in a SECONDARY block is reported as label_outside_block.
        self.assertRegex(why, r"only_secondary_failures|label_outside_block")

    def test_primary_test_failing_on_other_assertion_is_inconclusive(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "outra asserção do mesmo teste"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)

    def test_survived_all_green(self):
        self.assertEqual(T.classify(0, tap(GREEN), 3, P1)[0], T.SURVIVED)

    def test_unrelated_failure_is_inconclusive(self):
        # Primária falhou, mas outro teste fora de PRIMARY/SECONDARY também falhou.
        out = tap([(False, "(a) contrato", "quebrou outra coisa"), (False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        verdict, why = T.classify(1, out, 3, P1)
        self.assertEqual(verdict, T.INCONCLUSIVE)
        self.assertIn("unexpected_failure", why)
        # Rótulo só numa linha `ok` (nome de teste que passou); a falha é de outro teste.
        out = tap([(True, "(a) contrato [regen-idem]", None), (False, "(g2) dead", "[regen-dead] alerta"), (True, "(g1) envio", None)])
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)

    def test_label_in_test_name_but_not_in_error_is_inconclusive(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio [regen-idem]", "outra asserção"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)

    def test_crash_is_inconclusive(self):
        crash = "file:///x/worker/content-service.mjs:10\n  if (true {\n          ^\nSyntaxError: Unexpected token '{'\n[regen-idem]\n"
        self.assertEqual(T.classify(1, crash, 3, P1)[0], T.INCONCLUSIVE)
        out = tap([(False, "tests/x.test.mjs", "SyntaxError [regen-idem]")], tests=1)
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(134, out, 3, P1)[0], T.INCONCLUSIVE)

    def test_timeout_is_inconclusive(self):
        partial = tap([(False, "(g1) envio", "[regen-idem] chave presente")], tail=False)
        self.assertEqual(T.classify(None, partial, 3, P1)[0], T.INCONCLUSIVE)

    def test_incomplete_count_is_inconclusive(self):
        out = tap([(False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], cancelled=1)
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], tail=False)
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)
        out = tap([(False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], tests=3, pass_=2)
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.INCONCLUSIVE)

    def test_green_with_nonzero_exit_is_inconclusive(self):
        self.assertEqual(T.classify(1, tap(GREEN), 3, P1)[0], T.INCONCLUSIVE)

    def test_multiline_error_block(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "linha 1"), (True, "(g2) dead", None)])
        out = out.replace("    linha 1", "    linha 1\n    [regen-fail] tempo esgotado #1: 202\n  expected: 202\n  actual: 200")
        self.assertEqual(T.classify(1, out, 3, [("(g1)", "[regen-fail] tempo esgotado #1: 202")])[0], T.KILLED)
        out2 = tap([(True, "(a) contrato", None), (False, "(g1) envio", "linha 1"), (True, "(g2) dead", None)])
        out2 = out2.replace("    linha 1", "    linha 1\n  expected: '[regen-fail]'")
        self.assertEqual(T.classify(1, out2, 3, [("(g1)", "[regen-fail]")])[0], T.INCONCLUSIVE)

    def test_real_node_tap_shape(self):
        out = tap(GREEN)
        out = out.replace("ok 2 - (g1) envio\n  ---\n  duration_ms: 1.0\n",
                          "not ok 2 - (g1) envio\n  ---\n  duration_ms: 1.0\n  location: '/x/t.mjs:1:1'\n  failureType: 'testCodeFailure'\n  error: '[regen-idem] chave presente'\n  code: 'ERR_ASSERTION'\n")
        out = out.replace("# pass 3", "# pass 2").replace("# fail 0", "# fail 1")
        self.assertEqual(T.classify(1, out, 3, P1)[0], T.KILLED)


class SpecGuards(unittest.TestCase):
    GOOD = {"p": [("(g1)", "[regen-idem]")], "why": "(g1) exige a chave do candidato em toda chamada"}

    def test_valid_spec(self):
        self.assertEqual(T.validate_spec("MX", self.GOOD), [])

    def test_unjustified_secondary_is_rejected(self):
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "s": {"(g2)": ""}}))
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "s": {"(g2)": "porque sim"}}))

    def test_primary_bounds_and_why(self):
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "p": []}))
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "p": [("(a)", "x"), ("(b)", "y"), ("(c)", "z"), ("(d)", "w")]}))
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "why": ""}))

    def test_more_than_four_tests_needs_broad_reason(self):
        sec = {t: "este teste usa o mesmo trecho mutado no fluxo" for t in ("(a)", "(b)", "(c)", "(d)")}
        self.assertTrue(T.validate_spec("MX", {**self.GOOD, "s": sec}))
        self.assertEqual(T.validate_spec("MX", {**self.GOOD, "s": sec, "broad": "a mutação muda a identidade de toda a máquina de estados"}), [])

    def test_runner_refuses_to_start_with_unjustified_entry(self):
        import io, contextlib
        first = next(iter(runner.CAUSALITY))
        saved = runner.CAUSALITY[first]
        try:
            runner.CAUSALITY[first] = {**saved, "s": {**saved.get("s", {}), "(zz)": ""}}
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = runner.main()
            self.assertEqual(rc, 4)
            self.assertIn("MUTANT RUNNER REFUSED", buf.getvalue())
            self.assertNotIn("MUTANT BASELINE", buf.getvalue())
        finally:
            runner.CAUSALITY[first] = saved
        self.assertEqual(runner.causality_problems(), [], "o mapa causal versionado é válido")


if __name__ == "__main__":
    unittest.main(verbosity=2)
