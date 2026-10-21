"""Offline execution tests for B01. Every Cloudflare-facing command is replaced."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "sandbox/rollback-secret-probe/run-probe.sh"
WORKER = ROOT / "sandbox/rollback-secret-probe/worker.mjs"
CONFIG = ROOT / "sandbox/rollback-secret-probe/wrangler.toml"
WORKFLOW = ROOT / ".github/workflows/b01-rollback-secret-probe.yml"
NONCE = "zevanory-b01-rollback-secret-probe-v1:"


def bash_path() -> str:
    found = shutil.which("bash")
    if found:
        return found
    windows = Path("C:/Program Files/Git/bin/bash.exe")
    if windows.exists():
        return str(windows)
    raise unittest.SkipTest("bash unavailable")


def msys_path(path: Path) -> str:
    value = str(path.resolve()).replace("\\", "/")
    if len(value) > 2 and value[1] == ":":
        return "/" + value[0].lower() + value[2:]
    return value


NPX = r'''#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_LOG"
args=" $* "
if [[ "$args" == *" deploy "* ]]; then
  touch "$FAKE_STATE/code-deployed"
  printf 'https://zevanory-rollback-secret-probe.unit.workers.dev\n'
  [[ "$FAKE_SCENARIO" != "deploy_error" ]] || exit 17
elif [[ "$args" == *" secret put "* ]]; then
  value="$(cat)"
  count=0
  [[ -f "$FAKE_STATE/put-count" ]] && count="$(cat "$FAKE_STATE/put-count")"
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_STATE/put-count"
  if [[ "$count" == 1 ]]; then
    printf '%s' "$value" > "$FAKE_STATE/secret-a"
    printf '%s' "$value" > "$FAKE_STATE/current-secret"
    printf 'version-a' > "$FAKE_STATE/current-version"
  else
    printf '%s' "$value" > "$FAKE_STATE/secret-b"
    printf '%s' "$value" > "$FAKE_STATE/current-secret"
    printf 'version-b' > "$FAKE_STATE/current-version"
  fi
elif [[ "$args" == *" rollback version-a "* ]]; then
  [[ "$FAKE_SCENARIO" != "rollback_noop" ]] || exit 0
  if [[ "$FAKE_SCENARIO" == "version_mismatch" ]]; then
    cp "$FAKE_STATE/secret-a" "$FAKE_STATE/current-secret"; exit 0
  fi
  printf 'version-a' > "$FAKE_STATE/current-version"
  if [[ "$FAKE_SCENARIO" == "pass" || "$FAKE_SCENARIO" == "cleanup_error" ]]; then
    cp "$FAKE_STATE/secret-a" "$FAKE_STATE/current-secret"
  fi
elif [[ "$args" == *" create "* || "$args" == *" delete --force"* || "$args" == *"delete zevanory"* ]]; then
  echo "FORBIDDEN_WORKER_CREATE_OR_DELETE:$*" >&2; exit 92
elif [[ "$args" == *" secret delete PROBE_SECRET "* ]]; then
  [[ "$FAKE_SCENARIO" != "cleanup_error" ]] || exit 23
  touch "$FAKE_STATE/cleaned"
  # cleanup_ghost: o comando diz sucesso, mas o segredo continua sendo servido.
  [[ "$FAKE_SCENARIO" == "cleanup_ghost" ]] || rm -f "$FAKE_STATE/current-secret"
else
  echo "UNEXPECTED_NPX:$*" >&2
  exit 90
fi
'''

CURL = r'''#!/usr/bin/env bash
set -eu
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    --header|-H|--connect-timeout|--max-time|--write-out|-w) shift 2 ;;
    --silent|--show-error|-s|-S|-sS) shift ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$output" && -n "$url" ]]
if [[ "$url" == *"/deployments" ]]; then
  if [[ "$FAKE_SCENARIO" == "not_precreated" ]]; then
    printf '{"success":false}' > "$output"; printf '404'; exit 0
  fi
  version="$(cat "$FAKE_STATE/current-version")"
  if [[ "$FAKE_SCENARIO" == "precheck_empty" && "$version" == "version-0" ]]; then
    printf '{"success":true,"result":{"deployments":[]}}' > "$output"; printf '200'; exit 0
  fi
  case "${FAKE_DEPLOY_SHAPE:-ok}" in
    ok) printf '{"result":{"deployments":[{"versions":[{"version_id":"%s","percentage":100}]}]}}' "$version" > "$output" ;;
    no_percentage) printf '{"result":{"deployments":[{"versions":[{"version_id":"%s"}]}]}}' "$version" > "$output" ;;
    two_at_100) printf '{"result":{"deployments":[{"versions":[{"version_id":"%s","percentage":100},{"version_id":"other","percentage":100}]}]}}' "$version" > "$output" ;;
    stale_first) printf '{"result":{"deployments":[{"versions":[{"version_id":"other","percentage":100}]},{"versions":[{"version_id":"%s","percentage":100}]}]}}' "$version" > "$output" ;;
  esac
  printf '200'
elif [[ "$url" == *"/probe" ]]; then
  if [[ "$FAKE_SCENARIO" == "http_error" ]]; then
    printf 'unavailable' > "$output"
    printf '503'
  elif [[ ! -f "$FAKE_STATE/current-secret" ]]; then
    printf 'probe secret unavailable' > "$output"
    printf '503'
  else
    secret="$(cat "$FAKE_STATE/current-secret")"
    printf '%s' "zevanory-b01-rollback-secret-probe-v1:${secret}" | openssl dgst -sha256 -r | awk '{print $1}' > "$output"
    printf '200'
  fi
else
  echo "UNEXPECTED_CURL:$url" >&2
  exit 91
fi
'''


class ProbeExecutionTests(unittest.TestCase):
    def run_probe(self, scenario="pass", *, token="offline-token", worker_name=None, deploy_shape="ok", account_id="1b26415802588185a86c1d4d3ebf5bdb"):
        # Keep Windows sandbox tests inside the writable checkout instead of the
        # host-wide TEMP directory, which may be read-only to the test process.
        temporary = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        fake_bin = base / "bin"
        state = base / "state"
        runner_tmp = base / "tmp"
        fake_bin.mkdir()
        state.mkdir()
        runner_tmp.mkdir()
        # O Worker de prova já existe (criado pelo proprietário no painel), servindo a versão inicial.
        (state / "current-version").write_text("version-0", encoding="utf-8")
        for name, source in (("npx", NPX), ("curl", CURL)):
            path = fake_bin / name
            path.write_text(textwrap.dedent(source), encoding="utf-8", newline="\n")
            path.chmod(0o755)
        log = base / "calls.log"
        env = dict(os.environ)
        env.update({
            "PATH": str(fake_bin) + os.pathsep + env.get("PATH", ""),
            "FAKE_LOG": str(log),
            "FAKE_STATE": str(state),
            "FAKE_SCENARIO": scenario,
            "FAKE_DEPLOY_SHAPE": deploy_shape,
            "GITHUB_RUN_ID": "4242",
            "CLOUDFLARE_SANDBOX_PROBE_TOKEN": token,
            "CLOUDFLARE_ACCOUNT_ID": account_id,
            "PROBE_ATTEMPTS": "1",
            "PROBE_SLEEP_SECONDS": "0",
            "RUNNER_TEMP": str(runner_tmp),
            "NPX_BIN": msys_path(fake_bin / "npx"),
            "CURL_BIN": msys_path(fake_bin / "curl"),
            "PYTHON_BIN": msys_path(Path(sys.executable)),
        })
        if worker_name is not None:
            env["WORKER_NAME"] = worker_name
        completed = subprocess.run(
            [bash_path(), str(RUNNER)], cwd=ROOT, env=env,
            text=True, capture_output=True, timeout=30,
        )
        calls = log.read_text(encoding="utf-8") if log.exists() else ""
        return completed, state, calls

    def test_pass_restores_version_and_secret_value(self):
        completed, state, calls = self.run_probe("pass")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=YES", completed.stdout)
        self.assertTrue((state / "cleaned").exists())
        self.assertIn("rollback version-a", calls)
        self.assertNotIn((state / "secret-a").read_text(), completed.stdout + completed.stderr)
        self.assertNotIn((state / "secret-b").read_text(), completed.stdout + completed.stderr)

    def test_no_when_version_a_has_digest_b(self):
        completed, state, _ = self.run_probe("no")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=NO", completed.stdout)
        self.assertNotIn("INCONCLUSIVE", completed.stdout)
        self.assertEqual((state / "current-version").read_text(), "version-a")
        import re as _re
        b = _re.search(r"PROBE_B_DIGEST=([0-9a-f]{64})", completed.stdout).group(1)
        after = _re.search(r"PROBE_AFTER_ROLLBACK_DIGEST=([0-9a-f]{64})", completed.stdout).group(1)
        self.assertEqual(after, b, "depois do rollback para A, o digest servido ainda é o de B")
        self.assertTrue((state / "cleaned").exists())
        self.assertFalse((state / "current-secret").exists(), "limpeza certificada removeu o segredo de prova")

    def test_non_200_probe_fails_closed(self):
        completed, state, _ = self.run_probe("http_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("PROBE_HTTP_STATUS=503", completed.stderr)
        # Falha de infraestrutura não é resposta negativa (contestação Claude 21/10).
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        self.assertNotIn("ROLLBACK_SECRET_VALUE_RESTORED=NO", completed.stdout)
        self.assertTrue((state / "cleaned").exists())

    def test_rollback_that_did_not_take_effect_is_inconclusive_not_no(self):
        # Versão ativa continua B servindo digest B: o rollback não aconteceu, então não há resposta.
        completed, state, _ = self.run_probe("rollback_noop")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        self.assertEqual((state / "current-version").read_text(), "version-b")

    def test_digest_a_without_version_a_is_not_yes(self):
        completed, _, _ = self.run_probe("version_mismatch")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)

    def test_default_wait_covers_first_workers_dev_propagation(self):
        import re as _re
        m = _re.search(r'PROBE_ATTEMPTS:-(\d+)', RUNNER.read_text(encoding="utf-8"))
        self.assertIsNotNone(m)
        self.assertGreaterEqual(int(m.group(1)), 30)

    def test_cleanup_failure_never_reports_yes(self):
        completed, _, _ = self.run_probe("cleanup_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertNotIn("ROLLBACK_SECRET_VALUE_RESTORED=YES", completed.stdout)
        self.assertIn("B01_CLEANUP_FAILED=1", completed.stderr)

    def test_active_version_shapes_that_prove_nothing_are_inconclusive(self):
        # Sol 028.5: percentual ausente, duas versões a 100% ou deployment antigo na frente => sem prova.
        for shape in ("no_percentage", "two_at_100", "stale_first"):
            completed, _, _ = self.run_probe("pass", deploy_shape=shape)
            self.assertNotEqual(completed.returncode, 0, shape)
            self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout, shape)

    def test_production_or_invalid_account_is_refused_before_any_write(self):
        # Recomendação Sol 029: a conta de produção Zevanory nunca recebe o ensaio.
        # Determinação do proprietário 21/10 13:06: só a conta Zevanory; qualquer outra é recusada.
        for account, marker in (("0123456789abcdef0123456789abcdef", "CLOUDFLARE_ACCOUNT_ID_REFUSED"),
                                ("", "CLOUDFLARE_ACCOUNT_ID_REFUSED")):
            completed, state, calls = self.run_probe(account_id=account)
            self.assertNotEqual(completed.returncode, 0, account)
            self.assertIn(marker, completed.stderr, account)
            self.assertEqual(calls, "", account)
            self.assertFalse((state / "code-deployed").exists(), account)
            self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout, account)

    def test_missing_precreated_worker_is_refused_without_creating_one(self):
        completed, state, calls = self.run_probe("not_precreated")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("PROBE_WORKER_NOT_PRECREATED_OR_NO_ACCESS_HTTP_404", completed.stderr)
        self.assertEqual(calls, "", "nenhum comando wrangler pode rodar")
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)

    def test_precheck_200_with_empty_deployments_is_refused_before_any_write(self):
        # Melhoria Sol 031: HTTP 200 sozinho não comprova Worker com deployment válido.
        completed, state, calls = self.run_probe("precheck_empty")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("PROBE_WORKER_PRECHECK_STRUCTURE_INVALID", completed.stderr)
        self.assertEqual(calls, "", "nenhum comando wrangler antes da pré-checagem estrutural")
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)

    def test_cleanup_success_message_without_probe_503_is_not_certified(self):
        # Melhoria Sol 031: "secret delete" com sucesso, mas o segredo segue servido => não certificado.
        for scenario in ("cleanup_ghost",):
            completed, _, _ = self.run_probe(scenario)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("B01_CLEANUP_NOT_CERTIFIED", completed.stderr)
            self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)

    def test_pass_certifies_cleanup_by_probe_503(self):
        completed, state, _ = self.run_probe("pass")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("B01_CLEANUP_CERTIFIED=probe_503", completed.stdout + completed.stderr)
        self.assertFalse((state / "current-secret").exists())

    def test_invalid_worker_name_is_refused_before_write(self):
        completed, state, calls = self.run_probe(worker_name="zevanory")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("WORKER_NAME_REFUSED", completed.stderr)
        self.assertEqual(calls, "")
        self.assertFalse((state / "code-deployed").exists())

    def test_missing_token_fails_closed_before_write(self):
        completed, state, calls = self.run_probe(token="")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING", completed.stderr)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        self.assertEqual(calls, "")
        self.assertFalse((state / "code-deployed").exists())

    def test_cleanup_runs_after_post_deploy_failure(self):
        completed, state, calls = self.run_probe("http_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue((state / "cleaned").exists())
        self.assertIn(" secret delete PROBE_SECRET ", " " + calls)

    def test_cleanup_runs_after_ambiguous_deploy_failure(self):
        completed, state, calls = self.run_probe("deploy_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        # deploy de código falhou antes de qualquer segredo: nada a neutralizar, e nunca apagar o Worker.
        self.assertNotIn("delete", calls)
        self.assertNotIn("FORBIDDEN", completed.stderr)


class StaticContractTests(unittest.TestCase):
    def test_workflow_is_manual_and_least_privilege(self):
        workflow = json.loads(WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(workflow["on"], {"workflow_dispatch": {}})
        self.assertEqual(workflow["concurrency"], {
            "group": "b01-rollback-secret-probe",
            "cancel-in-progress": False,
        })
        # actions: read só para o guard de execução única ler os runs deste workflow (Sol 028.6).
        self.assertEqual(workflow["permissions"], {"contents": "read", "actions": "read"})
        job = workflow["jobs"]["probe"]
        self.assertEqual(
            job["if"],
            "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/gh-pages' && github.run_attempt == 1",
        )
        self.assertEqual(job["environment"], {"name": "sandbox-financial-approved"})
        self.assertEqual(set(job["env"]), {"CLOUDFLARE_SANDBOX_PROBE_TOKEN", "CLOUDFLARE_ACCOUNT_ID"})
        self.assertEqual(job["env"]["CLOUDFLARE_ACCOUNT_ID"], "1b26415802588185a86c1d4d3ebf5bdb")
        self.assertEqual(job["env"]["CLOUDFLARE_SANDBOX_PROBE_TOKEN"],
                         "${{ secrets.CLOUDFLARE_SANDBOX_PROBE_TOKEN }}")
        guard = job["steps"][1]
        self.assertEqual(guard["run"], "bash sandbox/rollback-secret-probe/single-run-guard.sh")
        self.assertLess(1, [s.get("id") for s in job["steps"]].index("probe"), "o guard roda antes de qualquer escrita")
        cleanup = job["steps"][-1]
        self.assertEqual(cleanup["if"], "${{ always() }}")
        self.assertEqual(cleanup["run"], "bash sandbox/rollback-secret-probe/cleanup-only.sh")

    def test_worker_has_only_probe_digest_and_no_routes(self):
        worker = WORKER.read_text(encoding="utf-8")
        config = CONFIG.read_text(encoding="utf-8")
        self.assertIn('url.pathname !== "/probe"', worker)
        self.assertIn('crypto.subtle.digest("SHA-256"', worker)
        self.assertIn("NONCE + env.PROBE_SECRET", worker)
        self.assertIn('return new Response(hex(digest) + "\\n"', worker)
        self.assertNotIn("new Response(env.PROBE_SECRET", worker)
        self.assertNotIn("console.", worker)
        self.assertIn("workers_dev = true", config)
        self.assertNotRegex(config, r"(?m)^\s*routes?\s*=")

    def test_runner_validates_name_before_first_npx(self):
        source = RUNNER.read_text(encoding="utf-8")
        first_deploy = source.index('"$NPX_BIN" --yes "$WRANGLER" deploy')
        self.assertLess(source.index('validate_worker_name || fail "WORKER_NAME_REFUSED"'), first_deploy)
        self.assertIn('[[ "$WORKER_NAME" == "$PROBE_WORKER" ]]', source)
        self.assertIn('readonly PROBE_WORKER="zevanory-rollback-secret-probe"', source)
        # Nunca cria nem apaga Worker: só neutraliza o segredo de prova.
        self.assertNotRegex(source, r'wrangler[^\n]*"?\$WRANGLER"? delete')
        self.assertNotIn(" delete \"$WORKER_NAME\"", source)
        self.assertIn("secret delete PROBE_SECRET", source)
        self.assertLess(source.index("PROBE_WORKER_NOT_PRECREATED"), first_deploy, "pré-checagem de existência antes do deploy")
        deployments_endpoint = "/workers/scripts/${WORKER_NAME}/deployments"
        precheck_block = source[source.index("# Pré-condição"):first_deploy]
        self.assertIn(deployments_endpoint, precheck_block,
                      "a pré-checagem anterior ao deploy deve consultar exatamente /deployments")


if __name__ == "__main__":
    unittest.main()


GUARD = ROOT / "sandbox/rollback-secret-probe/single-run-guard.sh"
GUARD_CURL = r'''#!/usr/bin/env bash
set -eu
output=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in --output|-o) output="$2"; shift 2 ;; --header|-H|--connect-timeout|--max-time|--write-out|-w) shift 2 ;; *) shift ;; esac
done
printf '%s' "$FAKE_RUNS_JSON" > "$output"
printf '%s' "${FAKE_HTTP:-200}"
'''


class SingleRunGuardTests(unittest.TestCase):
    def guard(self, runs_json, http="200"):
        tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(tmp.cleanup)
        curl = Path(tmp.name) / "curl"
        curl.write_text(GUARD_CURL, encoding="utf-8", newline="\n")
        curl.chmod(0o755)
        env = dict(os.environ, CURL_BIN=msys_path(curl), PYTHON_BIN=msys_path(Path(sys.executable)),
                   GITHUB_TOKEN="offline", GITHUB_REPOSITORY="o/r", GITHUB_RUN_ID="100",
                   FAKE_RUNS_JSON=runs_json, FAKE_HTTP=http)
        return subprocess.run([bash_path(), str(GUARD)], cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)

    def test_first_ever_run_passes(self):
        p = self.guard(json.dumps({"total_count": 1, "workflow_runs": [{"id": 100}]}))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("SINGLE_RUN_GUARD=PASS prior_runs=0", p.stdout)

    def test_second_manual_dispatch_is_refused(self):
        p = self.guard(json.dumps({"total_count": 2, "workflow_runs": [{"id": 100}, {"id": 99}]}))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SINGLE_RUN_GUARD_REFUSED prior_runs=1", p.stderr)

    def test_api_failure_and_bad_or_truncated_response_fail_closed(self):
        # HTTP != 200 falha mesmo com corpo que, sozinho, passaria.
        ok_body = json.dumps({"total_count": 1, "workflow_runs": [{"id": 100}]})
        p = self.guard(ok_body, http="403")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SINGLE_RUN_GUARD_HTTP_403", p.stderr)
        self.assertNotEqual(self.guard(json.dumps({"workflow_runs": []})).returncode, 0)
        self.assertNotEqual(self.guard(json.dumps({"total_count": 150, "workflow_runs": [{"id": 100}]})).returncode, 0)


class CleanupOnlyAccountGuardTests(unittest.TestCase):
    def test_cleanup_only_acts_on_the_zevanory_account(self):
        tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        log = base / "npx.log"
        npx = base / "npx"
        npx.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n', encoding="utf-8", newline="\n")
        npx.chmod(0o755)
        for account, marker in (("0123456789abcdef0123456789abcdef", "CLOUDFLARE_ACCOUNT_ID_REFUSED"),
                                ("", "CLOUDFLARE_ACCOUNT_ID_REFUSED")):
            env = dict(os.environ, PATH=str(base) + os.pathsep + os.environ.get("PATH", ""), FAKE_LOG=str(log),
                       GITHUB_RUN_ID="4242", CLOUDFLARE_SANDBOX_PROBE_TOKEN="offline", CLOUDFLARE_ACCOUNT_ID=account)
            p = subprocess.run([bash_path(), str(ROOT / "sandbox/rollback-secret-probe/cleanup-only.sh")],
                               cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(p.returncode, 0, account)
            self.assertIn(marker, p.stderr, account)
            self.assertFalse(log.exists(), "npx não pode ser chamado")

    def test_cleanup_neutralizes_secret_without_deleting_worker(self):
        tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        log = base / "npx.log"
        npx = base / "npx"
        npx.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n',
                       encoding="utf-8", newline="\n")
        npx.chmod(0o755)
        env = dict(os.environ, PATH=str(base) + os.pathsep + os.environ.get("PATH", ""), FAKE_LOG=str(log),
                   GITHUB_RUN_ID="4242", CLOUDFLARE_SANDBOX_PROBE_TOKEN="offline",
                   CLOUDFLARE_ACCOUNT_ID="1b26415802588185a86c1d4d3ebf5bdb")
        p = subprocess.run([bash_path(), str(ROOT / "sandbox/rollback-secret-probe/cleanup-only.sh")],
                           cwd=ROOT, env=env, text=True, capture_output=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        calls = log.read_text(encoding="utf-8")
        self.assertIn("secret delete PROBE_SECRET", calls)
        self.assertNotIn(" delete zevanory-rollback-secret-probe ", " " + calls + " ")
