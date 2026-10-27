#!/usr/bin/env python3
"""21 original + 18 refund-flow fail-closed + 22 re-audit r2 + 12 decision-state + 7 round-3 mutants with assertion-level kills."""
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
BASELINE_COUNT = 86  # A01..A21, X01..X25 and R01..R40
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
    "B07_on_identity": ("worker/refund-flow.mjs", 'if (a.identity === "mismatch") {\n    await recordUnverifiedAttempt', 'if (false) {\n    await recordUnverifiedAttempt', "X01"),
    "B08_unverified_audit": ("worker/refund-flow.mjs", "await recordUnverifiedAttempt(kv, order, oid, maskEmail(email), typedHash);", "void 0;", "X01"),
    "B09_provider_gate": ("worker/refund-flow.mjs", "if (credential.ok && order.payment_id)", "if (true && order.payment_id)", "X13"),
    "B10_email_match": ("worker/refund-flow.mjs", "async (c) => timingSafeEqual(c, email)", "async (c) => true", "X01"),
    "B11_receipt_protocol": ("worker/refund-flow.mjs", "protocol: oid, message: RECEIPT_MESSAGE", "message: RECEIPT_MESSAGE", "X04"),
    "B12_receipt_message": ("worker/refund-flow.mjs", "message: RECEIPT_MESSAGE", 'message: ""', "X04"),
    "B13_customer_retry": ("worker/refund-flow.mjs", "if (record.customer_email_pending === true)", "if (false)", "X17"),
    "B14_rejected_auto": ("worker/refund-flow.mjs", "if (priorRejection) decision", "if (false) decision", "X23"),
    "B15_missing_payment": ("worker/refund-flow.mjs", "if (!order.payment_id || !order.paid_at) decision", "if (false) decision", "X21"),
    "B16_execute_identity": ("worker/refund-flow.mjs", 'if (heldForEvidence(record)) return { status: 409', 'if (false) return { status: 409', "X22"),
    "B17_alert_dedup": ("worker/refund-flow.mjs", "if (await kv.get(key)) return false;", "if (false) return false;", "X18"),
    "B18_unknown_order_generic": ("worker/refund-flow.mjs", "if (!order) return receipt;", "if (!order) return { status: 404, body: { error: 'order_not_found' } };", "X03"),
    # Re-audit r2 (M-A, M-B, L-1..L-7): each mutant reverts one correction.
    "C01_conflict_dropped": ("worker/refund-flow.mjs", 'deliveryMatch || payerMatch ? "conflict"', 'false ? "conflict"', "R01"),
    "C02_unverifiable_dropped": ("worker/refund-flow.mjs", ': !payer ? "unverifiable" : "mismatch";', ': "mismatch";', "R02"),
    "C03_credential_alert_skipped": ("worker/refund-flow.mjs", "      if (!credential.ok) await notifyCredentialMismatch(env, kv, oid, credential.reason, test);\n      if (decision.eligible) {", "      if (decision.eligible) {", "R02"),
    "C04_unverified_blocks_buyer": ("worker/refund-flow.mjs", 'const supersede = pendingExisting && existing.identity_verified === false && a.identity === "matched";', "const supersede = false;", "R02"),
    "C05_conflict_ack_other_party": ("worker/refund-flow.mjs", 'const source = record.notify_source === "payer" ? payer : delivery;', 'const source = record.notify_source === "payer" ? delivery : payer;', "R01"),
    "C06_request_reeval_disabled": ("worker/refund-flow.mjs", "const reeval = pendingExisting &&", "const reeval = false &&", "R05"),
    "C07_request_window_now": ("worker/refund-flow.mjs", "firstDownloadAt: order.first_download_at, now: Date.parse(existing.requested_at) || Date.now() });", "firstDownloadAt: order.first_download_at, now: Date.now() });", "R19"),
    "C08_watchdog_window_now": ("worker/refund-flow.mjs", "{ now: Date.parse(rec.requested_at) || Date.now() });", "{ now: Date.now() });", "R19"),
    "C09_lookup_failure_reason": ("worker/refund-auto-dispatch.mjs", "if (paymentLookupError) return", "if (false) return", "R09"),
    "C10_unverified_uncapped": ("worker/refund-flow.mjs", "if ((listed.keys || []).length >= UNVERIFIED_CAP) return;", "if (false) return;", "R10"),
    "C11_unverified_not_deduped": ("worker/refund-flow.mjs", "`refund:unverified:${oid}:${String(hash).slice(0, 16)}`", "`refund:unverified:${oid}:${crypto.randomUUID()}`", "R10"),
    "C12_terminal_merge_lost": ("worker/refund-state.mjs", "    if (!isTerminal(record.status)) return false;\n", "    return false;\n", "R11"),
    "C13_kv_copy_trusted": ("worker/refund-provider-claims.mjs", "const legacy = cached && cached.auto_dispatch !== true ? cached : null;", "const legacy = cached;", "R34"),
    "C14_kv_only_write": ("worker/refund-provider-claims.mjs", "    if (!sql) return false;\n", "    if (!sql) { await kv.put(KEY(record.order_id), JSON.stringify(record), { expirationTtl: TTL }); return true; }\n", "R11"),
    "C15_held_no_reject": ("worker/refund-flow.mjs", '<button name="action" value="reevaluate">Reavaliar agora</button> <button name="action" value="reject" class="no">Recusar</button>', '<button name="action" value="reevaluate">Reavaliar agora</button>', "R07"),
    "C16_owner_approve_no_reeval": ("worker/refund-flow.mjs", 'if ((heldForEvidence(record) || PAYMENT_UNPROVEN.has(record.manual_reason)) && actor === "owner") {', "if (false) {", "R08"),
    "C17_watchdog_no_reeval": ("worker/refund-flow.mjs", 'const out = await reevaluateRequest(env, sql, kv, rec.order_id, { actor: "watchdog" });', "const out = { status: 409, body: {} };", "R06"),
    "C18_reeval_mismatch_kept": ("worker/refund-flow.mjs", 'if (a.identity === "mismatch") {\n    if (rec.identity_verified === true)', 'if (false) {\n    if (rec.identity_verified === true)', "R03"),
    "C19_unverified_rejection_sticky": ("worker/refund-flow.mjs", '(existing?.status === "rejected" && existing.identity_verified !== false) ||', '(existing?.status === "rejected") ||', "R16"),
    "C20_off_admin_extended": ("worker/refund-flow.mjs", "if (!refundAutoDispatchEnabled(env) && !items.some(", "if (false && !items.some(", "R15"),
    "C21_identity_alert_skipped": ("worker/refund-flow.mjs", "        if (!decision.eligible) {\n          const alert", "        if (false) {\n          const alert", "R02"),
    "C22_sync_followup": ("worker/refund-flow.mjs", "if (ctx?.waitUntil) ctx.waitUntil(followUp().catch(() => {}));\n    else await followUp();", "await followUp();", "R17"),
    # Coordinator/auditor ORDEM 294: PostgreSQL decision state, justification, audit and recovery.
    "D01_justification_optional_approve": ("worker/refund-flow.mjs", "if (record.manual_reason && justification.length < JUSTIFICATION_MIN)", "if (false)", "R20"),
    "D02_justification_optional_reject": ("worker/refund-flow.mjs", "  if (justification.length < JUSTIFICATION_MIN) return { status: 400, body: { error: \"refund_justification_required\" } };\n  const channel", "  const channel", "R20"),
    "D03_decision_not_persisted": ("worker/refund-flow.mjs", "    if (!await saveRefund(kv, record, { sql, actor, justification: justification || null,", "    if (!true && !await saveRefund(kv, record, { sql, actor, justification: justification || null,", "R20"),
    "D04_definitive_as_transient": ("worker/refund-flow.mjs", 'return status === 404 ? "not_found"', 'return status === 404 ? "transient"', "R22"),
    "D05_reevaluation_unbounded": ("worker/refund-flow.mjs", "/ 864e5 <= REEVALUATION_DAYS) {", "/ 864e5 <= 1e9) {", "R23"),
    "D06_unverified_deleted": ("worker/refund-flow.mjs", 'Object.assign(rec, { status: "unverified_closed",', 'Object.assign(rec, { status: "pending",', "R03"),
    "D07_decision_email_skipped": ("worker/refund-flow.mjs", 'if (record.decision_email_pending === true && record.status === "rejected") {', "if (false) {", "R26"),
    "D08_no_channel_unflagged": ("worker/refund-flow.mjs", 'confirmation_channel: verified || a.identity === "conflict" ? "registered_address" : "none",\n      credential_verified: credential.ok,', 'confirmation_channel: "registered_address",\n      credential_verified: credential.ok,', "R26"),
    "D09_confirmation_alert_skipped": ("worker/refund-flow.mjs", "!rec.confirmation_failure_alerted && (now - since) / 3600e3 >= CONFIRMATION_ALERT_H", "false", "R27"),
    "D10_state_down_silent": ("worker/refund-flow.mjs", "catch { if (on) stateUnavailable = true; }", "catch {}", "R31"),
    "D11_redispatch_disabled": ("worker/refund-flow.mjs", "const redispatch = pendingExisting &&", "const redispatch = false &&", "R33"),
    # Round 3 LOWs: a manifestation never disappears.
    "E01_cas_loss_dropped": ("worker/refund-flow.mjs", "continue; // lost the CAS: re-read and re-decide (L-1)", "return receipt;", "R35"),
    "E02_sandbox_flag_unknown_ignored": ("worker/refund-flow.mjs", "if (testFlagUnknown) decision =", "if (false) decision =", "R36"),
    "E03_ddl_race_not_tolerated": ("worker/refund-state.mjs", "    if (!exists) throw error;", "    throw error;", "R37"),
    "E04_off_reads_new_tables": ("worker/refund-flow.mjs", "if (on || sawOnCopy || await onStatePresent(kv)) {", "if (true) {", "R38"),
    "E05_conflict_rejection_reopens": ("worker/refund-flow.mjs", 'if (conflictRejected && a.identity !== "matched") {', "if (false) {", "R39"),
    "E06_payment_override_optional": ("worker/refund-flow.mjs", "if (override && (decision?.override !== true", "if (false && (decision?.override !== true", "R40"),
    "E07_payment_override_unrecorded": ("worker/refund-flow.mjs", "        ...(override ? { payment_override: true } : {}) },", "        },", "R40"),
    "D12_owner_approve_pg_bypassed": ("worker/refund-flow.mjs", "  try { record = await loadRefund(kv, sql, oid, { on: refundAutoDispatchEnabled(env) }); }\n  catch { return { status: 503, body: { error: \"refund_state_unavailable\" } }; }\n  if (!record) return { status: 404, body: { error: \"refund_request_not_found\" } };\n  if (record.status === \"refunded\"", "  try { record = JSON.parse(await kv.get(KEY(oid)) || \"null\"); }\n  catch { return { status: 503, body: { error: \"refund_state_unavailable\" } }; }\n  if (!record) return { status: 404, body: { error: \"refund_request_not_found\" } };\n  if (record.status === \"refunded\"", "R28"),
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
    "M01_flag_default": ["X01", "X02", "X03", "X04", "X05", "X09", "X10", "X12", "X13", "X14", "X15", "X16", "X17", "X18", "X21", "X22", "X23", "X24", "X25",
                         "R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19",
                         "R20", "R21", "R22", "R23", "R24", "R26", "R27", "R28", "R29", "R30", "R31", "R32", "R33", "R34",
                         "R35", "R36", "R38", "R39", "R40"],
    "M02_prod_test_token": ["X13", "X15", "X18"],
    "M11_credential": ["X13"],
    "M17_amount": ["X10", "X17", "X23", "X25", "R20", "R26", "R29", "R30"],
    "B07_on_identity": ["X16", "R10"],
    "B08_unverified_audit": ["R10"],
    "B09_provider_gate": ["X14", "X15", "R02", "R03", "R16", "R26"],
    "B10_email_match": ["X16", "R01", "R10", "R39"],
    "B13_customer_retry": ["X16", "R01", "R04", "R05", "R22", "R27", "R28"],
    "B15_missing_payment": ["R05", "R06", "R08", "R19", "R21", "R23"],
    "B14_rejected_auto": ["R29", "R39"],
    "C09_lookup_failure_reason": ["R22", "R40"],
    "C14_kv_only_write": ["X20"],
    "C15_held_no_reject": ["R23"],
    "D03_decision_not_persisted": ["R21", "R40"],
    "D12_owner_approve_pg_bypassed": ["R18", "R29", "R34"],
    "B16_execute_identity": ["R07"],
    "C01_conflict_dropped": ["X16", "R39"],
    "C04_unverified_blocks_buyer": ["R35"],
    "C16_owner_approve_no_reeval": ["R40"],
    "C02_unverifiable_dropped": ["R03", "R04", "R16", "R26"],
    "C05_conflict_ack_other_party": ["X16"],
    "C06_request_reeval_disabled": ["R09", "R19"],
    "C17_watchdog_no_reeval": ["R03", "R04", "R19", "R21", "R22", "R36"],
    "C21_identity_alert_skipped": ["X16", "R01"],
    "B11_receipt_protocol": ["X10", "X21", "R01"],
    "B12_receipt_message": ["X03", "X05", "X10"],
}
REASONS = {
    "M01_flag_default": "Inverting the central flag swaps ON and OFF branches for every listed scenario; tests include both paths.",
    "M02_prod_test_token": "Removing the environment/account verification changes routing and the alerts for incompatible production tokens.",
    "M11_credential": "Removing the eligibility gate for an invalid credential changes the reason and route of the sandbox-token scenario.",
    "M17_amount": "Removing payment amount verification converts the listed forced-manual scenarios into automatic refund attempts.",
    "B14_rejected_auto": "R29 and R39 check the same sticky-rejection rule (KV wipe; conflict reopened as previously_rejected).",
    "C09_lookup_failure_reason": "R22 and R40 rely on the same provider-error classification.",
    "C14_kv_only_write": "X20 also asserts that an ON record is never written to KV alone.",
    "C15_held_no_reject": "R23 checks that the owner can still reject after the re-evaluation window.",
    "D03_decision_not_persisted": "R21 and R40 check the owner decision event in the audit trail.",
    "D12_owner_approve_pg_bypassed": "Reading the KV copy in executeRefund breaks every scenario where KV is stale, missing or forged.",
    "B07_on_identity": "Without the mismatch gate, conflicting recipients are not reviewed and the per-order audit cap is bypassed.",
    "B08_unverified_audit": "Without the audit record, the per-order cap/deduplication scenario has nothing to count.",
    "B10_email_match": "Accepting any address removes conflict detection and the audit cap for unconfirmed attempts.",
    "B13_customer_retry": "Every scenario that checks the consumer acknowledgement depends on the shared protocol delivery.",
    "B15_missing_payment": "Without the payment-event gate the held scenarios that are later re-evaluated are never created.",
    "B16_execute_identity": "Without the evidence gate the owner approval of a held request is no longer refused.",
    "C01_conflict_dropped": "X16 and R39 assert the same conflict review (R39 also its sticky rejection).",
    "C04_unverified_blocks_buyer": "R35 needs the buyer to supersede the unconfirmed record after re-reading.",
    "C16_owner_approve_no_reeval": "R40 checks that approval re-evaluates first when the provider recovered.",
    "C02_unverifiable_dropped": "The other unverifiable-identity scenarios share the same classification.",
    "C05_conflict_ack_other_party": "X16 asserts the same matched-address acknowledgement.",
    "C06_request_reeval_disabled": "Request re-evaluation also serves the provider-recovery and original-window scenarios.",
    "C17_watchdog_no_reeval": "Watchdog re-evaluation is shared by the identity re-check and original-window scenarios.",
    "C21_identity_alert_skipped": "The manual-review owner alert is shared by the conflict scenarios.",
    "B09_provider_gate": "Without the credential gate, invalid-account scenarios call the payment endpoint and lose the unverifiable classification.",
    "B11_receipt_protocol": "All successful ON receipt pathways share the protocol field (R01 checks the uniform body keys).",
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
                    "tests/refund-auto-dispatch-review.test.mjs", "tests/helpers/text.mjs", "tests/helpers/refund-state-fake.mjs"]:
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
