"""Contrato v2 da certificação do portfólio (Sol, Ordens 265-268): pré-merge do candidato x pós-publicação.

Prova: (1) deriva de produção continua falhando no pré-merge; (2) mudança legítima do candidato passa no
pré-merge e fica registrada com o diff da fonte; (3) divergência pós-publicação continua falhando; (4) o contexto
não pode ser relaxado por variável; (5) mudança que não está no diff do candidato falha.
Sem rede. PORTFOLIO_CERT_CONTRACT_PATH permite aos mutantes apontar para uma cópia mutada do módulo.
"""
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = pathlib.Path(os.environ.get("PORTFOLIO_CERT_CONTRACT_PATH") or ROOT / "scripts/portfolio_cert_contract.py")
SPEC = importlib.util.spec_from_file_location("portfolio_cert_contract", PATH)
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


def page(title, h1, canonical="https://zevanory.api.br/combo-ia-vendas", filler=""):
    return ("<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n"
            f"<title>{title}</title>\n<link rel=\"canonical\" href=\"{canonical}\">\n</head>\n<body>\n"
            f"<p>{filler}</p>\n<h1>{h1}</h1>\n</body>\n</html>\n")


OLD_T = "Combo IA + Vendas | Execução comercial com IA | ZEVANORY"
OLD_H = "Conecte IA ao processo comercial — não ao improviso."
NEW_T = "Combo IA + Vendas | Os dois treinamentos juntos | ZEVANORY"
NEW_H = "IA com método e vendas organizadas, em um só pacote."


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}).strip()


