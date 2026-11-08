"""Veredito estrito T1_EXCLUSIVITY (scripts/ci/t1_verdict.py): ausência de evidência, declaração do proprietário
ou dependência de rede nunca viram PROVEN; uma condição só é PROVEN com todas as verificações PROVEN; o veredito
leva o SHA. Repositórios sintéticos em diretório temporário; sem rede, sem segredo."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
import t1_verdict as tv  # noqa: E402

OWNER_ONLY = {("1", "1b"), ("2", "2:workers-builds"), ("4", "4a"), ("4", "4b"), ("5", "5c"), ("6", "6c")}


def git_init(d: Path):
    if not shutil.which("git"):
        raise unittest.SkipTest("git ausente")
    for cmd in (["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fx", "--allow-empty"]):
        subprocess.run(["git", "-C", str(d), *cmd], check=True, capture_output=True)


def checks(v):
    return {(k, c["id"]): c for k, cond in v["conditions"].items() for c in cond["checks"]}


def write(d: Path, rel: str, text: str):
    p = d / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


VERDICT_WF = "on:\n  pull_request:\n    branches: [gh-pages]\npermissions:\n  contents: read\njobs: {}\n"


def synthetic(d: Path, with_scanner=False, all_guarded=False):
    """Repositório mínimo; com with_scanner, simula o PR #990 (detector --check PASS e testes negativos)."""
    reg = {"services": {"zevanory": {"group": "deploy-zevanory", "canonical": "central-production-deploy.yml", "config_publishers": [], "pending_owner_authorization": []}},
           "unserialized_known": {}}
    if with_scanner:
        reg["write_paths"] = {"workflows": {"central-production-deploy.yml": {"scope": "production", "t1": "guarded" if all_guarded else "gap", "service": "zevanory"}}}
    write(d, "ops/publishers.json", json.dumps(reg))
    write(d, ".github/workflows/central-production-deploy.yml", "concurrency:\n  group: deploy-zevanory\n")
    for f in tv.SELF_FILES[:2]:
        (d / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / f, d / f)
    write(d, ".github/workflows/t1-exclusivity-verdict.yml", VERDICT_WF)
    if with_scanner:
        write(d, "scripts/deploy/t1-write-scan.mjs",
              "if (process.argv.includes('--check')) { console.log('T1_WRITE_PATHS_CHECK=PASS errors=0'); }\n"
              "else { console.log(JSON.stringify({ workflows: { 'central-production-deploy.yml': {} }, scripts: {} })); }\n")
        write(d, "tests/t1-write-scan.test.mjs",
              "// [WS6.1] [WS6.2] [WS6.3] [WS6.4] [WS6.5]\nimport test from 'node:test';\ntest('ok', () => {});\n")
        write(d, ".github/workflows/t1-publisher-guard.yml", "on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: node --test tests/t1-write-scan.test.mjs\n")


