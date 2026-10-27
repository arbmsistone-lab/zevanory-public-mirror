#!/usr/bin/env python3
"""21 original + 18 refund-flow fail-closed mutants with assertion-level kills."""
from __future__ import annotations

import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))
from mutant_classifier import aggregate, classify_run, load_mutant_config, parse_tap, run_command, validate_baseline

TEST = "tests/refund-auto-dispatch-mutation-suite.mjs"
BASELINE_COUNT = 46  # A01..A21 and X01..X25
MUTANTS = {
    "M01_flag_default": ("worker/refund-auto-dispatch.mjs", '=== "true";', '=== "false";', "A01"),
    "M02_prod_test_token": ("worker/refund-auto-dispatch.mjs", 'mode !== "production" || sandboxToken || !await verify(env)', 'mode !== "production" || false || false', "A02"),
    "M03_sandbox_prod_token": ("worker/refund-auto-dispatch.mjs", 'mode !== "sandbox" || !sandboxToken', "false", "A03"),
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
    "M16_refund_list": ("worker/refund-auto-dispatch.mjs", "payment.refunds.length > 0", "false", "A16"),
    "M17_amount": ("worker/refund-auto-dispatch.mjs", "if (!moneyMatches(order?.amount, payment?.transaction_amount)) return", "if (false) return", "A17"),
    "M18_order_match": ("worker/refund-auto-dispatch.mjs", "external !== expectedOrder && !external.endsWith", "external === expectedOrder && !external.endsWith", "A18"),
    "M19_offer": ("worker/refund-auto-dispatch.mjs", "if (paymentOfferId(payment) !== String(order?.offer_id || \"\"))", "if (false)", "A19"),
    "M20_idempotency_key": ("worker/refund-auto-dispatch.mjs", '"zevanory-refund-" +', '"refund-" +', "A20"),
    "M21_outcome_unknown": ("worker/refund-provider-claims.mjs", 'r?.last_error === "mercadopago_refund_outcome_unknown"', "false", "A21"),
    "B01_off_identity": ("worker/refund-flow.mjs", "if (!candidates.some((c) => c && timingSafeEqual(c, email))) return", "if (false) return", "X12"),
    "B02_off_paid": ("worker/refund-flow.mjs", 'order.status !== "paid" || !order.payment_id', 'false || !order.payment_id', "X12"),
    "B03_execute_credential": ("worker/refund-flow.mjs", "record.auto_dispatch ? await validateMercadoPagoCredential", "false ? await validateMercadoPagoCredential", "X25"),
    "B04_admin_reason": ("worker/refund-flow.mjs", "r.manual_reason ? `<br>", "false ? `<br>", "X10"),
    "B05_admin_age": ("worker/refund-flow.mjs", "ageH < 1 ? Math.max", "false ? Math.max", "X10"),
    "B06_refund_amount": ("worker/refund-flow.mjs", "Math.abs(Number(body.amount) - Number(record.amount)) > 0.005) :", "false) :", "X24"),
    "B07_on_identity": ("worker/refund-flow.mjs", "if (!identityMatched) {", "if (false) {", "X01"),
    "B08_unverified_audit": ("worker/refund-flow.mjs", "await recordUnverifiedAttempt(kv, order, oid, email);", "void 0;", "X01"),
    "B09_provider_gate": ("worker/refund-flow.mjs", "if (credential.ok && order.payment_id)", "if (true && order.payment_id)", "X13"),
    "B10_email_match": ("worker/refund-flow.mjs", "timingSafeEqual(delivery || payer, email)", "true", "X01"),
    "B11_receipt_protocol": ("worker/refund-flow.mjs", "protocol: oid, message: RECEIPT_MESSAGE", "message: RECEIPT_MESSAGE", "X04"),
    "B12_receipt_message": ("worker/refund-flow.mjs", "message: RECEIPT_MESSAGE", 'message: ""', "X04"),
    "B13_customer_retry": ("worker/refund-flow.mjs", "if (record.customer_email_pending === true)", "if (false)", "X17"),
    "B14_rejected_auto": ("worker/refund-flow.mjs", 'if (existing?.status === "rejected") decision', 'if (false) decision', "X23"),
    "B15_missing_payment": ("worker/refund-flow.mjs", "if (!order.payment_id || !order.paid_at) decision", "if (false) decision", "X21"),
    "B16_execute_identity": ("worker/refund-flow.mjs", "record.auto_dispatch === true && (record.identity_verified !== true", "false && (record.identity_verified !== true", "X22"),
    "B17_alert_dedup": ("worker/refund-flow.mjs", "if (await kv.get(key)) return false;", "if (false) return false;", "X18"),
    "B18_unknown_order_generic": ("worker/refund-flow.mjs", "if (!order) return receipt;", "if (!order) return { status: 404, body: { error: 'order_not_found' } };", "X03"),
}

