"""Integrated simulation of the T1 activation #799 -> #210 (plan 3.1), WITHOUT publishing.

Executes the REAL bash of the workflows (extracted from the YAML, unmodified) against:
  * a local fixture of the panel repository whose commits reproduce the real states
    (live c1182c5 without version tag; another runtime PR; #210 with the tagging deploy script
    and the vendored real workflow/script files from c1182c5 and b98218c);
  * a fake network (tests/t1_sim/sitecustomize.py) for version.json and the Cloudflare API;
  * shims for git (clone URL -> fixture), gh (records dispatches) and curl (old reconciler).
Nothing reaches GitHub, Cloudflare or production. A publish step is never executed: the
simulation stops at the decision (PROMOTE / dispatch) that would precede it.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WF = ROOT / ".github" / "workflows"
SIM = ROOT / "tests" / "t1_sim"
FIX = SIM / "fixtures"
ZPC_URL = "https://github.com/arbmsistone-lab/zevanory-product-control-edge.git"
OWNER = "arbmsistone-lab"


def steps_of(text: str) -> dict[str, dict]:
    doc = yaml.safe_load(text)
    out = {}
    for job in doc["jobs"].values():
        for st in job.get("steps", []):
            if "name" in st:
                out[st["name"]] = st
    return out


def expand(script: str) -> str:
    script = script.replace("${{ github.run_id }}", "1").replace("${{ github.repository }}", f"{OWNER}/zevanory-public-mirror")
    assert "${{" not in script, "unexpected expression in simulated script"
    return script


def git(repo, *args, env=None):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()


class Fixture:
    """Panel repository fixture: P (older) -> L (live, untagged) -> X (other PR) -> T (#210)."""

    def __init__(self, base: pathlib.Path):
        self.repo = base / "zpc-fixture"
        self.repo.mkdir()
        env = {**os.environ, "GIT_AUTHOR_NAME": "sim", "GIT_AUTHOR_EMAIL": "sim@example.invalid",
               "GIT_COMMITTER_NAME": "sim", "GIT_COMMITTER_EMAIL": "sim@example.invalid"}
        self.env = env
        git(self.repo, "init", "-q", "-b", "main", env=env)
        git(self.repo, "config", "uploadpack.allowAnySHA1InWant", "true")
        git(self.repo, "config", "uploadpack.allowFilter", "true")
        self.write("cf-worker/worker.ts", "export default { fetch: (r) => globalTrustResponse(r) };\n")
        self.write("cf-worker/global-trust.ts", "headers({'x-zpc-trust-source': 'live-control-core'})\n")
        self.write("scripts/cloudflare-authoritative-repair.mjs", (FIX / "repair-main-c1182c5.mjs").read_text())
        self.write(".github/workflows/zpc-canonical-worker-promotion.yml", (FIX / "zpc-promotion-main-c1182c5.yml").read_text())
        self.P = self.commit("P: older runtime")
        self.write("src/a.ts", "export const a = 1;\n")
        self.L = self.commit("L: live c1182c5 (deploy script without --tag)")
        self.write("src/b.ts", "export const b = 2;\n")
        self.X = self.commit("X: another runtime PR merged before #210")
        self.write("scripts/cloudflare-authoritative-repair.mjs", (FIX / "repair-pr210-b98218c.mjs").read_text())
        self.write(".github/workflows/zpc-canonical-worker-promotion.yml", (FIX / "zpc-promotion-pr210-b98218c.yml").read_text())
        self.T = self.commit("T: #210 (tagging deploy script, repository workflow dry-run only)")

    def write(self, rel, content):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def commit(self, msg):
        git(self.repo, "add", "-A", env=self.env)
        git(self.repo, "commit", "-q", "-m", msg, env=self.env)
        return git(self.repo, "rev-parse", "HEAD")

    def set_main(self, sha):
        git(self.repo, "update-ref", "refs/heads/main", sha)


class Sim:
    def __init__(self, base: pathlib.Path, fixture: Fixture):
        self.base, self.fx = base, fixture
        self.bin = base / "bin"
        self.bin.mkdir()
        real_git = shutil.which("git")
        self._shim("git", f"""#!/usr/bin/env bash
            args=(); for a in "$@"; do [ "$a" = "{ZPC_URL}" ] && a="file://{fixture.repo}"; args+=("$a"); done
            exec {real_git} "${{args[@]}}"
        """)
        self._shim("gh", """#!/usr/bin/env bash
            echo "$*" >> "$SIM_GH_LOG"
            if [ "$1 $2" = "run list" ]; then echo "${SIM_PENDING:-0}"; fi
            exit 0
        """)
        # Old reconciler reads version.json with curl: answer from the same simulated state.
        curl = self.bin / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport json, sys, urllib.request\ntry:\n"
                        "    print(json.dumps(json.load(urllib.request.urlopen(urllib.request.Request(sys.argv[-1])))))\n"
                        "except Exception:\n    sys.exit(22)\n")
        curl.chmod(0o755)

    def _shim(self, name, body):
        p = self.bin / name
        p.write_text(textwrap.dedent(body).replace("\n            ", "\n"))
        p.chmod(0o755)

    def run(self, step: dict, state: dict, env: dict | None = None, pending=0, cwd=None):
        work = pathlib.Path(cwd or tempfile.mkdtemp(dir=self.base))
        if not (work / "scripts").exists():
            (work / "scripts").symlink_to(ROOT / "scripts")
            (work / "zpc-control-worker-source.txt").write_text(self.fx.L + "\n")
        st_file = work / "state.json"
        st_file.write_text(json.dumps(state))
        for f in work.glob("state.json.*"):
            f.unlink()
        gh_env, gh_out, gh_log = work / "env", work / "out", work / "gh.log"
        for f in (gh_env, gh_out, gh_log):
            f.write_text("")
        full_env = {"PATH": f"{self.bin}:{os.environ['PATH']}", "HOME": str(self.base), "PYTHONPATH": str(SIM),
                    "SIM_STATE": str(st_file), "SIM_GH_LOG": str(gh_log), "SIM_PENDING": str(pending),
                    "GITHUB_ENV": str(gh_env), "GITHUB_OUTPUT": str(gh_out), "GITHUB_STEP_SUMMARY": str(work / "summary"),
                    "GITHUB_REPOSITORY": f"{OWNER}/zevanory-public-mirror", "GITHUB_EVENT_NAME": "schedule"}
        for line in (work / "carry").read_text().splitlines() if (work / "carry").exists() else []:
            k, _, v = line.partition("=")
            full_env[k] = v
        for k, v in (step.get("env") or {}).items():
            full_env[k] = str(v) if "${{" not in str(v) else ""
        full_env.update(env or {})
        proc = subprocess.run(["bash", "-e", "-c", expand(step["run"])], cwd=work, env=full_env, capture_output=True, text=True)
        carried = (work / "carry").read_text() if (work / "carry").exists() else ""
        (work / "carry").write_text(carried + gh_env.read_text())
        outputs = dict(line.partition("=")[::2] for line in gh_out.read_text().splitlines() if "=" in line)
        envs = dict(line.partition("=")[::2] for line in (work / "carry").read_text().splitlines() if "=" in line)
        return {"code": proc.returncode, "out": proc.stdout + proc.stderr, "outputs": outputs, "env": envs,
                "gh": gh_log.read_text().strip().splitlines(), "cwd": work}


