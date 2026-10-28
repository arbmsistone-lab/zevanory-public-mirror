"""Round 10 (PR #946): the central dry-run failed at "Verify the release manifest".

Cause: actions/upload-artifact v4 drops hidden files by default, and the central release has
public/.assetsignore and public/.well-known/security.txt (frozen public/ of 83620c68), which the manifest lists.
This test runs the REAL verify step body from the workflow (bash) on a release whose hidden files were dropped
(the default upload) and on the complete release: the first fails with an ::error annotation naming the files,
the second passes. It also checks that the clean-bundle uploads set include-hidden-files: true.
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WF = ROOT / ".github/workflows/central-production-deploy.yml"
SALES = ROOT / ".github/workflows/zevanory-sales-public-release.yml"
STEP = "Verify the release manifest"


def jobs(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))["jobs"]


def step(job, name):
    hits = [s for s in job["steps"] if s.get("name") == name]
    assert len(hits) == 1, name
    return hits[0]


def release(d: Path, files: dict[str, bytes]) -> None:
    for rel, data in files.items():
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / rel).write_bytes(data)
    names = sorted("./" + p.relative_to(d).as_posix() for p in d.rglob("*") if p.is_file())
    (d / "MANIFEST.sha256").write_text("".join(f"{hashlib.sha256((d / n).read_bytes()).hexdigest()}  {n}\n" for n in names))


class HiddenFilesInRelease(unittest.TestCase):
    FILES = {"worker.bundle.js": b"export default {};\n", "wrangler.central-fix.jsonc": b'{"name": "zevanory", "main": "worker.bundle.js"}\n',
             "public/index.html": b"<!doctype html>\n", "public/.assetsignore": b"*.map\n", "public/.well-known/security.txt": b"Contact: x\n"}

    def run_step(self, drop_hidden: bool):
        body = step(jobs(WF)["rehearsal"], STEP)["run"]
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            built = t / "built"
            release(built, self.FILES)
            manifest = hashlib.sha256((built / "MANIFEST.sha256").read_bytes()).hexdigest()
            art = t / "work" / "art" / "central"
            # upload-artifact without include-hidden-files: every path with a dot-segment is left out.
            shutil.copytree(built, art, ignore=(lambda d, names: [n for n in names if n.startswith(".")]) if drop_hidden else None)
            (t / "tmp").mkdir()
            env = {**os.environ, "RELEASE_MANIFEST": manifest, "RUNNER_TEMP": str(t / "tmp")}
            p = subprocess.run(["bash", "-e", "-c", body], cwd=t / "work", env=env, capture_output=True, text=True)
            return p.returncode, p.stdout + p.stderr

    def test_dropped_hidden_files_fail_with_a_named_annotation(self):
        rc, out = self.run_step(drop_hidden=True)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("::error title=RELEASE_MANIFEST::", out)
        self.assertIn("./public/.assetsignore", out)
        self.assertIn("./public/.well-known/security.txt", out)

    def test_complete_release_passes(self):
        rc, out = self.run_step(drop_hidden=False)
        self.assertEqual(rc, 0, out)
        self.assertIn("RELEASE_MANIFEST=PASS", out)

    def test_wrong_manifest_hash_is_named(self):
        body = step(jobs(WF)["rehearsal"], STEP)["run"]
        with tempfile.TemporaryDirectory() as t:
            t = Path(t)
            release(t / "art" / "central", self.FILES)
            (t / "tmp").mkdir()
            p = subprocess.run(["bash", "-e", "-c", body], cwd=t, env={**os.environ, "RELEASE_MANIFEST": "0" * 64, "RUNNER_TEMP": str(t / "tmp")},
                               capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("::error title=RELEASE_MANIFEST::MANIFEST.sha256 hash", p.stdout)

    def test_deploy_and_rehearsal_verify_the_same_way(self):
        j = jobs(WF)
        self.assertEqual(step(j["rehearsal"], STEP)["run"], step(j["deploy"], STEP)["run"])

    def test_clean_bundle_uploads_keep_hidden_files(self):
        for path, job, name in ((WF, "build", "central-release-${{ github.sha }}"), (SALES, "worker-bundle", "sales-worker-${{ github.sha }}")):
            up = [s for s in jobs(path)[job]["steps"] if str(s.get("uses", "")).startswith("actions/upload-artifact@")]
            self.assertEqual(len(up), 1, job)
            self.assertEqual(up[0]["with"]["name"], name)
            self.assertIs(up[0]["with"].get("include-hidden-files"), True, f"{job}: include-hidden-files must be true")

    def test_every_artifact_upload_in_the_deploy_workflows_keeps_hidden_files(self):
        for path in (WF, SALES):
            for jname, job in jobs(path).items():
                for s in job.get("steps", []):
                    if str(s.get("uses", "")).startswith("actions/upload-artifact@"):
                        self.assertIs(s["with"].get("include-hidden-files"), True, f"{path.name}:{jname}:{s['with'].get('name')}")

    def test_the_frozen_public_really_has_hidden_files(self):
        sha = "83620c680958d726fc4b0fd16e2574cdcc362a6d"
        if subprocess.run(["git", "-C", str(ROOT), "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True).returncode != 0:
            self.skipTest("frozen commit not in this clone (shallow checkout)")
        names = subprocess.run(["git", "-C", str(ROOT), "ls-tree", "-r", "--name-only", sha, "public"], capture_output=True, text=True).stdout.split()
        self.assertIn("public/.assetsignore", names)
        self.assertIn("public/.well-known/security.txt", names)


if __name__ == "__main__":
    unittest.main()
