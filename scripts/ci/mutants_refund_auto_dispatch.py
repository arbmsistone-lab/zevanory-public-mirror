#!/usr/bin/env python3
"""21 fail-closed mutants for automatic refunds, classified by mutant_classifier.py."""
from __future__ import annotations

import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
from mutant_classifier import aggregate, classify_run, load_mutant_config, parse_tap, run_command, validate_baseline

TEST = "tests/refund-auto-dispatch-contract.test.mjs"
MUTANTS = {
    "M01_flag_default": ("worker/refund-auto-dispatch.mjs", '=== "true";', '=== "false";', "A01"),
    "M02_prod_test_token": ("worker/refund-auto-dispatch.mjs", "if (!test && sandboxToken)", "if (false)", "A02"),
    "M03_sandbox_prod_token": ("worker/refund-auto-dispatch.mjs", "if (test && !sandboxToken)", "if (false)", "A03"),
    "M04_missing_token": ("worker/refund-auto-dispatch.mjs", "if (!token) return", "if (false) return", "A04"),
    "M05_money_epsilon": ("worker/refund-auto-dispatch.mjs", "< MONEY_EPSILON;", "< 1;", "A05"),
    "M06_dispute_signal": ("worker/refund-auto-dispatch.mjs", "signals.some((x) =>", "false && signals.some((x) =>", "A06"),
    "M07_identity": ("worker/refund-auto-dispatch.mjs", "if (!identityMatched) return", "if (false) return", "A07"),
    "M08_window": ("worker/refund-auto-dispatch.mjs", "if (!window?.eligible) return", "if (false) return", "A08"),
    "M09_test_order": ("worker/refund-auto-dispatch.mjs", "if (test || order?.certification_pilot", "if (false || order?.certification_pilot", "A09"),
    "M10_pilot": ("worker/refund-auto-dispatch.mjs", "order?.certification_pilot === true) return", "false) return", "A10"),
    "M11_credential": ("worker/refund-auto-dispatch.mjs", "if (!credential?.ok) return", "if (false) return", "A11"),
    "M12_order_paid": ("worker/refund-auto-dispatch.mjs", 'if (String(order?.status || "") !== "paid") return', "if (false) return", "A12"),
    "M13_payment_approved": ("worker/refund-auto-dispatch.mjs", 'if (String(payment?.status || "") !== "approved") return', "if (false) return", "A13"),
    "M14_dispute": ("worker/refund-auto-dispatch.mjs", "if (providerHasDispute(payment)) return", "if (false) return", "A14"),
    "M15_refunded_total": ("worker/refund-auto-dispatch.mjs", "if (refunded > 0 ||", "if (false ||", "A15"),
    "M16_refund_list": ("worker/refund-auto-dispatch.mjs", "(Array.isArray(payment?.refunds) && payment.refunds.length > 0)", "false", "A16"),
    "M17_amount": ("worker/refund-auto-dispatch.mjs", "if (!moneyMatches(order?.amount, payment?.transaction_amount)) return", "if (false) return", "A17"),
    "M18_order_match": ("worker/refund-auto-dispatch.mjs", "external !== expectedOrder && !external.endsWith", "external === expectedOrder && !external.endsWith", "A18"),
    "M19_offer": ("worker/refund-auto-dispatch.mjs", "if (paymentOfferId(payment) !== String(order?.offer_id || \"\"))", "if (false)", "A19"),
    "M20_idempotency_key": ("worker/refund-auto-dispatch.mjs", '"zevanory-refund-" +', '"refund-" +', "A20"),
    "M21_outcome_unknown": ("worker/refund-provider-claims.mjs", 'r?.last_error === "mercadopago_refund_outcome_unknown"', "false", "A21"),
}

CONFIG_RAW = {mid: {"primary": [{"test_pattern": label, "assertion_pattern": label}]}
              for mid, (*_, label) in MUTANTS.items()}
CONFIG_RAW["M14_dispute"]["secondary"] = [{"test_pattern": "A06", "assertion_pattern": "A06",
  "justification": "Removing the common providerHasDispute gate also disables the status-detail dispute signal."}]
CONFIG_RAW["M17_amount"]["secondary"] = [{"test_pattern": "A05", "assertion_pattern": "A05",
  "justification": "Removing the common amount comparison also disables the boundary tolerance assertion."}]
CONFIG = load_mutant_config(CONFIG_RAW)


def command(node: str):
    return [node, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout", TEST]


def main() -> int:
    node = shutil.which("node") or "node"
    temp_root = ROOT / ".tmp"
    temp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="refund-auto-mutants-", dir=temp_root) as raw:
        temp = pathlib.Path(raw)
        shutil.copytree(ROOT / "worker", temp / "worker")
        (temp / "tests").mkdir()
        shutil.copy2(ROOT / TEST, temp / TEST)
        baseline_run = run_command(command(node), cwd=temp)
        parsed = parse_tap(baseline_run["stdout"], stderr=baseline_run["stderr"])
        baseline = validate_baseline(21, baseline_run["return_code"], parsed["summary"], parsed["failures"],
                                     baseline_run["timed_out"], baseline_run["signal"])
        print(json.dumps({"baseline": baseline}, ensure_ascii=False))
        if not baseline["ok"]:
            return aggregate([], baseline_valid=False)[0]
        results = []
        for mid, (rel, old, new, _label) in MUTANTS.items():
            target = temp / rel
            original = target.read_text(encoding="utf-8")
            anchor_ok = original.count(old) == 1
            target.write_text(original.replace(old, new, 1), encoding="utf-8")
            run = run_command(command(node), cwd=temp)
            target.write_text(original, encoding="utf-8")
            spec = CONFIG[mid]
            result = classify_run(21, run, expected=spec, allowlist=spec.get("allowlist", []),
                                  anchor_ok=anchor_ok, mutant_id=mid)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False))
        code, summary = aggregate(results, baseline_valid=True)
        print(json.dumps(summary, ensure_ascii=False))
        return code


if __name__ == "__main__":
    raise SystemExit(main())
