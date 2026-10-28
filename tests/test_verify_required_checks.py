"""Sol ORDEM 312, item 4: post-merge, read-only verification that the protected legal check is required on gh-pages
and that only squash merges are allowed (scripts/ops/verify_required_checks.py)."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/ops/verify_required_checks.py"
GOOD = {
    "branch.json": {"protected": True, "protection": {"required_status_checks": {"contexts": ["product-pages / static-audit", "protected-trust-anchors"], "checks": []}}},
    "repo.json": {"allow_squash_merge": True, "allow_rebase_merge": False, "allow_merge_commit": False},
    "rules.json": [],
    "workflow.json": {"path": ".github/workflows/legal-trust-anchors-protected.yml"},
}


def run(files):
    with tempfile.TemporaryDirectory() as d:
        for n, v in files.items():
            if v is not None:
                Path(d, n).write_text(json.dumps(v))
        p = subprocess.run([sys.executable, "-I", str(SCRIPT), "--fixtures", d], capture_output=True, text=True)
        return p.returncode, p.stdout


class VerifyRequiredChecks(unittest.TestCase):
    def test_complete(self):
        rc, out = run(GOOD)
        self.assertEqual(rc, 0, out)
        self.assertIn("BOOTSTRAP=COMPLETE", out)

    def test_check_not_required(self):
        rc, out = run({**GOOD, "branch.json": {"protection": {"required_status_checks": {"contexts": ["product-pages / static-audit"]}}}})
        self.assertEqual(rc, 1)
        self.assertIn("REQUIRED_CHECK=ABSENT", out)

    def test_required_through_a_ruleset(self):
        rules = [{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "legal-trust-anchors-protected / protected-trust-anchors"}]}}]
        rc, out = run({**GOOD, "branch.json": {"protection": {}}, "rules.json": rules})
        self.assertEqual(rc, 0, out)

    def test_rebase_or_merge_commit_allowed(self):
        for over in ({"allow_rebase_merge": True}, {"allow_merge_commit": True}):
            rc, out = run({**GOOD, "repo.json": {**GOOD["repo.json"], **over}})
            self.assertEqual(rc, 1)
            self.assertIn("SQUASH_ONLY=NO", out)

    def test_workflow_missing_on_the_branch(self):
        rc, out = run({**GOOD, "workflow.json": None})
        self.assertEqual(rc, 1)
        self.assertIn("PROTECTED_CHECK_WORKFLOW=ABSENT", out)

    def test_read_only(self):
        src = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('["gh", "api", "-X", "GET", path]', src)
        for verb in ("PUT", "PATCH", "POST", "DELETE"):
            self.assertNotIn(f'"-X", "{verb}"', src)


if __name__ == "__main__":
    unittest.main()
