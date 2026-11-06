#!/usr/bin/env python3
"""Offline harness for scripts/portfolio_target_lifecycle.py (tests/ci/p16-target-lifecycle.test.mjs).

Runs the REAL main() of the P16 script with its read-only fetch() replaced by fixtures: no network, never production.
Usage: python3 -I tests/helpers/p16_lifecycle_harness.py <repo-root> <case.json>
case.json: {"slug", "status": {"code", "raw"} | {"network_error": true}, "release": {...}, "page_code", "page_html",
            "evidence_dir"}
Prints one JSON line: {"ok", "label", "detail", "evidence"}; label is the rule name carried by the AssertionError.
"""
import json, os, sys, traceback

root, case_path = sys.argv[1], sys.argv[2]
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(root, "scripts"))
os.chdir(root)
import portfolio_target_lifecycle as p16  # noqa: E402

case = json.load(open(case_path, encoding="utf-8"))
slug = case["slug"]
os.environ["TARGET_SLUG"] = slug
os.environ["GITHUB_SHA"] = "0" * 40
os.environ["EXPECTED_RUNTIME_SHA"] = case["release"].get("deployment", {}).get("commit_sha", "1" * 40)
seen = []


def fake_fetch(url, accept):
    seen.append(url)
    assert url.startswith("https://zevanory.api.br/"), url
    if url == "https://zevanory.api.br/api/release":
        return 200, json.dumps(case["release"])
    if url == "https://zevanory.api.br/api/sales/status":
        st = case["status"]
        if st.get("network_error"):
            raise OSError("fixture: connection refused")
        return st["code"], st["raw"]
    if url == f"https://zevanory.api.br/{slug}":
        return case.get("page_code", 200), case["page_html"]
    raise AssertionError(("harness", "unexpected_url", url))


p16.fetch = fake_fetch
result = {"ok": False, "label": None, "detail": None, "evidence": None, "urls": seen}
try:
    import contextlib, io
    with contextlib.redirect_stdout(io.StringIO()):
        out = p16.main(evidence_dir=case["evidence_dir"])
    result.update(ok=True, evidence=out)
except AssertionError as e:
    args = e.args[0] if e.args else None
    if isinstance(args, tuple):
        labels = [a for a in args if isinstance(a, str) and a != slug]
        result["label"] = labels[0] if labels else None
    result["detail"] = repr(args)[:600]
except Exception as e:  # anything else is a harness/infra problem, never a verdict
    result.update(label="HARNESS_ERROR", detail=traceback.format_exc()[-800:])
print(json.dumps(result, ensure_ascii=False))
