"""Ordem 046 R2 (Sol): recuperação depois de um retorno automático (Cloudflare 10215).

Executa, sem rede e sem credencial, o script ÚNICO de recuperação (scripts/ops/worker-version-recover.sh)
e o ensaio que o certifica no Worker descartável (sandbox/rollback-secret-probe/run-recovery-probe.sh),
contra uma Cloudflare simulada que modela versões numeradas, versão ativa, rollback e a regra 10215
(secret put/delete recusados quando a versão mais recente não está implantada).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
RECOVER = ROOT / "scripts/ops/worker-version-recover.sh"
PROBE = ROOT / "sandbox/rollback-secret-probe/run-recovery-probe.sh"
GUARD = ROOT / "sandbox/rollback-secret-probe/single-run-guard.sh"
CLEANUP = ROOT / "sandbox/rollback-secret-probe/cleanup-only.sh"
WORKFLOW = ROOT / ".github/workflows/b01-recovery-probe.yml"
NONCE = "zevanory-b01-rollback-secret-probe-v1:"
ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"


def vid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


# Cloudflare simulada. Estado: {"versions": [{"id","number","secret"}], "active": id}.
FAKE_NPX = r'''#!/usr/bin/env python3
import json, os, sys
STATE = os.environ["FAKE_STATE"]; SC = os.environ.get("FAKE_SCENARIO", "pass")
args = sys.argv[1:]
open(os.environ["FAKE_LOG"], "a").write(" ".join(args) + "\n")
st = json.load(open(STATE))
def save(): json.dump(st, open(STATE, "w"))
def latest(): return max(st["versions"], key=lambda v: v["number"])
def active(): return next(v for v in st["versions"] if v["id"] == st["active"])
def new_version(secret):
    n = latest()["number"] + 1
    v = {"id": "%08x-0000-4000-8000-000000000000" % n, "number": n, "secret": secret}
    st["versions"].append(v); st["active"] = v["id"]; save()
def refuse_10215():
    if SC == "put_c_text_only" and a[:2] == ["secret", "put"]:
        # Forma observada no run 39674768070: o put recusado não trouxe o código numérico.
        print("X [ERROR] Secret edit failed. You attempted to modify a secret, but the latest version of your Worker isn't currently deployed.", file=sys.stderr)
        sys.exit(1)
    print("X [ERROR] A request to the Cloudflare API failed. Secret edit not allowed while latest version is not deployed [code: 10215]", file=sys.stderr)
    sys.exit(1)
a = args[args.index("wrangler@4.143.0") + 1:] if "wrangler@4.143.0" in args else args
if a[:1] == ["deploy"]:
    new_version(active()["secret"]); print("https://zevanory-rollback-secret-probe.unit.workers.dev")
elif a[:2] == ["secret", "put"]:
    value = sys.stdin.read()
    if st["active"] != latest()["id"] and SC == "put_c_refused_but_applied":
        prev = st["active"]; new_version(value); st["active"] = prev; save(); refuse_10215()
    if st["active"] != latest()["id"] and SC == "put_c_refused_digest_changed":
        active()["secret"] = value; save(); refuse_10215()
    if SC == "put_c_other_error" and st["active"] != latest()["id"]:
        print("X [ERROR] Authentication error [code: 10000]", file=sys.stderr); sys.exit(1)
    if st["active"] != latest()["id"] and SC != "put_c_accepted":
        refuse_10215()
    new_version(value)
elif a[:2] == ["secret", "delete"]:
    if st["active"] != latest()["id"]:
        refuse_10215()
    new_version(None)
elif a[:1] == ["rollback"]:
    if SC != "rollback_noop":
        st["active"] = a[1]; save()
elif a[:2] == ["versions", "deploy"]:
    target = a[2].split("@")[0]
    if SC == "deploy_noop":
        sys.exit(0)
    if SC == "deploy_other":
        st["active"] = st["versions"][0]["id"]; save(); sys.exit(0)
    st["active"] = target; save()
    if SC == "deploy_fails_but_applied":
        sys.exit(1)
else:
    print("UNEXPECTED_NPX " + " ".join(args), file=sys.stderr); sys.exit(90)
'''

FAKE_CURL = r'''#!/usr/bin/env python3
import hashlib, json, os, sys
a = sys.argv[1:]
out = a[a.index("--output") + 1]
url = [x for x in a if x.startswith("http")][-1]
st = json.load(open(os.environ["FAKE_STATE"]))
SC = os.environ.get("FAKE_SCENARIO", "pass")
def emit(code, body):
    open(out, "w").write(body if isinstance(body, str) else json.dumps(body)); print(code, end="")
if url.endswith("/deployments"):
    if SC == "gradual":
        emit("200", {"result": {"deployments": [{"versions": [{"version_id": st["active"], "percentage": 60}, {"version_id": "x", "percentage": 40}]}]}})
    elif SC == "ninety_nine":
        emit("200", {"result": {"deployments": [{"versions": [{"version_id": st["active"], "percentage": 99}]}]}})
    else:
        emit("200", {"result": {"deployments": [{"versions": [{"version_id": st["active"], "percentage": 100}]}]}})
elif url.endswith("/versions"):
    if SC == "versions_500":
        emit("500", {}); sys.exit(0)
    items = [{"id": v["id"], "number": v["number"]} for v in sorted(st["versions"], key=lambda v: -v["number"])]
    emit("200", {"result": {"items": items}})
elif url.endswith("/probe"):
    cur = next(v for v in st["versions"] if v["id"] == st["active"])
    if not cur["secret"]:
        emit("503", "probe secret unavailable\n")
    else:
        emit("200", hashlib.sha256(("zevanory-b01-rollback-secret-probe-v1:" + cur["secret"]).encode()).hexdigest() + "\n")
else:
    print("UNEXPECTED_CURL " + url, file=sys.stderr); sys.exit(91)
'''


def bash() -> str:
    found = shutil.which("bash")
    if not found:
        raise unittest.SkipTest("bash ausente")
    return found


class FakeCloudflare:
    def __init__(self, test: unittest.TestCase, versions, active, scenario="pass"):
        tmp = tempfile.TemporaryDirectory(dir=ROOT)
        test.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name, src in (("npx", FAKE_NPX), ("curl", FAKE_CURL)):
            p = self.bin / name
            p.write_text(textwrap.dedent(src), encoding="utf-8")
            p.chmod(0o755)
        self.state = self.base / "state.json"
        self.state.write_text(json.dumps({"versions": versions, "active": active}))
        self.log = self.base / "calls.log"
        self.scenario = scenario

    def env(self, **extra):
        env = dict(os.environ)
        env.update({
            "PATH": f"{self.bin}{os.pathsep}{env.get('PATH', '')}",
            "FAKE_STATE": str(self.state), "FAKE_LOG": str(self.log), "FAKE_SCENARIO": self.scenario,
            "NPX_BIN": str(self.bin / "npx"), "CURL_BIN": str(self.bin / "curl"),
            "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "RUNNER_TEMP": str(self.base), "GITHUB_RUN_ID": "4242",
        })
        env.update(extra)
        return env

    def run(self, script, **extra):
        return subprocess.run([bash(), str(script)], cwd=ROOT, env=self.env(**extra), text=True, capture_output=True, timeout=60)

    @property
    def st(self):
        return json.loads(self.state.read_text())

    @property
    def calls(self):
        return self.log.read_text() if self.log.exists() else ""


@unittest.skipUnless(shutil.which("jq"), "jq ausente")
class RecoverScriptTests(unittest.TestCase):
    # Estado típico depois do retorno automático: P (681, token antigo) ativa; N (682, token novo) a mais recente.
    P, N = vid(681), vid(682)

    def cf(self, scenario="pass", active=None):
        versions = [{"id": self.P, "number": 681, "secret": "old"}, {"id": self.N, "number": 682, "secret": "new"}]
        return FakeCloudflare(self, versions, active or self.P, scenario)

    def recover(self, cf, target=None, worker="zevanory", **extra):
        extra.setdefault("CLOUDFLARE_API_TOKEN", " tok\n")
        extra.setdefault("RECOVER_EXPECTED_ACTIVE", self.P)
        return cf.run(RECOVER, RECOVER_WORKER_NAME=worker, RECOVER_TARGET_VERSION=target or self.N, **extra)

    def test_deploys_the_latest_version_and_certifies_by_readback(self):
        cf = self.cf()
        p = self.recover(cf)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn(f"RECOVER_READBACK=PASS active={self.N}", p.stdout)
        self.assertEqual(cf.st["active"], self.N)
        self.assertIn(f"versions deploy {self.N}@100 --name zevanory", cf.calls)
        self.assertNotIn("secret", cf.calls, "a recuperação nunca toca em segredo")

    def test_command_error_with_applied_deploy_is_decided_by_readback(self):
        cf = self.cf("deploy_fails_but_applied")
        p = self.recover(cf)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("RECOVER_DEPLOY_COMMAND_FAILED=1", p.stdout)
        self.assertIn("RECOVER_READBACK=PASS", p.stdout)

    def test_refusals_before_any_write(self):
        cases = {
            "target_not_latest": (dict(target=vid(679)), "RECOVER_TARGET_NOT_LATEST"),
            "invalid_target": (dict(target="abc"), "RECOVER_TARGET_INVALID"),
            "worker_not_allowed": (dict(worker="zevanory-sales-public"), "RECOVER_WORKER_REFUSED"),
            "wrong_account": (dict(CLOUDFLARE_ACCOUNT_ID="0" * 32), "RECOVER_ACCOUNT_REFUSED"),
            "no_token": (dict(CLOUDFLARE_API_TOKEN=""), "RECOVER_TOKEN_MISSING"),
            # Contestação bloqueante Sol 047: a recuperação fica presa ao ROLLBACK_POINT do incidente.
            "rollback_point_missing": (dict(RECOVER_EXPECTED_ACTIVE=""), "RECOVER_ROLLBACK_POINT_INVALID"),
            "rollback_point_invalid": (dict(RECOVER_EXPECTED_ACTIVE="681"), "RECOVER_ROLLBACK_POINT_INVALID"),
            "target_equals_rollback_point": (dict(RECOVER_EXPECTED_ACTIVE=vid(682)), "RECOVER_TARGET_EQUALS_ROLLBACK_POINT"),
            "active_is_not_the_incident_rollback_point": (dict(RECOVER_EXPECTED_ACTIVE=vid(680)), "RECOVER_ACTIVE_NOT_ROLLBACK_POINT"),
        }
        for name, (kw, marker) in cases.items():
            cf = self.cf()
            p = self.recover(cf, **kw)
            self.assertNotEqual(p.returncode, 0, name)
            self.assertIn(marker, p.stderr, name)
            self.assertNotIn("versions deploy", cf.calls, name)
            self.assertEqual(cf.st["active"], self.P, name)

    def test_unprovable_state_is_refused_before_any_write(self):
        for scenario, marker in (("gradual", "RECOVER_ACTIVE_NOT_RESOLVABLE"), ("ninety_nine", "RECOVER_ACTIVE_NOT_RESOLVABLE"),
                                 ("versions_500", "RECOVER_VERSIONS_HTTP")):
            cf = self.cf(scenario)
            p = self.recover(cf)
            self.assertNotEqual(p.returncode, 0, scenario)
            self.assertIn(marker, p.stderr, scenario)
            self.assertNotIn("versions deploy", cf.calls, scenario)

    def test_target_already_active_is_nothing_to_do(self):
        cf = self.cf(active=self.N)
        p = self.recover(cf)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("RECOVER_NOTHING_TO_DO", p.stderr)
        self.assertNotIn("versions deploy", cf.calls)

    def test_deploy_without_effect_or_to_another_version_fails(self):
        for scenario in ("deploy_noop", "deploy_other"):
            cf = self.cf(scenario)
            p = self.recover(cf)
            self.assertNotEqual(p.returncode, 0, scenario)
            self.assertIn("RECOVER_READBACK_FAIL", p.stderr, scenario)
            self.assertNotIn("RECOVER_READBACK=PASS", p.stdout, scenario)


@unittest.skipUnless(shutil.which("jq") and shutil.which("openssl"), "jq/openssl ausentes")
class RecoveryProbeTests(unittest.TestCase):
    def probe(self, scenario="pass", token="probe-token"):
        # Worker de prova pré-criado, sem segredo (estado deixado pela limpeza do ensaio 3).
        cf = FakeCloudflare(self, [{"id": vid(10), "number": 10, "secret": None}], vid(10), scenario)
        p = cf.run(PROBE, CLOUDFLARE_SANDBOX_PROBE_TOKEN=token, PROBE_ATTEMPTS="1", PROBE_SLEEP_SECONDS="0")
        return p, cf

    def test_full_sequence_is_certified_and_cleaned(self):
        p, cf = self.probe()
        out = p.stdout + p.stderr
        self.assertEqual(p.returncode, 0, out)
        self.assertIn("CONDITION_10215=observed", out)
        self.assertIn("RECOVER_READBACK=PASS", out)
        self.assertIn("PROBE_RECOVERED_DIGEST=", out)
        self.assertIn("B01R_CLEANUP_CERTIFIED=probe_503", out)
        self.assertTrue(out.rstrip().endswith("RECOVERY_CERTIFIED=YES"), out)
        # Ordem observável: rollback -> put recusado -> versions deploy -> delete.
        calls = cf.calls
        self.assertLess(calls.index("rollback"), calls.index("versions deploy"))
        self.assertLess(calls.index("versions deploy"), calls.rindex("secret delete"))
        # O alvo implantado é a versão de B (a mesma impressa como VERSION_B).
        vb = [l.split("=", 1)[1] for l in out.splitlines() if l.startswith("VERSION_B=")][0]
        self.assertIn(f"versions deploy {vb}@100", calls)
        self.assertNotIn("create", calls)

    def test_official_10215_text_without_code_is_accepted_and_printed(self):
        p, cf = self.probe("put_c_text_only")
        out = p.stdout + p.stderr
        self.assertEqual(p.returncode, 0, out)
        self.assertIn("PUT_C_REFUSAL: X [ERROR] Secret edit failed.", out, "a recusa tem de aparecer no log")
        self.assertIn("CONDITION_10215=observed refusal=official_text active=VA latest=VB digest=A", out)
        self.assertTrue(out.rstrip().endswith("RECOVERY_CERTIFIED=YES"), out)
        p, _ = self.probe()
        self.assertIn("refusal=code", p.stdout)

    def test_probe_cleanup_recovers_from_10215_when_recovery_did_not_happen(self):
        # Run 39674768070: recuperação interrompida => a limpeza do próprio ensaio recebia 10215.
        p, cf = self.probe("put_c_other_error")
        out = p.stdout + p.stderr
        self.assertIn("B01R_CLEANUP_RETRY_AFTER_DEPLOY=1", out)
        self.assertIn("B01R_CLEANUP_CERTIFIED=probe_503", out)
        self.assertNotIn("B01R_CLEANUP_FAILED", out)
        self.assertIn("RECOVERY_CERTIFIED=INCONCLUSIVE", out)

    def test_refusal_text_is_not_enough_the_state_must_prove_it(self):
        # Recusa com 10215 no texto, mas o estado mudou: a mais recente deixou de ser VB, ou o Worker passou a
        # servir outro valor. Em ambos, a condição não está provada => INCONCLUSIVE, sem recuperação.
        for scenario, marker in (("put_c_refused_but_applied", "CONDITION_10215_STATE_"),
                                 ("put_c_refused_digest_changed", "CONDITION_10215_STATE_DIGEST_CHANGED")):
            p, cf = self.probe(scenario)
            out = p.stdout + p.stderr
            self.assertNotEqual(p.returncode, 0, scenario)
            self.assertIn(marker, out, scenario)
            self.assertNotIn("versions deploy", cf.calls, scenario)
            self.assertIn("RECOVERY_CERTIFIED=INCONCLUSIVE", out, scenario)

    def test_without_the_real_10215_condition_it_is_inconclusive(self):
        for scenario in ("put_c_accepted", "put_c_other_error"):
            p, _ = self.probe(scenario)
            out = p.stdout + p.stderr
            self.assertNotEqual(p.returncode, 0, scenario)
            self.assertIn("CONDITION_10215_NOT_REPRODUCED", out, scenario)
            if scenario == "put_c_accepted":
                self.assertIn("secret put aceito depois do rollback", out)
            self.assertIn("RECOVERY_CERTIFIED=INCONCLUSIVE", out, scenario)

    def test_failed_recovery_or_rollback_is_never_yes(self):
        for scenario, marker in (("deploy_noop", "RECOVER_READBACK_FAIL"), ("rollback_noop", "ROLLBACK_NOT_ACTIVE")):
            p, _ = self.probe(scenario)
            out = p.stdout + p.stderr
            self.assertNotEqual(p.returncode, 0, scenario)
            self.assertIn(marker, out, scenario)
            self.assertIn("RECOVERY_CERTIFIED=INCONCLUSIVE", out, scenario)

    def test_malformed_token_or_wrong_account_stops_before_any_call(self):
        p, cf = self.probe(token="bad token\"x")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("CLOUDFLARE_SANDBOX_PROBE_TOKEN_MALFORMED", p.stderr)
        self.assertEqual(cf.calls, "")

    def test_cleanup_only_resolves_10215_by_deploying_the_probe_code(self):
        # Estado do ensaio 3: rollback ativo (v11, com segredo), mais recente v12 não implantada.
        cf = FakeCloudflare(self, [{"id": vid(11), "number": 11, "secret": "a"}, {"id": vid(12), "number": 12, "secret": "b"}], vid(11))
        p = cf.run(CLEANUP, CLOUDFLARE_SANDBOX_PROBE_TOKEN="t", B01_SECRET_WRITTEN="1")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("B01_CLEANUP_RETRY_AFTER_DEPLOY=1", p.stdout)
        self.assertIn("B01_CLEANUP_DONE=YES", p.stdout)
        st = cf.st
        active = next(v for v in st["versions"] if v["id"] == st["active"])
        self.assertIsNone(active["secret"])
        self.assertEqual(st["active"], max(st["versions"], key=lambda v: v["number"])["id"])


class GuardAndWorkflowTests(unittest.TestCase):
    def guard(self, workflow, runs):
        with tempfile.TemporaryDirectory(dir=ROOT) as d:
            d = Path(d)
            body = d / "runs.json"
            body.write_text(json.dumps({"total_count": len(runs), "workflow_runs": [{"id": r} for r in runs]}))
            (d / "curl").write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > {d}/url\nwhile [ $# -gt 0 ]; do [ \"$1\" = --output ] && cp {body} \"$2\"; shift; done\nprintf 200\n")
            (d / "curl").chmod(0o755)
            env = {**os.environ, "CURL_BIN": str(d / "curl"), "PYTHON_BIN": sys.executable,
                   "GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "100"}
            args = [bash(), str(GUARD)] + ([workflow] if workflow else [])
            p = subprocess.run(args, env=env, text=True, capture_output=True)
            url = (d / "url").read_text() if (d / "url").exists() else ""
            return p, url

    def test_recovery_probe_has_its_own_single_run_quota(self):
        p, url = self.guard("b01-recovery-probe.yml", [100])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("/actions/workflows/b01-recovery-probe.yml/runs", url)
        # Cota 1: uma segunda execução depois do run 39674768070 (INCONCLUSIVE); a terceira é recusada.
        p, _ = self.guard("b01-recovery-probe.yml", [100, 99])
        self.assertEqual(p.returncode, 0, p.stderr)
        p, _ = self.guard("b01-recovery-probe.yml", [100, 99, 98])
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SINGLE_RUN_GUARD_REFUSED prior_runs=2 allowed=1", p.stderr)

    def test_original_probe_quota_is_unchanged_and_unknown_workflows_are_refused(self):
        p, url = self.guard(None, [100, 99, 98])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("/actions/workflows/b01-rollback-secret-probe.yml/runs", url)
        p, _ = self.guard(None, [100, 99, 98, 97])
        self.assertNotEqual(p.returncode, 0)
        p, _ = self.guard("mercadopago-production-token-rotate.yml", [100])
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SINGLE_RUN_GUARD_WORKFLOW_REFUSED", p.stderr)

    def test_workflow_is_manual_sandbox_only_and_shares_the_probe_lock(self):
        doc = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        on = doc.get("on", doc.get(True))
        self.assertEqual(on, {"workflow_dispatch": {}})
        self.assertEqual(doc["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(doc["concurrency"]["group"], "b01-rollback-secret-probe", "nunca junto com o ensaio B01")
        job = doc["jobs"]["recovery-probe"]
        self.assertEqual(job["environment"], {"name": "sandbox-financial-approved"})
        self.assertIn("github.run_attempt == 1", job["if"])
        self.assertNotIn("CLOUDFLARE_API_TOKEN", json.dumps(doc), "nunca o token de produção")
        steps = job["steps"]
        self.assertEqual(steps[1]["run"], "bash sandbox/rollback-secret-probe/single-run-guard.sh b01-recovery-probe.yml")
        self.assertEqual(steps[2]["run"], "bash sandbox/rollback-secret-probe/run-recovery-probe.sh")
        self.assertEqual(steps[3]["if"], "${{ always() }}")

    def test_probe_and_production_use_the_same_recovery_script(self):
        probe = PROBE.read_text(encoding="utf-8")
        self.assertIn('RECOVER_SCRIPT="${RECOVER_SCRIPT:-scripts/ops/worker-version-recover.sh}"', probe)
        rotate = (ROOT / ".github/workflows/mercadopago-production-token-rotate.yml").read_text(encoding="utf-8")
        self.assertIn("bash scripts/ops/worker-version-recover.sh", rotate)


if __name__ == "__main__":
    unittest.main()
