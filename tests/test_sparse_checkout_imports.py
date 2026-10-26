"""Every workflow with a sparse checkout must contain the whole import graph of the scripts it runs.

Regression of 25-26/10: P20 (#930) made scripts/b0/b0-collector.mjs import scripts/p20/restore-drill-lib.mjs;
the P18 monitor checks out only scripts/b0, so every run died with ERR_MODULE_NOT_FOUND and the
watchdog reported MISSING. This test fails if a sparse list misses any directory a run step needs.
"""
import os
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
IMPORT = re.compile(r"""(?:^|\s)(?:import|export)\s[^'"]*?['"](\.{1,2}/[^'"]+)['"]|import\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""", re.M)


def import_graph(entry: pathlib.Path) -> set[pathlib.Path]:
    seen, todo = set(), [entry]
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        for a, b in IMPORT.findall(f.read_text(encoding="utf-8")):
            p = (f.parent / (a or b)).resolve()
            if p.exists():
                todo.append(p)
            else:
                raise AssertionError(f"{f.relative_to(ROOT)} imports missing {a or b}")
    return seen


def sparse_blocks(text: str):
    lines = text.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)sparse-checkout: \|\s*$", line)
        if not m:
            continue
        indent, items = len(m.group(1)), []
        for nxt in lines[i + 1:]:
            if not nxt.strip():
                break
            if len(nxt) - len(nxt.lstrip()) <= indent:
                break
            items.append(nxt.strip())
        yield items


def coverage_errors(name: str, text: str) -> list[str]:
    """Missing directories for one workflow text (empty list = covered)."""
    errors = []
    blocks = list(sparse_blocks(text))
    if not blocks:
        return errors
    if len(blocks) != 1:
        return [f"{name}: one sparse list per workflow expected"]
    allowed = blocks[0]
    for script in re.findall(r"node (scripts/[\w./-]+\.mjs)", text):
        for dep in import_graph(ROOT / script):
            rel = dep.relative_to(ROOT).as_posix()
            if not any(rel == d or rel.startswith(d.rstrip("/") + "/") for d in allowed):
                errors.append(f"{name}: {script} needs {rel}, not in sparse-checkout {allowed}")
    return errors


class SparseCheckoutCoversImports(unittest.TestCase):
    """Scope (A286-02): relative static/dynamic imports matched by IMPORT, for every `node scripts/*.mjs`
    run line of a workflow that uses a sparse checkout. It does not prove coverage of other commands."""

    def test_workflows(self):
        found = 0
        for wf in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            text = wf.read_text(encoding="utf-8")
            if list(sparse_blocks(text)):
                found += 1
                self.assertEqual(coverage_errors(wf.name, text), [])
        self.assertGreaterEqual(found, 2)

    def test_counterproof_without_p20_fails_naming_the_dependency(self):
        wf = ROOT / ".github" / "workflows" / "p18-external-monitor.yml"
        text = wf.read_text(encoding="utf-8")
        self.assertIn("            scripts/p20\n", text)
        broken = text.replace("            scripts/p20\n", "", 1)
        errors = coverage_errors(wf.name, broken)
        self.assertTrue(errors)
        self.assertTrue(all("needs scripts/p20/" in e for e in errors), errors)
        self.assertTrue(any("scripts/p20/restore-drill-lib.mjs" in e for e in errors), errors)

    def test_counterproof_with_p20_passes(self):
        wf = ROOT / ".github" / "workflows" / "p18-external-monitor.yml"
        self.assertEqual(coverage_errors(wf.name, wf.read_text(encoding="utf-8")), [])

    def test_p18_monitor_needs_p20(self):
        deps = {d.relative_to(ROOT).as_posix() for d in import_graph(ROOT / "scripts/b0/p18-monitor.mjs")}
        self.assertTrue(any(d.startswith("scripts/p20/") for d in deps))


if __name__ == "__main__":
    unittest.main()
