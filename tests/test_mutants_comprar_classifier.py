"""Meta-testes do classificador de scripts/ci/mutants_comprar_noindex.py (AVAL Sol 125).

KILLED só com TAP completo, total = baseline, falha de asserção com o rótulo esperado DENTRO do bloco "not ok" e
toda outra falha também esperada; SURVIVED só com rc 0 e contagem limpa; todo o resto INCONCLUSIVE (timeout, sinal,
crash, módulo ausente, TAP truncado, contagem divergente, falha extra, rótulo fora do bloco, skip/todo/cancelled,
prefixos que colidem como [T1] x [T10]). Saída TAP sintética no formato real do node:test (reporter tap).
"""
import importlib.util
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mutants_comprar_noindex", ROOT / "scripts/ci/mutants_comprar_noindex.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
classify = MOD.classify
TOTAL = "8"


def ok_block(i, name="passa"):
    return f"# Subtest: {name}\nok {i} - {name}\n  ---\n  duration_ms: 1.0\n  type: 'test'\n  ...\n"


def assert_block(i, label, name="falha"):
    return (f"# Subtest: {name}\nnot ok {i} - {name}\n  ---\n  duration_ms: 1.0\n  type: 'test'\n"
            f"  failureType: 'testCodeFailure'\n  error: |-\n    rota /comprar/x {label}\n    \n    1 !== 2\n    \n"
            f"  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  stack: |-\n    TestContext.<anonymous> (file:///t.mjs:1:1)\n  ...\n")


def error_block(i, name="erro", err="TypeError", msg="boom"):
    return (f"# Subtest: {name}\nnot ok {i} - {name}\n  ---\n  duration_ms: 1.0\n  type: 'test'\n"
            f"  failureType: 'testCodeFailure'\n  error: '{msg}'\n  code: 'ERR_TEST_FAILURE'\n  name: '{err}'\n  ...\n")


def tap(blocks, tests=8, fail=None, skipped=0, todo=0, cancelled=0, plan=True, summary=True, extra=""):
    fail = sum(1 for b in blocks if "\nnot ok " in "\n" + b) if fail is None else fail
    body = "TAP version 13\n" + "".join(blocks) + extra
    if plan:
        body += f"1..{tests}\n"
    if summary:
        body += (f"# tests {tests}\n# suites 0\n# pass {tests - fail}\n# fail {fail}\n# cancelled {cancelled}\n"
                 f"# skipped {skipped}\n# todo {todo}\n# duration_ms 10\n")
    return body


def run(blocks, n=8):
    return [b for b in blocks] + [ok_block(i) for i in range(len(blocks) + 1, n + 1)]


class ComprarClassifierTest(unittest.TestCase):
    def verdict(self, rc, out, expect="[x-robots-tag]", total=TOTAL):
        return classify(rc, out, expect, total)[0]

    def test_killed_requires_label_inside_assertion_block(self):
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[x-robots-tag]")]))), "KILLED")

    def test_survived_requires_rc0_and_clean_baseline_count(self):
        self.assertEqual(self.verdict(0, tap(run([]))), "SURVIVED")
        self.assertEqual(self.verdict(0, tap(run([]), tests=7)), "INCONCLUSIVE")

    def test_timeout_and_signal_are_inconclusive(self):
        out = tap(run([assert_block(1, "[x-robots-tag]")]))
        self.assertEqual(self.verdict(-9, out), "INCONCLUSIVE")
        self.assertEqual(self.verdict(None, out), "INCONCLUSIVE")

    def test_crash_syntax_error_and_missing_module_are_inconclusive(self):
        syntax = "file:///w.mjs:3\n  const = 1;\n        ^\nSyntaxError: Unexpected token '='\n" + tap(run([error_block(1, "t.mjs", "SyntaxError")]))
        self.assertEqual(self.verdict(1, syntax), "INCONCLUSIVE")
        module = tap(run([error_block(1, "t.mjs", "Error", "Cannot find module '/w.mjs' ERR_MODULE_NOT_FOUND")]))
        self.assertEqual(self.verdict(1, module), "INCONCLUSIVE")
        # Crash registrado fora de bloco mesmo com uma asserção esperada presente.
        mixed = tap(run([assert_block(1, "[x-robots-tag]")]), extra="# TypeError: Cannot read properties of undefined\n")
        self.assertEqual(self.verdict(1, mixed), "INCONCLUSIVE")

    def test_type_error_failure_without_assertion_is_inconclusive(self):
        self.assertEqual(self.verdict(1, tap(run([error_block(1)]))), "INCONCLUSIVE")

    def test_truncated_tap_is_inconclusive(self):
        out = tap(run([assert_block(1, "[x-robots-tag]")]))
        self.assertEqual(self.verdict(1, out[: out.index("1..8")]), "INCONCLUSIVE")
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[x-robots-tag]")]), summary=False)), "INCONCLUSIVE")
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[x-robots-tag]")]), plan=False)), "INCONCLUSIVE")

    def test_count_mismatch_with_baseline_is_inconclusive(self):
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[x-robots-tag]")], n=7), tests=7)), "INCONCLUSIVE")

    def test_unexpected_extra_failure_is_inconclusive(self):
        out = tap(run([assert_block(1, "[x-robots-tag]"), assert_block(2, "[sitemap:sitemap.xml]")]))
        self.assertEqual(self.verdict(1, out), "INCONCLUSIVE")
        self.assertEqual(self.verdict(1, out, expect=("[x-robots-tag]", "[sitemap:sitemap.xml]")), "KILLED")

    def test_label_only_outside_the_block_is_inconclusive(self):
        out = tap(run([assert_block(1, "[meta]")]), extra="# console: [x-robots-tag]\n")
        self.assertEqual(self.verdict(1, out), "INCONCLUSIVE")

    def test_unexpected_skip_todo_cancelled_is_inconclusive(self):
        blocks = run([assert_block(1, "[x-robots-tag]")])
        for kw in ({"skipped": 1}, {"todo": 1}, {"cancelled": 1}):
            self.assertEqual(self.verdict(1, tap(blocks, **kw)), "INCONCLUSIVE", kw)

    def test_colliding_prefixes_do_not_match(self):
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[T10]")])), expect="[T1]"), "INCONCLUSIVE")
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "[T1]")])), expect="[T1]"), "KILLED")
        self.assertEqual(self.verdict(1, tap(run([assert_block(1, "T10 falhou")])), expect="T1"), "INCONCLUSIVE")

    def test_rc_other_than_one_or_rc0_with_failures_is_inconclusive(self):
        out = tap(run([assert_block(1, "[x-robots-tag]")]))
        self.assertEqual(self.verdict(7, out), "INCONCLUSIVE")
        self.assertEqual(self.verdict(0, out), "INCONCLUSIVE")