def verify_cmd(step_run: str) -> str:
    m = re.search(r"python3 scripts/deploy/promotion_guard\.py --verify-promoted(?:[^\n]*\\\n)*[^\n]*", step_run)
    assert m, "post-promotion command not found"
    return m.group(0)


class Transition(unittest.TestCase):
    """Each test prints a SIM line; together they are the evidence table of the T1 v6 package."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t1sim-"))
        cls.fx = Fixture(cls.tmp)
        cls.sim = Sim(cls.tmp, cls.fx)
        cls.t2 = steps_of((WF / "t2-exact-control-worker-promotion.yml").read_text())
        cls.canon = steps_of((WF / "zpc-control-worker-deploy.yml").read_text())
        old = subprocess.run(["git", "-C", str(ROOT), "show", "origin/gh-pages:.github/workflows/t2-exact-control-worker-promotion.yml"],
                             capture_output=True, text=True)
        cls.old_t2 = steps_of(old.stdout) if old.returncode == 0 and "Resolve exact T2 source SHA" in old.stdout else None
        cls.ext = steps_of((WF / "t1-publisher-guard.yml").read_text())["Panel repository has no production publish path"]
        cls.central_verify = steps_of((WF / "central-production-deploy.yml").read_text())["Post-promotion effective version (T1)"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def log(self, scenario, result):
        print(f"\nSIM {scenario}: {result}")

    # ---- reconciler (requester) ------------------------------------------------------------
    def requester(self, main, readback, pending=0):
        self.fx.set_main(main)
        r = self.sim.run(self.t2["Decide whether the canonical publisher must be requested"], {"readback": readback})
        dispatched = []
        if r["outputs"].get("needs_promotion") == "true":
            r2 = self.sim.run(self.t2["Request the canonical publisher"], {"readback": readback}, pending=pending, cwd=r["cwd"])
            self.assertEqual(r2["code"], 0, r2["out"])
            dispatched = [g for g in r2["gh"] if g.startswith("workflow run")]
        return r, dispatched

    # ---- canonical publisher ---------------------------------------------------------------
    def canonical(self, source, readback, cf, *, backwards=False, actor="github-actions[bot]", reason="", skip_if_live=False):
        env = {"DISPATCH_SHA": source}
        r1 = self.sim.run(self.canon["Resolve exact source SHA"], {"readback": readback, "cf": cf}, env=env)
        self.assertEqual(r1["code"], 0, r1["out"])
        env = {"ALLOW_BACKWARDS": "true" if backwards else "false", "ROLLBACK_REASON": reason, "ACTOR": actor,
               "REPO_OWNER": OWNER, "EVENT": "workflow_dispatch", "SKIP_IF_LIVE": "true" if skip_if_live else "false",
               "CLOUDFLARE_API_TOKEN": "sim-token", "CLOUDFLARE_ACCOUNT_ID": "sim-account"}
        r = self.sim.run(self.canon["Validate exact source SHA"], {"readback": readback, "cf": cf}, env=env, cwd=r1["cwd"])
        return r

    def test_s0_reverse_order_old_reconciler_would_publish(self):
        """Why #210 must NOT go first: the reconciler live on gh-pages today publishes on any difference."""
        if not self.old_t2:
            self.skipTest("origin/gh-pages not available")
        step = self.old_t2["Resolve exact T2 source SHA"]
        self.fx.set_main(self.fx.T)
        r = self.sim.run(step, {"readback": self.fx.L})
        self.assertEqual(r["outputs"].get("needs_promotion"), "true")
        r_down = self.sim.run(step, {"readback": "unreachable"})
        self.assertEqual(r_down["outputs"].get("needs_promotion"), "true", "old reconciler publishes even with production unreadable")
        self.log("S0 ordem inversa (#210 antes do #799), t2 ANTIGO", "publicaria sem guarda (needs_promotion=true), inclusive com produção ilegível")

    def test_s1_after_799_before_210_nothing_publishes(self):
        r, dispatched = self.requester(self.fx.L, self.fx.L)
        self.assertEqual(r["code"], 0, r["out"])
        self.assertIn("same_as_live_redeploy", r["out"])
        self.assertEqual(dispatched, [])
        ext = self.sim.run(self.ext, {})
        self.assertEqual(ext["code"], 1, "external-repository must stay red while the panel repo can publish")
        self.assertIn("EXTERNAL_PUBLISHER", ext["out"])
        self.log("S1 após #799, antes do #210", "t2 não pede (same_as_live); canônico ocioso; external-repository VERMELHO (verdadeiro)")

    def test_s2_210_delayed_other_runtime_pr_is_refused_before_publish(self):
        r, dispatched = self.requester(self.fx.X, self.fx.L)
        self.assertEqual(len(dispatched), 1, r["out"])
        self.assertIn(f"source_sha={self.fx.X}", dispatched[0])
        self.assertIn("skip_if_live=true", dispatched[0])
        c = self.canonical(self.fx.X, self.fx.L, "untagged", skip_if_live=True)
        self.assertEqual(c["code"], 1)
        self.assertIn("SOURCE_WITHOUT_VERSION_TAG", c["out"])
        self.assertNotIn("PROMOTE", c["env"], "no publish decision is ever reached")
        self.log("S2 #210 atrasado + outro PR de runtime no painel", "t2 pede; canônico RECUSA antes de publicar (SOURCE_WITHOUT_VERSION_TAG)")

    def test_s3_210_blocked_owner_rollback_still_available(self):
        self.fx.set_main(self.fx.L)
        bot = self.canonical(self.fx.P, self.fx.L, "untagged", backwards=True, actor="github-actions[bot]", reason="x" * 30)
        self.assertEqual(bot["code"], 1)
        self.assertIn("ROLLBACK_NOT_AUTHORISED", bot["out"])
        own = self.canonical(self.fx.P, self.fx.L, "untagged", backwards=True, actor=OWNER, reason="painel quebrado em producao apos merge")
        self.assertEqual(own["code"], 0, own["out"])
        self.assertEqual(own["env"].get("PROMOTE"), "true")
        self.assertEqual(own["env"].get("ROLLBACK_AUDIT"), "true")
        fwd = self.canonical(self.fx.P, self.fx.L, "untagged")
        self.assertEqual((fwd["code"], fwd["env"].get("PROMOTE")), (0, "false"), "an ordinary run with an older source never moves production back")
        self.assertIn("SUPERSEDED", fwd["out"])
        self.log("S3 #210 impedido; rollback na janela", "bot: ROLLBACK_NOT_AUTHORISED; proprietário: PROMOTE=true + auditoria; execução comum com fonte antiga: SUPERSEDED (PROMOTE=false)")

    def test_s4_after_210_requester_then_canonical_promotes_forward(self):
        r, dispatched = self.requester(self.fx.T, self.fx.L)
        self.assertEqual(len(dispatched), 1, r["out"])
        c = self.canonical(self.fx.T, self.fx.L, "untagged", skip_if_live=True)
        self.assertEqual(c["code"], 0, c["out"])
        self.assertIn("forward_of_live", c["out"])
        self.assertEqual(c["env"].get("PROMOTE"), "true")
        ext = self.sim.run(self.ext, {})
        self.assertEqual(ext["code"], 0, ext["out"])
        self.assertIn("EXTERNAL_REPOSITORY_PUBLISHERS=0", ext["out"])
        self.log("S4 após #210", "t2 pede; canônico forward_of_live -> PROMOTE=true (publicação marcada); external-repository VERDE")

    def test_s5_duplicate_scheduled_tick_while_canonical_pending(self):
        r, dispatched = self.requester(self.fx.T, self.fx.L, pending=1)
        self.assertEqual(dispatched, [])
        self.log("S5 nova execução agendada com canônico pendente", "não pede de novo (ZPC_REQUEST_PENDING)")

    def test_s6_tagged_version_live_is_idempotent(self):
        r, dispatched = self.requester(self.fx.T, self.fx.T)
        self.assertEqual(dispatched, [])
        c = self.canonical(self.fx.T, self.fx.T, self.fx.T, skip_if_live=True)
        self.assertEqual((c["code"], c["env"].get("PROMOTE")), (0, "false"), c["out"])
        self.assertIn("ALREADY_LIVE", c["out"])
        stale = self.canonical(self.fx.X, self.fx.T, self.fx.T)
        self.assertEqual((stale["code"], stale["env"].get("PROMOTE")), (0, "false"), stale["out"])
        self.assertIn("SUPERSEDED", stale["out"])
        self.log("S6 versão marcada no ar", "t2 não pede; pedido duplicado = ALREADY_LIVE; execução antiga na fila = SUPERSEDED")

    def test_s7_post_promotion_propagation_and_errors(self):
        cmd = verify_cmd(self.canon["Verify exact trust and artifact readback"]["run"])
        env = {"CLOUDFLARE_API_TOKEN": "sim-token", "CLOUDFLARE_ACCOUNT_ID": "sim-account", "SOURCE_SHA": self.fx.T}
        step = {"run": cmd}
        T, L = self.fx.T, self.fx.L
        cases = {
            "propagação lenta (L,L,L,T)": ({"readback": [L, L, L, T], "cf": T}, 0),
            "readback preso na versão antiga": ({"readback": L, "cf": T}, 1),
            "Cloudflare marca outra versão": ({"readback": T, "cf": L}, 1),
            "serviço respondeu 503": ({"readback": "http500", "cf": T}, 1),
            "API Cloudflare fora do ar": ({"readback": T, "cf": "unreachable"}, 2),
            "rede do observador falhou": ({"readback": "unreachable", "cf": T}, 2),
        }
        summary = []
        for label, (state, code) in cases.items():
            r = self.sim.run(step, state, env=env)
            self.assertEqual(r["code"], code, f"{label}: {r['out']}")
            summary.append(f"{label}={r['outputs'].get('state')}")
        self.log("S7 pós-promoção do painel (comando real)", "; ".join(summary))

    def test_s8_central_unproven_never_rolls_back_fail_always_does(self):
        cmd = verify_cmd(self.central_verify["run"])
        env = {"CLOUDFLARE_API_TOKEN": "sim-token", "CLOUDFLARE_ACCOUNT_ID": "sim-account", "TARGET_RUNTIME_SHA": self.fx.T}
        T, L = self.fx.T, self.fx.L
        r_gap = self.sim.run({"run": cmd}, {"readback": T, "cf": "unreachable"}, env=env)
        self.assertEqual((r_gap["code"], r_gap["outputs"].get("state")), (0, "NAO_COMPROVADO"), r_gap["out"])
        r_fail = self.sim.run({"run": cmd}, {"readback": L, "cf": T}, env=env)
        self.assertEqual((r_fail["code"], r_fail["outputs"].get("state")), (1, "FAIL"), r_fail["out"])
        self.log("S8 central", "API indisponível -> passo verde (state=NAO_COMPROVADO) -> rollback NÃO roda, gate reprova; versão errada -> passo falha -> rollback roda")

    def test_s9_production_unreadable(self):
        r, dispatched = self.requester(self.fx.T, "unreachable")
        self.assertEqual(r["code"], 1)
        self.assertIn("production_version_unknown", r["out"])
        self.assertEqual(dispatched, [])
        c = self.canonical(self.fx.T, "unreachable", "unreachable")
        self.assertEqual(c["code"], 1)
        self.log("S9 produção ilegível", "t2 recusa sem pedir; canônico recusa avanço; só o rollback do proprietário age")


if __name__ == "__main__":
    unittest.main(verbosity=2)