class T1VerdictTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1v-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_v1_empty_repository_is_not_proven_everywhere(self):
        v = tv.evaluate(self.tmp)
        self.assertEqual(v["T1_EXCLUSIVITY"], tv.NOT_PROVEN)
        self.assertEqual(v["P17_VCH"], tv.NOT_PROVEN)
        self.assertEqual(sorted(v["conditions"]), ["1", "2", "3", "4", "5", "6", "7"])
        for k, cond in v["conditions"].items():
            self.assertEqual(cond["status"], tv.NOT_PROVEN, k)
        self.assertIsNone(v["sha"])
        for c in checks(v).values():
            if c["status"] != tv.PROVEN:
                self.assertTrue(c.get("reason"), c["id"])

    def test_v2_condition_is_proven_only_when_every_check_is(self):
        v = tv.evaluate(ROOT)
        for k, cond in v["conditions"].items():
            self.assertEqual(cond["status"] == tv.PROVEN, all(c["status"] == tv.PROVEN for c in cond["checks"]), k)
        self.assertEqual(v["T1_EXCLUSIVITY"] == tv.PROVEN, all(c["status"] == tv.PROVEN for c in v["conditions"].values()))
        self.assertEqual(v["P17_VCH"] == tv.PROVEN, all(c["status"] == tv.PROVEN for c in v["p17_vch"]))

    def test_v3_owner_dependent_items_stay_not_proven_with_action(self):
        v = tv.evaluate(ROOT)
        cs = checks(v)
        for key in OWNER_ONLY:
            self.assertIn(key, cs)
            self.assertEqual(cs[key]["status"], tv.NOT_PROVEN, key)
            self.assertTrue(cs[key].get("owner_action"), key)
        v5 = {c["id"]: c for c in v["p17_vch"]}
        self.assertEqual(v5["V5"]["status"], tv.NOT_PROVEN)
        self.assertEqual(v5["V6"]["status"], tv.NOT_PROVEN)
        self.assertEqual(v["T1_EXCLUSIVITY"], tv.NOT_PROVEN)

    def test_v4_owner_declaration_is_text_not_proof(self):
        synthetic(self.tmp, with_scanner=True, all_guarded=True)
        write(self.tmp, "ops/t1-owner-evidence.json", json.dumps({k: {"status": "done", "run": "123"} for k in ("workers_builds", "token_scope", "rollback_rehearsal")}))
        git_init(self.tmp)
        v = tv.evaluate(self.tmp)
        cs = checks(v)
        for key in [("1", "1b"), ("4", "4b"), ("6", "6c")]:
            self.assertEqual(cs[key]["status"], tv.NOT_PROVEN, key)
            self.assertIn("não verificável offline", cs[key]["reason"], key)
        self.assertEqual(v["T1_EXCLUSIVITY"], tv.NOT_PROVEN)

    def test_v5_evidence_in_the_sha_flips_only_its_checks(self):
        synthetic(self.tmp, with_scanner=True, all_guarded=True)
        git_init(self.tmp)
        if not shutil.which("node"):
            self.skipTest("node ausente")
        v = tv.evaluate(self.tmp)
        cs = checks(v)
        self.assertEqual(cs[("1", "1a")]["status"], tv.PROVEN)
        self.assertEqual(cs[("3", "3a")]["status"], tv.PROVEN)
        for cid in ("5a", "5b", "5d"):
            self.assertEqual(cs[("5", cid)]["status"], tv.PROVEN, cid)
        self.assertEqual(cs[("7", "7a")]["status"], tv.PROVEN)
        self.assertRegex(v["sha"], r"^[0-9a-f]{40}$")
        # Mesmo com todo o código no lugar, o que depende do proprietário mantém o veredito em NOT_PROVEN.
        self.assertEqual(v["conditions"]["1"]["status"], tv.NOT_PROVEN)
        self.assertEqual(v["conditions"]["5"]["status"], tv.NOT_PROVEN)
        self.assertEqual(v["T1_EXCLUSIVITY"], tv.NOT_PROVEN)

    def test_v6_a_gap_or_a_failing_detector_keeps_condition_3_not_proven(self):
        synthetic(self.tmp, with_scanner=True, all_guarded=False)
        git_init(self.tmp)
        if not shutil.which("node"):
            self.skipTest("node ausente")
        cs = checks(tv.evaluate(self.tmp))
        self.assertEqual(cs[("3", "3a")]["status"], tv.NOT_PROVEN)
        self.assertIn("central-production-deploy.yml", cs[("3", "3a")]["reason"])
        write(self.tmp, "scripts/deploy/t1-write-scan.mjs", "console.log('T1_WRITE_PATHS_CHECK=FAIL errors=1'); process.exit(1);\n")
        cs = checks(tv.evaluate(self.tmp))
        self.assertEqual(cs[("1", "1a")]["status"], tv.NOT_PROVEN)

    def test_v7_verdict_workflow_must_be_read_only_pull_request(self):
        synthetic(self.tmp)
        git_init(self.tmp)
        self.assertEqual(checks(tv.evaluate(self.tmp))[("7", "7a")]["status"], tv.PROVEN)
        write(self.tmp, ".github/workflows/t1-exclusivity-verdict.yml", VERDICT_WF.replace("  contents: read\n", "  contents: write\n"))
        self.assertEqual(checks(tv.evaluate(self.tmp))[("7", "7a")]["status"], tv.NOT_PROVEN)
        write(self.tmp, ".github/workflows/t1-exclusivity-verdict.yml", VERDICT_WF + "env:\n  T: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n")
        self.assertEqual(checks(tv.evaluate(self.tmp))[("7", "7a")]["status"], tv.NOT_PROVEN)

    def test_v8_without_sha_nothing_is_proven(self):
        synthetic(self.tmp, with_scanner=True, all_guarded=True)
        v = tv.evaluate(self.tmp)  # sem git: SHA ilegível
        self.assertIsNone(v["sha"])
        self.assertEqual(checks(v)[("7", "7a")]["status"], tv.NOT_PROVEN)
        self.assertEqual(v["T1_EXCLUSIVITY"], tv.NOT_PROVEN)

    def test_v9_cli_exit_codes_and_outputs(self):
        run = lambda *a: subprocess.run([sys.executable, str(ROOT / "scripts/ci/t1_verdict.py"), "--root", str(ROOT), *a], capture_output=True, text=True, timeout=600)
        p = run("--json")
        self.assertEqual(p.returncode, 0)
        self.assertEqual(json.loads(p.stdout)["schema"], "t1-verdict/v1")
        self.assertRegex(p.stderr, r"^T1_EXCLUSIVITY=NOT_PROVEN ")
        self.assertEqual(run("--strict").returncode, 1)
        md = run("--markdown").stdout
        self.assertIn("## T1_EXCLUSIVITY = **NOT_PROVEN**", md)
        self.assertNotIn("WARN", md)

    def test_v10_named_financial_routes_pending_authorization_are_not_proven(self):
        cs = checks(tv.evaluate(ROOT))
        for w in ("mercadopago-exact-sha-recovery.yml", "financial-e2e-stripe.yml"):
            self.assertEqual(cs[("2", f"2:{w}")]["status"], tv.NOT_PROVEN, w)
            self.assertIn("autorização escrita", cs[("2", f"2:{w}")]["owner_action"])
        self.assertEqual(cs[("6", "6a")]["status"], tv.NOT_PROVEN)


if __name__ == "__main__":
    unittest.main()
