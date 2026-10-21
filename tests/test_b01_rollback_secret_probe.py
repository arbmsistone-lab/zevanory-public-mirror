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
  touch "$FAKE_STATE/worker-created"
  printf 'https://zevanory-rollback-secret-probe-%s.unit.workers.dev\n' "$GITHUB_RUN_ID"
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
elif [[ "$args" == *" delete "* ]]; then
  [[ "$FAKE_SCENARIO" != "cleanup_error" ]] || exit 23
  touch "$FAKE_STATE/cleaned"
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
  version="$(cat "$FAKE_STATE/current-version")"
  printf '{"result":{"deployments":[{"versions":[{"version_id":"%s","percentage":100}]}]}}' "$version" > "$output"
  printf '200'
elif [[ "$url" == *"/probe" ]]; then
  if [[ "$FAKE_SCENARIO" == "http_error" ]]; then
    printf 'unavailable' > "$output"
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
    def run_probe(self, scenario="pass", *, token="offline-token", worker_name=None):
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
            "GITHUB_RUN_ID": "4242",
            "CLOUDFLARE_SANDBOX_PROBE_TOKEN": token,
            "CLOUDFLARE_ACCOUNT_ID": "1b26415802588185a86c1d4d3ebf5bdb",
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
        self.assertEqual((state / "current-secret").read_text(), (state / "secret-b").read_text())
        self.assertTrue((state / "cleaned").exists())

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

    def test_invalid_worker_name_is_refused_before_write(self):
        completed, state, calls = self.run_probe(worker_name="zevanory")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("WORKER_NAME_REFUSED", completed.stderr)
        self.assertEqual(calls, "")
        self.assertFalse((state / "worker-created").exists())

    def test_missing_token_fails_closed_before_write(self):
        completed, state, calls = self.run_probe(token="")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("CLOUDFLARE_SANDBOX_PROBE_TOKEN_MISSING", completed.stderr)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        self.assertEqual(calls, "")
        self.assertFalse((state / "worker-created").exists())

    def test_cleanup_runs_after_post_deploy_failure(self):
        completed, state, calls = self.run_probe("http_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertTrue((state / "cleaned").exists())
        self.assertIn(" delete ", " " + calls)

    def test_cleanup_runs_after_ambiguous_deploy_failure(self):
        completed, state, calls = self.run_probe("deploy_error")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ROLLBACK_SECRET_VALUE_RESTORED=INCONCLUSIVE", completed.stdout)
        self.assertTrue((state / "worker-created").exists())
        self.assertTrue((state / "cleaned").exists())
        self.assertIn(" delete ", " " + calls)


class StaticContractTests(unittest.TestCase):
    def test_workflow_is_manual_and_least_privilege(self):
        workflow = json.loads(WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(workflow["on"], {"workflow_dispatch": {}})
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        job = workflow["jobs"]["probe"]
        self.assertEqual(job["environment"], {"name": "sandbox-financial-approved"})
        self.assertEqual(set(job["env"]), {"CLOUDFLARE_SANDBOX_PROBE_TOKEN", "CLOUDFLARE_ACCOUNT_ID"})
        self.assertEqual(job["env"]["CLOUDFLARE_SANDBOX_PROBE_TOKEN"],
                         "${{ secrets.CLOUDFLARE_SANDBOX_PROBE_TOKEN }}")
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
        self.assertIn("^zevanory-rollback-secret-probe-[0-9]+$", source)
        self.assertIn('delete "$WORKER_NAME" --config "$CONFIG" --force', source)
        self.assertNotIn('delete --name "$WORKER_NAME"', source)


if __name__ == "__main__":
    unittest.main()
