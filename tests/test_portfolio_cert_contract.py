"""Contrato v3 da certificação do portfólio (Sol, Ordens 265-268 e AVAL 271): pré-merge x pós-publicação.

Pré-merge: a base de comparação com produção é a fonte no SHA EFETIVAMENTE PUBLICADO pela superfície que serve a
página; a relação publicado x base é registrada por superfície; deriva real (produção != fonte publicada) falha;
publicado fora da linhagem ou ilegível falha; mudança legítima do candidato passa e fica registrada com o diff.
Pós-publicação: só compara depois da promoção observada (workflow_run: a superfície do deploy reporta o SHA exato);
sem promoção, adia/falha (nunca passa, nunca acusa falso live_title_mismatch); depois da promoção, igualdade exata.
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

FILE = "combo-ia-vendas/index.html"


def page(title, h1, canonical="https://zevanory.api.br/combo-ia-vendas", filler=""):
    return ("<!doctype html>\n<html lang=\"pt-BR\">\n<head>\n"
            f"<title>{title}</title>\n<link rel=\"canonical\" href=\"{canonical}\">\n</head>\n<body>\n"
            f"<p>{filler}</p>\n<h1>{h1}</h1>\n</body>\n</html>\n")


OLD_T = "Combo IA + Vendas | Execução comercial com IA | ZEVANORY"
OLD_H = "Conecte IA ao processo comercial — não ao improviso."
NEW_T = "Combo IA + Vendas | Os dois treinamentos juntos | ZEVANORY"
NEW_H = "IA com método e vendas organizadas, em um só pacote."
SHA_A = "a" * 40
SHA_B = "b" * 40


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}).strip()


class Repo:
    """Repositório git temporário: gh-pages (base), deploys e candidato (PR)."""

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

    def run(self, fn, *a, **k):
        cwd = os.getcwd()
        os.chdir(self.d)
        try:
            return fn(*a, **k)
        finally:
            os.chdir(cwd)

    def show(self, rev):
        return git(self.d, "show", f"{rev}:{FILE}") + "\n"

    def branch(self, start, html, name="pr"):
        git(self.d, "checkout", "-q", "-b", name, start)
        head = self.commit(html, name)
        git(self.d, "checkout", "-q", "gh-pages")
        return head


def evaluate_pr(repo, head, base, live_html, deployed, serving="sales"):
    head_html = repo.show(head)
    live = C.extract_fields(live_html)
    inp = repo.run(C.premerge_inputs, FILE, head, base, deployed, serving, lineage_ref="refs/heads/gh-pages")
    ev = C.evaluate_premerge(C.extract_fields(head_html), live, inp["deployed"], inp["base"], inp["merge_base"],
                             head_html=head_html, diff_text=inp["diff_text"], surfaces=inp["surfaces"], serving=serving)
    return ev, inp


class ContextTest(unittest.TestCase):
    def test_pull_request_is_premerge(self):
        self.assertEqual(C.resolve_context("pull_request"), C.PRE_MERGE)
        self.assertEqual(C.resolve_context("pull_request", "pre-merge"), C.PRE_MERGE)

    def test_every_other_event_is_strict_post_deploy(self):
        for ev in ("push", "workflow_dispatch", "workflow_run", "pull_request_target", "", None):
            self.assertEqual(C.resolve_context(ev), C.POST_DEPLOY, ev)

    def test_declared_context_cannot_relax_push(self):
        with self.assertRaises(C.ContractError) as cm:
            C.resolve_context("push", "pre-merge")
        self.assertEqual(cm.exception.code, "context_mismatch")

    def test_workflow_run_requires_trigger_surface(self):
        self.assertEqual(C.resolve_trigger("workflow_run", "central"), "central")
        self.assertEqual(C.resolve_trigger("workflow_run", "sales"), "sales")
        with self.assertRaises(C.ContractError) as cm:
            C.resolve_trigger("workflow_run", "")
        self.assertEqual(cm.exception.code, "workflow_run_trigger_surface_missing")

    def test_trigger_surface_only_in_workflow_run(self):
        self.assertIsNone(C.resolve_trigger("push", ""))
        with self.assertRaises(C.ContractError) as cm:
            C.resolve_trigger("push", "sales")
        self.assertEqual(cm.exception.code, "trigger_surface_outside_workflow_run")


class SurfaceTest(unittest.TestCase):
    def test_serving_surface_from_final_host(self):
        self.assertEqual(C.surface_for_url("https://vendas.zevanory.api.br/combo-ia-vendas"), "sales")
        self.assertEqual(C.surface_for_url("https://zevanory.api.br/blog"), "central")
        with self.assertRaises(C.ContractError) as cm:
            C.surface_for_url("https://evil.example/zevanory.api.br")
        self.assertEqual(cm.exception.code, "unknown_serving_surface")

    def test_release_sha_paths_and_rejections(self):
        self.assertEqual(C.release_sha("central", {"deployment": {"commit_sha": SHA_A.upper()}}), SHA_A)
        self.assertEqual(C.release_sha("sales", {"release": SHA_B}), SHA_B)
        self.assertIsNone(C.release_sha("sales", {"release": "unversioned"}))
        self.assertIsNone(C.release_sha("central", {"release": SHA_A}))
        self.assertIsNone(C.release_sha("sales", None))


class PreMergeTest(unittest.TestCase):
    def setUp(self):
        self.r = Repo()
        self.base = self.r.commit(page(OLD_T, OLD_H), "base deployed")

    def tearDown(self):
        self.r.tmp.cleanup()

    def dep(self, sales, central=None):
        return {"sales": sales, "central": central or sales}

    def test_legitimate_change_passes_and_is_recorded_with_source_diff(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        ev, inp = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), self.dep(self.base))
        self.assertEqual(ev["certification_context"], C.PRE_MERGE)
        self.assertEqual(inp["surfaces"]["sales"]["relation"], "equal")
        got = {c["field"]: c for c in ev["expected_changes"]}
        self.assertEqual(set(got), {"title", "h1"})
        self.assertEqual((got["title"]["base"], got["title"]["candidate"]), (OLD_T, NEW_T))
        self.assertTrue(any(f"+<title>{NEW_T}</title>" in h for h in got["title"]["source_diff"]))
        self.assertTrue(any(f"-<h1>{OLD_H}</h1>" in h for h in got["h1"]["source_diff"]))
        self.assertEqual(ev["pending_undeployed"], [])

    def test_canonical_change_is_recorded(self):
        head = self.r.branch(self.base, page(OLD_T, OLD_H, canonical="https://vendas.zevanory.api.br/combo-ia-vendas"))
        ev, _ = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), self.dep(self.base))
        self.assertEqual([c["field"] for c in ev["expected_changes"]], ["canonical"])

    def test_live_drift_vs_deployed_source_fails(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page("Título editado fora do Git", OLD_H), self.dep(self.base))
        self.assertEqual(cm.exception.code, "live_drift_vs_deployed")

    def test_live_drift_fails_even_when_candidate_unchanged(self):
        head = self.r.branch(self.base, page(OLD_T, OLD_H, filler="x"))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(OLD_T, "H1 editado fora do Git"), self.dep(self.base))
        self.assertEqual(cm.exception.code, "live_drift_vs_deployed")

    def test_production_serving_candidate_before_merge_is_drift(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(NEW_T, NEW_H), self.dep(self.base))
        self.assertEqual(cm.exception.code, "live_drift_vs_deployed")

    def test_merged_but_not_deployed_compares_with_deployed_and_records_pending(self):
        # gh-pages avançou (merge não publicado / rollback hold): produção serve o SHA antigo.
        base2 = self.r.commit(page(NEW_T, OLD_H), "merged, not deployed")
        head = self.r.branch(base2, page(NEW_T, OLD_H, filler="x"))
        ev, inp = evaluate_pr(self.r, head, base2, page(OLD_T, OLD_H), self.dep(self.base, central=base2))
        self.assertEqual(inp["surfaces"]["sales"]["relation"], "behind_base")
        self.assertEqual(inp["surfaces"]["central"]["relation"], "equal")
        self.assertEqual([(p["surface"], p["field"], p["deployed"], p["base"]) for p in ev["pending_undeployed"]],
                         [("sales", "title", OLD_T, NEW_T)])
        self.assertEqual(ev["expected_changes"], [])

    def test_merged_not_deployed_still_detects_real_drift(self):
        base2 = self.r.commit(page(NEW_T, OLD_H), "merged, not deployed")
        head = self.r.branch(base2, page(NEW_T, OLD_H, filler="x"))
        # produção serve o título NOVO mas o publicado declarado é o antigo: deriva, não "base".
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, base2, page(NEW_T, OLD_H), self.dep(self.base))
        self.assertEqual(cm.exception.code, "live_drift_vs_deployed")

    def test_deployed_ahead_of_stale_event_base_is_recorded(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        newer = self.r.commit(page(OLD_T, OLD_H, filler="outra página mudou"), "newer gh-pages deployed")
        ev, inp = evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), self.dep(newer))
        self.assertEqual(inp["surfaces"]["sales"]["relation"], "ahead_of_base")
        self.assertEqual({c["field"] for c in ev["expected_changes"]}, {"title", "h1"})

    def test_deployed_outside_gh_pages_lineage_fails(self):
        # Publicado a partir de um commit que não está na história de gh-pages (nem atrás nem à frente legítimo).
        side = self.r.branch(self.base, page(OLD_T, OLD_H, filler="hotfix fora do git"), name="side")
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), self.dep(side, central=self.base))
        self.assertEqual(cm.exception.code, "deployed_not_in_gh_pages_lineage")

    def test_unresolvable_or_missing_deployed_sha_fails(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        for bad in (None, "c" * 40):
            with self.subTest(bad=bad), self.assertRaises(C.ContractError) as cm:
                evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), self.dep(bad, central=self.base))
            self.assertEqual(cm.exception.code, "deployed_sha_unresolvable")

    def test_central_surface_unresolvable_also_fails(self):
        head = self.r.branch(self.base, page(NEW_T, NEW_H))
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, self.base, page(OLD_T, OLD_H), {"sales": self.base, "central": None})
        self.assertEqual(cm.exception.code, "deployed_sha_unresolvable")

    def test_change_not_in_candidate_diff_fails(self):
        head = self.r.branch(self.base, page(OLD_T, OLD_H, filler="x"))
        base2 = self.r.commit(page(NEW_T, OLD_H), "base moved")
        with self.assertRaises(C.ContractError) as cm:
            evaluate_pr(self.r, head, base2, page(OLD_T, OLD_H), self.dep(self.base))
        self.assertEqual(cm.exception.code, "change_not_in_candidate_diff")
        self.assertEqual(cm.exception.detail["reason"], "base_changed_after_branch_point")

    def test_field_line_outside_added_hunks_fails(self):
        head_html = page(NEW_T, OLD_H)
        diff = "@@ -8 +8 @@\n-<p></p>\n+<p>x</p>\n"
        old = C.extract_fields(page(OLD_T, OLD_H))
        surf = {"sales": {"deployed_sha": SHA_A, "base_sha": SHA_A, "relation": "equal"}}
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_premerge(C.extract_fields(head_html), dict(old), dict(old), dict(old), dict(old),
                                head_html=head_html, diff_text=diff, surfaces=surf, serving="sales")
        self.assertEqual(cm.exception.code, "change_not_in_candidate_diff")
        self.assertEqual(cm.exception.detail["reason"], "field_line_not_in_added_hunks")

    def test_premerge_without_base_or_serving_record_fails_closed(self):
        f = C.extract_fields(page(OLD_T, OLD_H))
        surf = {"sales": {"deployed_sha": SHA_A, "base_sha": SHA_A, "relation": "equal"}}
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_premerge(f, dict(f), None, f, f, surfaces=surf, serving="sales")
        self.assertEqual(cm.exception.code, "premerge_base_missing")
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_premerge(f, dict(f), f, f, f, surfaces=surf, serving="central")
        self.assertEqual(cm.exception.code, "serving_surface_unrecorded")
        with self.assertRaises(C.ContractError) as cm:
            self.r.run(C.premerge_inputs, FILE, self.base, "", {"sales": self.base, "central": self.base}, "sales",
                       lineage_ref="refs/heads/gh-pages")
        self.assertEqual(cm.exception.code, "premerge_base_missing")


class Clock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = 0

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps += 1
        self.t += s


class PostDeployTest(unittest.TestCase):
    NEWF = C.extract_fields(page(NEW_T, NEW_H))
    OLDF = C.extract_fields(page(OLD_T, OLD_H))

    def promo(self, releases, fields_by_sha, trigger=None, wait=100):
        clk = Clock()
        seq = {k: list(v) for k, v in releases.items()}

        def read(s):
            v = seq[s]
            return v.pop(0) if len(v) > 1 else v[0]
        return C.await_promotion(SHA_B, self.NEWF, "sales", read, lambda sha: fields_by_sha.get(sha),
                                 trigger=trigger, wait_seconds=wait, interval=10, sleep=clk.sleep, clock=clk.now), clk

    def test_workflow_run_waits_until_trigger_reports_exact_sha_then_compares(self):
        p, clk = self.promo({"sales": [SHA_A, SHA_A, SHA_B]}, {SHA_A: self.OLDF, SHA_B: self.NEWF}, trigger="sales")
        self.assertEqual(p["state"], "PROMOTED")
        self.assertEqual(p["trigger_release"], SHA_B)
        self.assertEqual(clk.sleeps, 2)  # A, A, B: duas esperas
        ev = C.evaluate_post_deploy(self.NEWF, dict(self.NEWF), p)
        self.assertEqual(ev["promotion"]["serving_release"], SHA_B)

    def test_workflow_run_without_promotion_fails_not_passes(self):
        with self.assertRaises(C.ContractError) as cm:
            self.promo({"sales": [SHA_A]}, {SHA_A: self.OLDF}, trigger="sales")
        self.assertEqual(cm.exception.code, "promotion_not_observed")

    def test_central_trigger_requires_central_exact_sha_even_if_page_content_matches(self):
        with self.assertRaises(C.ContractError) as cm:
            self.promo({"central": [SHA_A], "sales": [SHA_A]}, {SHA_A: self.NEWF}, trigger="central")
        self.assertEqual(cm.exception.code, "promotion_not_observed")
        self.assertFalse(cm.exception.detail["trigger_ok"])

    def test_central_trigger_waits_for_serving_surface_content(self):
        with self.assertRaises(C.ContractError) as cm:
            self.promo({"central": [SHA_B], "sales": [SHA_A]}, {SHA_A: self.OLDF, SHA_B: self.NEWF}, trigger="central")
        self.assertEqual(cm.exception.code, "promotion_not_observed")
        self.assertTrue(cm.exception.detail["trigger_ok"])
        self.assertFalse(cm.exception.detail["serving_ok"])

    def test_push_during_deploy_window_defers_instead_of_false_mismatch(self):
        with self.assertRaises(C.ContractError) as cm:
            self.promo({"sales": [SHA_A]}, {SHA_A: self.OLDF})
        self.assertEqual(cm.exception.code, "post_deploy_deferred")

    def test_push_with_unchanged_page_content_is_ready_without_sales_redeploy(self):
        p, clk = self.promo({"sales": [SHA_A]}, {SHA_A: self.NEWF})
        self.assertEqual(p["state"], "PROMOTED")
        self.assertEqual(clk.sleeps, 0)

    def test_unreadable_release_never_counts_as_promoted(self):
        with self.assertRaises(C.ContractError) as cm:
            self.promo({"sales": [None]}, {})
        self.assertEqual(cm.exception.code, "post_deploy_deferred")

    def test_post_deploy_mismatch_after_promotion_still_fails(self):
        p = {"state": "PROMOTED", "serving_release": SHA_B}
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_post_deploy(self.NEWF, self.OLDF, p)
        self.assertEqual(cm.exception.code, "live_title_mismatch")
        with self.assertRaises(C.ContractError) as cm:
            C.evaluate_post_deploy(self.NEWF, C.extract_fields(page(NEW_T, OLD_H)), p)
        self.assertEqual(cm.exception.code, "live_h1_mismatch")

    def test_post_deploy_comparison_requires_observed_promotion(self):
        for p in (None, {"state": "DEFERRED"}):
            with self.subTest(p=p), self.assertRaises(C.ContractError) as cm:
                C.evaluate_post_deploy(self.NEWF, dict(self.NEWF), p)
            self.assertEqual(cm.exception.code, "post_deploy_without_promotion")

    def test_invalid_expected_sha_fails(self):
        with self.assertRaises(C.ContractError) as cm:
            C.await_promotion("main", self.NEWF, "sales", lambda s: SHA_B, lambda s: self.NEWF, wait_seconds=0)
        self.assertEqual(cm.exception.code, "expected_sha_invalid")


class WorkflowChainTest(unittest.TestCase):
    """A certificação pós-publicação está encadeada ao SUCESSO dos dois deploys, com o SHA implantado."""

    def setUp(self):
        import yaml
        self.yaml = yaml
        wf = ROOT / ".github/workflows/portfolio-six-target-exact-cert.yml"
        self.wf = yaml.load(wf.read_text("utf-8"), Loader=yaml.BaseLoader)
        self.on = self.wf.get("on") or self.wf.get(True)

    def name_of(self, f):
        return self.yaml.load((ROOT / ".github/workflows" / f).read_text("utf-8"), Loader=self.yaml.BaseLoader)["name"]

    def test_workflow_run_on_both_deploys_by_exact_name(self):
        wr = self.on["workflow_run"]
        self.assertEqual(sorted(wr["workflows"]), sorted([self.name_of("central-production-deploy.yml"),
                                                          self.name_of("zevanory-sales-public-release.yml")]))
        self.assertEqual(wr["types"], ["completed"])
        self.assertEqual(wr["branches"], ["gh-pages"])
        for n, s in C.SURFACES.items():
            self.assertIn(s["workflow"], wr["workflows"], n)

    def test_certify_runs_only_after_successful_promotion_with_deployed_sha(self):
        job = self.wf["jobs"]["certify"]
        cond = job["if"]
        self.assertIn("github.event.workflow_run.conclusion == 'success'", cond)
        self.assertIn("github.event.workflow_run.head_branch == 'gh-pages'", cond)
        env = job["env"]
        self.assertIn("github.event.workflow_run.head_sha", env["EXPECTED_SHA"])
        self.assertIn("'central'", env["TRIGGER_SURFACE"])
        self.assertIn(self.name_of("central-production-deploy.yml"), env["TRIGGER_SURFACE"])
        self.assertIn("contract-tests", job["needs"])


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
