import importlib.util
import io
import json
import urllib.error
from contextlib import redirect_stdout
import pathlib
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "financial_proof_renewal.py"
SPEC = importlib.util.spec_from_file_location("financial_proof_renewal", PATH)
renewal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renewal)
SECRET = "test-secret-not-for-production-" + "s" * 40
SHA = "a" * 40

GOOD_AUDIT = {
    "complete": True, "ambiguous": 0, "snapshot_persist": "proven",
    "financial_snapshot": {"accepted": True, "verified_flag": True, "schema_ok": True,
                           "release_matches": True, "age_minutes": 0, "ambiguous": 0}
}
GOOD_STATUS = {
    "sales_authorization": {"state": "open_authorized", "authorized_by_owner": True},
    "commercial_metrics_provenance": {"state": "PROVEN", "commercial_release_allowed": True,
                                      "exact_release": True},
    "gate": "G3", "runtime": {"sales": "enabled"}
}


def fake_fetch(path, secret=""):
    if path == "/api/release":
        return 200, {"deployment": {"commit_sha": SHA}}
    if path == "/api/sales/status":
        return 200, {"open": True}
    if path == renewal.AUDIT_PATH:
        assert secret == SECRET
        return 200, GOOD_AUDIT
    if path == "/api/status":
        return 200, GOOD_STATUS
    raise AssertionError(path)


class FinancialProofRenewalTests(unittest.TestCase):
    def test_409_json_body_preserved_and_sanitized(self):
        payload = {
            "ambiguous": 1,
            "evidence_reasons": [{"reason": "ambiguo:order_missing", "count": 1}],
            "evidence_breakdown": [{
                "classification": "ambiguo", "provider": "mercadopago",
                "event": "payment_confirmed", "pilot": "pilot_false",
                "id_format": "mercadopago_numeric",
                "marker_hint": "not_classifiable_from_prefix", "count": 1
            }],
            "payment_ids": {"ambiguo": ["12345678"]},
            "customer_name": "NEVER_LOG_CUSTOMER",
        }
        error = urllib.error.HTTPError("https://example.invalid", 409, "Conflict", {}, io.BytesIO(json.dumps(payload).encode()))
        with patch.object(renewal.urllib.request, "urlopen", side_effect=error):
            code, body = renewal.get_json(renewal.AUDIT_PATH, SECRET)
        self.assertEqual((code, body), (409, payload))
        capture = io.StringIO()
        with redirect_stdout(capture), self.assertRaisesRegex(renewal.RenewalError, "AUDIT_HTTP_409"):
            renewal.validate_audit(code, body)
        output = capture.getvalue()
        self.assertIn('ORD12A_AMBIG_IDS=["5678"]', output)
        self.assertIn("ORD12A_REASONS=", output)
        self.assertIn("ORD12A_BREAKDOWN=", output)
        self.assertNotIn("12345678", output)
        self.assertNotIn("NEVER_LOG_CUSTOMER", output)

    def test_hmac_contract_matches_worker(self):
        at = "1791580200"
        expected = __import__("hmac").new(
            SECRET.encode(), ("GET\n" + renewal.AUDIT_PATH + "\n" + at).encode(),
            __import__("hashlib").sha256).hexdigest()
        self.assertEqual(renewal.signature(SECRET, renewal.AUDIT_PATH, at), expected)

    def test_proves_open_g3_with_signed_get_only(self):
        called = []

        def getter(path, secret=""):
            called.append((path, bool(secret)))
            return fake_fetch(path, secret)

        out = renewal.renew(SECRET, fetch=getter, retries=1)
        self.assertEqual(out["release_sha12"], "a" * 12)
        self.assertEqual(out["gate"], "G3")
        self.assertEqual(called, [
            ("/api/release", False), ("/api/sales/status", False),
            (renewal.AUDIT_PATH, True), ("/api/status", False)])

    def test_rejects_expired_unverified_or_wrong_release_snapshot(self):
        for key, value in [
            ("accepted", False), ("verified_flag", False), ("schema_ok", False),
            ("release_matches", False), ("age_minutes", 20), ("ambiguous", 1)
        ]:
            data = {**GOOD_AUDIT, "financial_snapshot": {**GOOD_AUDIT["financial_snapshot"], key: value}}
            with self.subTest(key=key), self.assertRaises(renewal.RenewalError):
                renewal.validate_audit(200, data)

    def test_never_trusts_red_classification_or_unpersisted_snapshot(self):
        for code, body in [
            (409, GOOD_AUDIT),
            (200, {**GOOD_AUDIT, "ambiguous": 1}),
            (200, {**GOOD_AUDIT, "snapshot_persist": "unverified_not_persisted"}),
        ]:
            with self.assertRaises(renewal.RenewalError):
                renewal.validate_audit(code, body)

    def test_does_not_reopen_closed_switch(self):
        def getter(path, secret=""):
            if path == "/api/sales/status":
                return 200, {"open": False}
            return fake_fetch(path, secret)
        with self.assertRaisesRegex(renewal.RenewalError, "SWITCH_NOT_OPEN"):
            renewal.renew(SECRET, fetch=getter, retries=1)

    def test_requires_proven_financial_gate_and_authorization(self):
        for change in [
            {"gate": "G2"}, {"runtime": {"sales": "globally-blocked"}},
            {"sales_authorization": {"state": "open_authorized_proof_pending", "authorized_by_owner": True}},
            {"commercial_metrics_provenance": {"state": "UNVERIFIED_FAIL_CLOSED"}},
            {"commercial_metrics_provenance": {"state": "PROVEN", "commercial_release_allowed": False, "exact_release": True}},
        ]:
            with self.subTest(change=change), self.assertRaises(renewal.RenewalError):
                renewal.validate_status(200, {**GOOD_STATUS, **change}, SHA)

    def test_two_independent_cron_contracts_and_fixed_proof_ttl(self):
        root = PATH.parents[1]
        central = (root / "scripts/deploy/prepare-central-candidate.py").read_text("utf-8")
        worker = (root / "worker/cloudflare-worker.compat.mjs").read_text("utf-8")
        workflow = (root / ".github/workflows/order12a-financial-proof-renewal.yml").read_text("utf-8")
        metrics = (root / "worker/commercial-metrics-projection.mjs").read_text("utf-8")
        self.assertIn('15,45 * * * *', central)
        self.assertIn('15,45 * * * *', worker)
        self.assertIn('force: true', worker)
        self.assertIn('cron: "11,41 * * * *"', workflow)
        self.assertIn("65*60*1000", metrics)
        self.assertIn("github.event_name != 'pull_request'", workflow)
        self.assertNotIn("sales:open:v1", workflow)

    def test_status_retry_uses_last_result_not_fake_success(self):
        attempts = {"status": 0}
        def getter(path, secret=""):
            if path == "/api/status":
                attempts["status"] += 1
                if attempts["status"] == 1:
                    return 200, {**GOOD_STATUS, "gate": "G2"}
            return fake_fetch(path, secret)
        out = renewal.renew(SECRET, fetch=getter, retries=2, pause=lambda _: None)
        self.assertEqual(out["gate"], "G3")
        self.assertEqual(attempts["status"], 2)
        with self.assertRaisesRegex(renewal.RenewalError, "AUDIT_SECRET_MISSING"):
            renewal.renew("short", fetch=getter, retries=1)


if __name__ == "__main__":
    unittest.main()