class Repo:
    """Repositório git temporário: base (gh-pages) e candidato (PR)."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        git(self.d, "init", "-q", "-b", "gh-pages")
        git(self.d, "config", "user.email", "t@example.invalid")
        git(self.d, "config", "user.name", "t")
        git(self.d, "config", "commit.gpgsign", "false")

    def commit(self, html, msg):
        p = pathlib.Path(self.d, "combo-ia-vendas")
        p.mkdir(exist_ok=True)
        (p / "index.html").write_text(html, "utf-8")
        git(self.d, "add", "-A")
        git(self.d, "commit", "-q", "-m", msg)
        return git(self.d, "rev-parse", "HEAD")

    def inputs(self, head, base, live, tip_ref="refs/heads/gh-pages"):
        cwd = os.getcwd()
        os.chdir(self.d)
        try:
            return C.premerge_inputs("combo-ia-vendas/index.html", head, base, live, tip_ref=tip_ref)
        finally:
            os.chdir(cwd)

    def show(self, rev):
        return git(self.d, "show", f"{rev}:combo-ia-vendas/index.html") + "\n"


def evaluate_pr(repo, head, base, live_html, tip_ref="refs/heads/gh-pages"):
    head_html = repo.show(head)
    live = C.extract_fields(live_html)
    inp = repo.inputs(head, base, live, tip_ref=tip_ref)
    ev = C.evaluate_live_contract(C.PRE_MERGE, C.extract_fields(head_html), live, base=inp["base"],
                                  merge_base=inp["merge_base"], head_html=head_html, diff_text=inp["diff_text"])
    return ev, inp


class ContextTest(unittest.TestCase):
    def test_pull_request_is_premerge(self):
        self.assertEqual(C.resolve_context("pull_request"), C.PRE_MERGE)
        self.assertEqual(C.resolve_context("pull_request", "pre-merge"), C.PRE_MERGE)

    def test_every_other_event_is_strict_post_deploy(self):
        for ev in ("push", "workflow_dispatch", "pull_request_target", "", None):
            self.assertEqual(C.resolve_context(ev), C.POST_DEPLOY, ev)

    def test_declared_context_cannot_relax_push(self):
        with self.assertRaises(C.ContractError) as cm:
            C.resolve_context("push", "pre-merge")
        self.assertEqual(cm.exception.code, "context_mismatch")


class PostDeployTest(unittest.TestCase):
    def test_post_deploy_exact_match_passes(self):
        f = C.extract_fields(page(NEW_T, NEW_H))
        ev = C.evaluate_live_contract(C.POST_DEPLOY, f, dict(f))
        self.assertEqual(ev["certification_context"], C.POST_DEPLOY)
        self.assertEqual(ev["expected_changes"], [])

    def test_post_deploy_title_mismatch_still_fails(self):
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract(C.POST_DEPLOY, C.extract_fields(page(NEW_T, NEW_H)),
                                     C.extract_fields(page(OLD_T, NEW_H)))
        self.assertEqual(cm.exception.code, "live_title_mismatch")

    def test_post_deploy_h1_mismatch_still_fails(self):
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract(C.POST_DEPLOY, C.extract_fields(page(NEW_T, NEW_H)),
                                     C.extract_fields(page(NEW_T, OLD_H)))
        self.assertEqual(cm.exception.code, "live_h1_mismatch")

    def test_post_deploy_ignores_base_even_if_given(self):
        old = C.extract_fields(page(OLD_T, OLD_H))
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract(C.POST_DEPLOY, C.extract_fields(page(NEW_T, NEW_H)), old,
                                     base=old, merge_base=old)
        self.assertEqual(cm.exception.code, "live_title_mismatch")


class PreMergeTest(unittest.TestCase):
    def setUp(self):
        self.r = Repo()
        self.base = self.r.commit(page(OLD_T, OLD_H), "base")

    def tearDown(self):
        self.r.tmp.cleanup()

    def branch(self, html):
        git(self.r.d, "checkout", "-q", "-b", "pr", self.base)
        head = self.r.commit(html, "pr")
        git(self.r.d, "checkout", "-q", "gh-pages")
        return head

    def test_legitimate_change_passes_and_is_recorded_with_source_diff(self):
        head = self.branch(page(NEW_T, NEW_H))
        ev, inp = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H))
        self.assertEqual(ev["certification_context"], C.PRE_MERGE)
        self.assertEqual(inp["base_resolution"], "event_base")
        got = {c["field"]: c for c in ev["expected_changes"]}
        self.assertEqual(set(got), {"title", "h1"})
        self.assertEqual((got["title"]["base"], got["title"]["candidate"]), (OLD_T, NEW_T))
        self.assertEqual((got["h1"]["base"], got["h1"]["candidate"]), (OLD_H, NEW_H))
        self.assertTrue(any(f"+<title>{NEW_T}</title>" in h for h in got["title"]["source_diff"]))
        self.assertTrue(any(f"-<h1>{OLD_H}</h1>" in h for h in got["h1"]["source_diff"]))

    def test_canonical_change_is_recorded(self):
        head = self.branch(page(OLD_T, OLD_H, canonical="https://vendas.zevanory.api.br/combo-ia-vendas"))
        ev, _ = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H))
        self.assertEqual([c["field"] for c in ev["expected_changes"]], ["canonical"])

    def test_unchanged_candidate_records_nothing(self):
        head = self.branch(page(OLD_T, OLD_H, filler="outro texto"))
        ev, _ = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H))
        self.assertEqual(ev["expected_changes"], [])

    def test_live_drift_vs_base_still_fails_premerge(self):
        head = self.branch(page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page("Título editado fora do Git", OLD_H))
        self.assertEqual(cm.exception.code, "live_drift_vs_base")

    def test_live_drift_fails_even_when_candidate_unchanged(self):
        head = self.branch(page(OLD_T, OLD_H, filler="x"))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(OLD_T, "H1 editado fora do Git"))
        self.assertEqual(cm.exception.code, "live_drift_vs_base")

    def test_production_already_serving_candidate_is_drift_premerge(self):
        # Produção não pode antecipar o candidato antes do merge: isso também é deriva.
        head = self.branch(page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(NEW_T, NEW_H))
        self.assertEqual(cm.exception.code, "live_drift_vs_base")

    def test_change_not_in_candidate_diff_fails(self):
        # Candidato ramificado antes; a base mudou o título depois. Candidato != base, mas não pelo diff dele.
        head = self.branch(page(OLD_T, OLD_H, filler="x"))
        base2 = self.r.commit(page(NEW_T, OLD_H), "base moved")
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, base2, page(NEW_T, OLD_H))
        self.assertEqual(cm.exception.code, "change_not_in_candidate_diff")
        self.assertEqual(cm.exception.detail["reason"], "base_changed_after_branch_point")

    def test_field_line_outside_added_hunks_fails(self):
        head_html = page(NEW_T, OLD_H)
        diff = "@@ -8 +8 @@\n-<p></p>\n+<p>x</p>\n"
        old = C.extract_fields(page(OLD_T, OLD_H))
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract(C.PRE_MERGE, C.extract_fields(head_html), dict(old), base=old,
                                     merge_base=dict(old), head_html=head_html, diff_text=diff)
        self.assertEqual(cm.exception.code, "change_not_in_candidate_diff")
        self.assertEqual(cm.exception.detail["reason"], "field_line_not_in_added_hunks")

    def test_premerge_without_base_fails_closed(self):
        f = C.extract_fields(page(OLD_T, OLD_H))
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract(C.PRE_MERGE, f, dict(f))
        self.assertEqual(cm.exception.code, "premerge_base_missing")
        with self.assertRaises(C.ContractError):
            self.r.inputs(self.base, "", f)

    def test_newer_gh_pages_tip_already_deployed_is_used_as_base(self):
        head = self.branch(page(OLD_T, OLD_H, filler="x"))
        tip = self.r.commit(page(NEW_T, OLD_H), "authorized deploy after the PR event")
        git(self.r.d, "checkout", "-q", "pr")
        git(self.r.d, "merge", "-q", "--no-edit", "gh-pages")
        head2 = git(self.r.d, "rev-parse", "HEAD")
        git(self.r.d, "checkout", "-q", "gh-pages")
        ev, inp = evaluate_pr(self.r, head2, self.base, page(NEW_T, OLD_H))
        self.assertEqual((inp["base_resolution"], inp["base_sha"]), ("gh_pages_tip", tip))
        self.assertEqual(ev["expected_changes"], [])
        self.assertNotEqual(head, head2)

    def test_unknown_context_fails(self):
        f = C.extract_fields(page(OLD_T, OLD_H))
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_live_contract("canary", f, dict(f), base=f, merge_base=f)
        self.assertEqual(cm.exception.code, "unknown_context")


class ParsingTest(unittest.TestCase):
    def test_added_line_ranges(self):
        d = "@@ -6 +6 @@\n-a\n+b\n@@ -10,0 +11,3 @@\n+x\n+y\n+z\n@@ -20,2 +23,0 @@\n-q\n-r\n"
        self.assertEqual(C.added_line_ranges(d), [(6, 6), (11, 13)])

    def test_h1_markup_is_cleaned_and_lines_located(self):
        html = page(OLD_T, "IA com <em>método</em>")
        self.assertEqual(C.extract_fields(html)["h1"], "IA com método")
        self.assertEqual(C.field_lines(html, "h1"), (9, 9))
        self.assertEqual(C.field_lines(html, "title"), (4, 4))


if __name__ == "__main__":
    unittest.main()
