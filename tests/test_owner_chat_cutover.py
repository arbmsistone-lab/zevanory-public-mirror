"""Offline checks for the actual central rollback step and its target resolver."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/deploy"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("owner_chat_target", SCRIPTS / "owner-chat-rollback-target.py")
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)

A = "a" * 40
B = "b" * 40
VERSION = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
MAINTENANCE = 'export const OWNER_CHAT_RELEASE_PHASE = "maintenance";'
POSTGRES = 'export const OWNER_CHAT_RELEASE_PHASE = "postgres";'


class ResolveTarget(unittest.TestCase):
    def test_a_never_resolves_a_rollback_version(self):
        with patch.object(target.Path, "read_text", return_value=MAINTENANCE), patch.object(target, "_get") as api:
            self.assertEqual(target.resolve(), ("maintenance", "", ""))
            api.assert_not_called()

    def test_b_requires_exact_a_with_matching_observers_and_tree(self):
        response = {"success": True, "result": {"id": VERSION, "metadata": {"annotations": {"workers/tag": A}}}}
        with (
            patch.dict(os.environ, {"OWNER_CHAT_PHASE_A_VERSION_ID": VERSION,
                                    "CLOUDFLARE_API_TOKEN": "fake-token", "CLOUDFLARE_ACCOUNT_ID": "test"}),
            patch.object(target.Path, "read_text", side_effect=lambda: None) as read,
            patch.object(target, "_get", return_value=response),
            patch.object(target, "git", side_effect=lambda op, _: "tree-a" if op == "rev-parse" else MAINTENANCE) as git,
            patch.object(target, "observe_cloudflare_version", return_value=("ok", A, VERSION)) as cf,
            patch.object(target, "readback_sha", return_value=A) as http,
        ):
            read.side_effect = [POSTGRES, A]
            self.assertEqual(target.resolve(), ("postgres", VERSION, A))
            read.side_effect = [POSTGRES, A]
            http.return_value = B
            with self.assertRaisesRegex(ValueError, "confirmação simultânea"):
                target.resolve()
            read.side_effect = [POSTGRES, A]
            http.return_value = A
            cf.return_value = ("ok", A, "unapproved")
            with self.assertRaisesRegex(ValueError, "precisa estar ativa"):
                target.resolve()
            read.side_effect = [POSTGRES, A]
            git.side_effect = ["tree-good", "tree-wrong"]
            with self.assertRaisesRegex(ValueError, "diverge da árvore"):
                target.resolve()


class WorkflowRollback(unittest.TestCase):
    def execute(self, phase, version, sha):
        source = (ROOT / ".github/workflows/central-production-deploy.yml").read_text()
        step = source.split("      - name: Automatic rollback after failed post-deploy smoke\n", 1)[1].split("\n      - name:", 1)[0]
        self.assertIn("steps.deployworker.outcome == 'success'", step)
        self.assertIn("steps.deployworker.outcome == 'failure'", step)
        body = step.split("        run: |\n", 1)[1]
        fake = """
        npx() { printf 'WRANGLER %s\n' "$*"; }
        python3() { printf 'PYTHON %s\n' "$*"; }
        curl() { printf '200'; }
        gh() { printf 'GH %s\n' "$*"; }
        """
        env = {**os.environ, "OWNER_CHAT_PHASE": phase, "OWNER_CHAT_ROLLBACK_ID": version,
               "OWNER_CHAT_ROLLBACK_SHA": sha, "TARGET_RUNTIME_SHA": B, "GITHUB_REPOSITORY": "test/local",
               "DIARIO_D1_MODO": "off"}
        return subprocess.run(["bash", "-c", fake + "\n" + body], env=env, capture_output=True, text=True, check=False)

    def test_a_stops_and_never_calls_wrangler_even_with_supplied_id(self):
        result = self.execute("maintenance", VERSION, A)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("OWNER_CHAT_ROLLBACK_BLOCKED", result.stdout)
        self.assertNotIn("WRANGLER", result.stdout)

    def test_b_refuses_missing_id_and_rolls_back_to_exact_a(self):
        missing = self.execute("postgres", "", A)
        self.assertEqual(missing.returncode, 1, missing.stderr)
        self.assertNotIn("WRANGLER", missing.stdout)
        result = self.execute("postgres", VERSION, A)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"rollback {VERSION} --name zevanory", result.stdout)
        self.assertIn(f'--candidate {A}', result.stdout)
        self.assertLess(result.stdout.index("--verify-active"), result.stdout.index("AUTO_ROLLBACK_HEALTH=PASS"))


if __name__ == "__main__":
    unittest.main()
