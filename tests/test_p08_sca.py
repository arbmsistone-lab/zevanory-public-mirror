"""P08 SCA por ecossistema (scripts/ci/p08_sca.py): sem rede (OSV falso). Cada regra tem um caso que a derruba."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "ci"))
import p08_sca as s  # noqa: E402


def clean(payload):
    return {"results": [{} for _ in payload["queries"]]}


def tree(files):
    d = tempfile.TemporaryDirectory()
    for p, t in files.items():
        f = Path(d.name, p)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(t)
    return d


class P08Sca(unittest.TestCase):
    def run_tree(self, files, post=clean):
        d = tree(files)
        try:
            return s.run(d.name, sorted(files), post)
        finally:
            d.cleanup()

    def test_sem_manifesto_nao_se_aplica(self):
        r = self.run_tree({"worker/a.mjs": "x"})
        self.assertEqual(r["status"], "NOT_APPLICABLE_NO_PACKAGE_MANAGER")

    def test_arvore_real_pypi_fixado_e_limpo(self):
        seen = []
        r = self.run_tree({"tests/ci/requirements-guard.txt": "# G4\nPyYAML==6.0.2\n"}, lambda p: (seen.append(p), clean(p))[1])
        self.assertEqual(r["status"], "PYPI_PINNED_OSV_CLEAN")
        self.assertEqual(r["packages"][0]["purl"], "pkg:pypi/pyyaml@6.0.2")
        self.assertEqual(seen[0]["queries"], [{"package": {"name": "pyyaml", "ecosystem": "PyPI"}, "version": "6.0.2"}])

    def test_vulnerabilidade_conhecida_reprova(self):
        with self.assertRaisesRegex(s.ScaError, r"known_vulnerability:pkg:pypi/pyyaml@5\.3=GHSA-x"):
            self.run_tree({"requirements.txt": "PyYAML==5.3\n"}, lambda p: {"results": [{"vulns": [{"id": "GHSA-x"}]}]})

    def test_pin_nao_exato_reprova(self):
        for line in ["PyYAML>=6.0", "PyYAML~=6.0", "PyYAML", "PyYAML==6.*", "PyYAML[extra]==6.0.2", "PyYAML==6.0.2; python_version>'3'",
                     "-r outro.txt", "-e .", "git+https://x/y.git", "PyYAML==6.0.2 --hash=sha256:ab", "--index-url https://x"]:
            with self.subTest(line=line), self.assertRaisesRegex(s.ScaError, "requirements_not_exact_pin"):
                self.run_tree({"requirements.txt": line + "\n"})

    def test_outro_ecossistema_continua_fail_closed(self):
        for f in ["package.json", "web/package-lock.json", "go.mod", "Cargo.toml", "pyproject.toml", "Pipfile", "Gemfile"]:
            with self.subTest(f=f), self.assertRaisesRegex(s.ScaError, "fail_closed_manifest_requires_ecosystem_sca"):
                self.run_tree({f: "{}", "requirements.txt": "PyYAML==6.0.2\n"})

    def test_osv_fora_do_ar_ou_ilegivel_reprova(self):
        def boom(p):
            raise OSError("down")
        with self.assertRaisesRegex(s.ScaError, "osv_unreachable"):
            self.run_tree({"requirements.txt": "PyYAML==6.0.2\n"}, boom)
        for bad in [{}, {"results": []}, {"results": [None]}, {"results": [{"vulns": "x"}]}, [], {"results": [{}, {}]}]:
            with self.subTest(bad=bad), self.assertRaisesRegex(s.ScaError, "osv_response_invalid"):
                self.run_tree({"requirements.txt": "PyYAML==6.0.2\n"}, lambda p, b=bad: b)
        with self.assertRaisesRegex(s.ScaError, "osv_paginated"):
            self.run_tree({"requirements.txt": "PyYAML==6.0.2\n"}, lambda p: {"results": [{"next_page_token": "t"}]})

    def test_manifesto_vazio_e_pins_conflitantes_reprovam(self):
        with self.assertRaisesRegex(s.ScaError, "requirements_without_packages"):
            self.run_tree({"requirements.txt": "# nada\n\n"})
        with self.assertRaisesRegex(s.ScaError, "conflicting_pins:pyyaml"):
            self.run_tree({"a/requirements.txt": "PyYAML==6.0.2\n", "b/requirements-dev.txt": "pyyaml==6.0.1\n"})

    def test_relatorio_cli_fail_closed(self):
        d = tree({"requirements.txt": "PyYAML>=1\n"})
        try:
            import subprocess
            subprocess.run(["git", "init", "-q", d.name], check=True)
            subprocess.run(["git", "-C", d.name, "add", "-A"], check=True)
            out = Path(d.name, "out.json")
            rc = s.main(["x", d.name, str(out)])
            self.assertEqual(rc, 1)
            self.assertEqual(json.loads(out.read_text())["verdict"], "FAIL")
        finally:
            d.cleanup()


if __name__ == "__main__":
    unittest.main()