class ComprarCausalityRuleTest(unittest.TestCase):
    """Regra Sol 128: PRIMÁRIO por raciocínio, SECUNDÁRIO só com justificativa causal; o runner recusa mapa inválido."""

    def test_failure_only_in_secondary_assertion_is_inconclusive(self):
        out = tap(run([assert_block(1, "[alias]")]))
        self.assertEqual(classify(1, out, "[x-robots-tag]", TOTAL, ("[alias]",))[0], "INCONCLUSIVE")
        both = tap(run([assert_block(1, "[x-robots-tag]"), assert_block(2, "[alias]")]))
        self.assertEqual(classify(1, both, "[x-robots-tag]", TOTAL, ("[alias]",))[0], "KILLED")

    def test_unrelated_failure_is_inconclusive_even_with_primary(self):
        out = tap(run([assert_block(1, "[x-robots-tag]"), assert_block(2, "[canonical]")]))
        self.assertEqual(classify(1, out, "[x-robots-tag]", TOTAL, ("[alias]",))[0], "INCONCLUSIVE")

    def test_unjustified_entry_makes_the_runner_refuse_to_start(self):
        m = {"M1 x": ("w", "a", "b", "[x-robots-tag]")}
        self.assertEqual(MOD.mutant_map(m, {}, {"M1": {"[alias]": "o alias decodifica para a mesma rota mutada"}}, {})["M1"][0], ("[x-robots-tag]",))
        for bad in ({"M1": {"[alias]": ""}}, {"M1": {"[alias]": "porque"}}, {"M1": {"[alias]": None}}):
            with self.assertRaisesRegex(ValueError, "sem justificativa causal"):
                MOD.mutant_map(m, {}, bad, {})

    def test_more_than_four_assertions_without_broad_reason_is_refused(self):
        m = {"M1 x": ("w", "a", "b", "[a]")}
        prim = {"M1": ("[b]", "[c]")}
        sec = {"M1": {"[d]": "justificativa causal suficiente aqui", "[e]": "outra justificativa causal suficiente"}}
        with self.assertRaisesRegex(ValueError, "sem broad_reason"):
            MOD.mutant_map(m, prim, sec, {})
        self.assertIn("M1", MOD.mutant_map(m, prim, sec, {"M1": "a mutação desliga o cabeçalho em todas as rotas"}))
        with self.assertRaisesRegex(ValueError, "primários"):
            MOD.mutant_map(m, {"M1": ("[b]", "[c]", "[d]")}, {}, {})

    def test_real_map_is_valid(self):
        mp = MOD.mutant_map()
        self.assertEqual(len(mp), len(MOD.M))
        self.assertTrue(all(1 <= len(p) <= 3 for p, _ in mp.values()))


if __name__ == "__main__":
    unittest.main()
