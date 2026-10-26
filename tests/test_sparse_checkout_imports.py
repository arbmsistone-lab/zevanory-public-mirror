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


class SparseCheckoutCoversImports(unittest.TestCase):
    def test_workflows(self):
        checked = 0
        for wf in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
            text = wf.read_text(encoding="utf-8")
            blocks = list(sparse_blocks(text))
            if not blocks:
                continue
            self.assertEqual(len(blocks), 1, f"{wf.name}: one sparse list per workflow expected")
            allowed = blocks[0]
            for script in re.findall(r"node (scripts/[\w./-]+\.mjs)", text):
                for dep in import_graph(ROOT / script):
                    rel = dep.relative_to(ROOT).as_posix()
                    self.assertTrue(any(rel == d or rel.startswith(d.rstrip("/") + "/") for d in allowed),
                                    f"{wf.name}: {script} needs {rel}, not in sparse-checkout {allowed}")
                    checked += 1
        self.assertGreater(checked, 0)

    def test_p18_monitor_needs_p20(self):
        deps = {d.relative_to(ROOT).as_posix() for d in import_graph(ROOT / "scripts/b0/p18-monitor.mjs")}
        self.assertTrue(any(d.startswith("scripts/p20/") for d in deps))


if __name__ == "__main__":
    unittest.main()
