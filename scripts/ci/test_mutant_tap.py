"""Meta-testes do classificador de mutantes (scripts/ci/mutant_tap.py; auditoria Sol #898).
Uso: python3 -B -m unittest scripts/ci/test_mutant_tap.py  (ou: python3 -B scripts/ci/test_mutant_tap.py)
"""
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_tap as T  # noqa: E402


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


class Classifier(unittest.TestCase):
    def test_killed_label_inside_allowlisted_not_ok(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.KILLED)

    def test_survived_all_green(self):
        self.assertEqual(T.classify(0, tap(GREEN), "[x]", 3, {"(g1)"})[0], T.SURVIVED)

    def test_unrelated_failure_with_label_on_ok_line_is_inconclusive(self):
        # Rótulo aparece só no nome de um teste que passou; quem falhou foi outro teste, sem o rótulo.
        out = tap([(True, "(a) contrato [regen-idem]", None), (False, "(g2) dead", "[regen-dead] alerta"), (True, "(g1) envio", None)])
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)", "(g2)"})[0], T.INCONCLUSIVE)

    def test_unrelated_failure_outside_allowlist_is_inconclusive(self):
        out = tap([(False, "(a) contrato", "quebrou outra coisa"), (False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        verdict, why = T.classify(1, out, "[regen-idem]", 3, {"(g1)"})
        self.assertEqual(verdict, T.INCONCLUSIVE)
        self.assertIn("allowlist", why)

    def test_label_in_test_name_but_not_in_error_is_inconclusive(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio [regen-idem]", "outra asserção"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_crash_is_inconclusive(self):
        crash = "file:///x/worker/content-service.mjs:10\n  if (true {\n          ^\nSyntaxError: Unexpected token '{'\n[regen-idem]\n"
        self.assertEqual(T.classify(1, crash, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)
        # Queda com resumo do runner (arquivo não carregou: um único "not ok" com o nome do arquivo).
        out = tap([(False, "tests/x.test.mjs", "SyntaxError [regen-idem]")], tests=1)
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)
        # Sinal/abort: rc diferente de 0/1.
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(134, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_timeout_is_inconclusive(self):
        partial = tap([(False, "(g1) envio", "[regen-idem] chave presente")], tail=False)
        self.assertEqual(T.classify(None, partial, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_incomplete_count_is_inconclusive(self):
        # Resumo com menos testes que a baseline (um arquivo não rodou).
        out = tap([(False, "(g1) envio", "[regen-idem] chave presente"), (True, "(g2) dead", None)])
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)
        # Contagem certa no resumo, mas cancelado/pulado.
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], cancelled=1)
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)
        # Resumo ausente.
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], tail=False)
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)
        # Resumo diz 3, mas só 2 resultados de topo.
        out = tap([(False, "(g1) envio", "[regen-idem]"), (True, "(g2) dead", None)], tests=3, pass_=2)
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_green_with_nonzero_exit_is_inconclusive(self):
        self.assertEqual(T.classify(1, tap(GREEN), "[x]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_multiline_error_block(self):
        out = tap([(True, "(a) contrato", None), (False, "(g1) envio", "linha 1"), (True, "(g2) dead", None)])
        out = out.replace("    linha 1", "    linha 1\n    [regen-fail] tempo esgotado #1: 202\n  expected: 202\n  actual: 200")
        self.assertEqual(T.classify(1, out, "[regen-fail] tempo esgotado #1: 202", 3, {"(g1)"})[0], T.KILLED)
        # O mesmo texto em `expected:`/`actual:` (fora de `error`) não conta.
        out2 = tap([(True, "(a) contrato", None), (False, "(g1) envio", "linha 1"), (True, "(g2) dead", None)])
        out2 = out2.replace("    linha 1", "    linha 1\n  expected: '[regen-fail]'")
        self.assertEqual(T.classify(1, out2, "[regen-fail]", 3, {"(g1)"})[0], T.INCONCLUSIVE)

    def test_real_node_tap_shape(self):
        # Trecho real do node 22 (--test-reporter=tap) com erro em linha única entre aspas.
        out = tap(GREEN)
        out = out.replace("ok 2 - (g1) envio\n  ---\n  duration_ms: 1.0\n",
                          "not ok 2 - (g1) envio\n  ---\n  duration_ms: 1.0\n  location: '/x/t.mjs:1:1'\n  failureType: 'testCodeFailure'\n  error: '[regen-idem] chave presente'\n  code: 'ERR_ASSERTION'\n")
        out = out.replace("# pass 3", "# pass 2").replace("# fail 0", "# fail 1")
        self.assertEqual(T.classify(1, out, "[regen-idem]", 3, {"(g1)"})[0], T.KILLED)


if __name__ == "__main__":
    unittest.main(verbosity=2)