CONFIG_RAW = {mid: {"primary": [{"test_pattern": label, "assertion_pattern": label}]}
              for mid, (*_, label) in MUTANTS.items()}
CONFIG_RAW["M14_dispute"]["secondary"] = [{"test_pattern": "A06", "assertion_pattern": "A06",
  "justification": "Removing the common providerHasDispute gate also disables the status-detail dispute signal."}]
CONFIG_RAW["M17_amount"]["secondary"] = [{"test_pattern": "A05", "assertion_pattern": "A05",
  "justification": "Removing the common amount comparison also disables the boundary tolerance assertion."}]
# Causal collateral is declared explicitly: the global flag changes branch routing, while
# the other mutants break one shared helper consumed by several adversarial scenarios.
COLLATERAL = {
    "M01_flag_default": ["X01", "X02", "X03", "X04", "X05", "X09", "X10", "X12", "X13", "X14", "X15", "X16", "X17", "X18", "X21", "X22", "X23", "X24", "X25"],
    "M02_prod_test_token": ["X13", "X15", "X18"],
    "M11_credential": ["X13"],
    "M17_amount": ["X10", "X17", "X23", "X25"],
    "B07_on_identity": ["X16"],
    "B09_provider_gate": ["X14", "X15"],
    "B11_receipt_protocol": ["X10", "X21"],
    "B12_receipt_message": ["X03", "X05", "X10"],
}
REASONS = {
    "M01_flag_default": "Inverting the central flag swaps ON and OFF branches for every listed scenario; tests include both paths.",
    "M02_prod_test_token": "Removing the environment/account verification changes routing and the alerts for incompatible production tokens.",
    "M11_credential": "Removing the eligibility gate for an invalid credential changes the reason and route of the sandbox-token scenario.",
    "M17_amount": "Removing payment amount verification converts the listed forced-manual scenarios into automatic refund attempts.",
    "B07_on_identity": "Without the identity gate, conflicting registered recipients are no longer quarantined.",
    "B09_provider_gate": "Without the credential gate, invalid-account scenarios incorrectly call the payment endpoint.",
    "B11_receipt_protocol": "All successful ON receipt pathways share the protocol field.",
    "B12_receipt_message": "All successful ON receipt pathways share the same public message.",
}
for mid, labels in COLLATERAL.items():
    CONFIG_RAW[mid].setdefault("secondary", []).extend({"test_pattern": label,
        "assertion_pattern": label, "justification": REASONS[mid]} for label in labels)
    if len(labels) > 3:
        CONFIG_RAW[mid]["broad_reason"] = REASONS[mid]
CONFIG = load_mutant_config(CONFIG_RAW)


def command(node: str):
    return [node, "--test-reporter=tap", "--test-reporter-destination=stdout", TEST]


def main() -> int:
    node = shutil.which("node") or "node"
    temp_root = ROOT / ".tmp"
    temp_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="refund-auto-mutants-", dir=temp_root) as raw:
        temp = pathlib.Path(raw)
        shutil.copytree(ROOT / "worker", temp / "worker")
        (temp / "data" / "p23").mkdir(parents=True)
        for rel in ["data/politica-unica.json", "data/p23/fiscal-process.json"]:
            shutil.copy2(ROOT / rel, temp / rel)
        (temp / "tests").mkdir()
        (temp / "tests" / "helpers").mkdir()
        for rel in [TEST, "tests/refund-auto-dispatch-contract.test.mjs", "tests/refund-auto-dispatch-adversarial.test.mjs",
                    "tests/helpers/text.mjs"]:
            shutil.copy2(ROOT / rel, temp / rel)
        baseline_run = run_command(command(node), cwd=temp)
        parsed = parse_tap(baseline_run["stdout"], stderr=baseline_run["stderr"])
        baseline = validate_baseline(BASELINE_COUNT, baseline_run["return_code"], parsed["summary"], parsed["failures"],
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
            result = classify_run(BASELINE_COUNT, run, expected=spec, allowlist=spec.get("allowlist", []),
                                  anchor_ok=anchor_ok, mutant_id=mid)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False))
        code, summary = aggregate(results, baseline_valid=True)
        print(json.dumps(summary, ensure_ascii=False))
        return code


if __name__ == "__main__":
    raise SystemExit(main())
