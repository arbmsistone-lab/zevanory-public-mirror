import importlib.util
import io
import pathlib
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts/zevanory_first_order_watch.py"
S = importlib.util.spec_from_file_location("zevanory_first_order_watch", PATH)
watchdog = importlib.util.module_from_spec(S)
S.loader.exec_module(watchdog)

STATUS = {
    "gate": "G3",
    "sales_authorization": {"state": "open_authorized"},
    "metrics": {"orders": 0, "payments_confirmed": 0, "checkouts_started": 2},
}
SALES = {"open": True}
COUNTS = {"checkouts": 2, "paid": 0, "delivered": 0, "overdue_paid": 0, "fulfillment_failed": 0}
CANON = {
    "GITHUB_REF": "refs/heads/gh-pages",
    "GITHUB_EVENT_NAME": "schedule",
    "GITHUB_WORKFLOW_REF": "arbmsistone-lab/zevanory-public-mirror/.github/workflows/zevanory-first-order-watch.yml@refs/heads/gh-pages",
}


def run(status=STATUS, sales=SALES, counts=COUNTS, *, env=CANON):
    calls = []
    with patch.dict("os.environ", env), redirect_stdout(io.StringIO()) as stdout:
        report = watchdog.watch(status, sales, counts,
            close_impl=lambda reason: calls.append(("close", reason)) or True,
            alert_impl=lambda reason: calls.append(("email", reason)) or True,
            comment_impl=lambda reason: calls.append(("issue", reason)) or True)
    return report, calls, stdout.getvalue()


class FirstOrderWatchTests(unittest.TestCase):
    def test_no_paid_order_no_close_or_owner_email(self):
        result, calls, out = run()
        self.assertFalse(result["breach"])
        self.assertEqual(calls, [])
        self.assertIn("ZEVANORY_WATCH_RESULT::NO_DELIVERY_BREACH", out)
        self.assertNotIn("customer", out)

    def test_paid_within_15_minutes_does_not_close(self):
        data = {**COUNTS, "paid": 1}
        result, calls, _ = run(counts=data)
        self.assertEqual(calls, [])
        self.assertFalse(result["breach"])

    def test_overdue_paid_closes_and_alerts_only_once(self):
        data = {**COUNTS, "paid": 1, "overdue_paid": 1}
        result, calls, logs = run(counts=data)
        self.assertEqual(result["reason"], "PAID_UNDELIVERED_15M")
        self.assertEqual(calls, [("close", "PAID_UNDELIVERED_15M"),
                                 ("email", "PAID_UNDELIVERED_15M"),
                                 ("issue", "PAID_UNDELIVERED_15M")])
        self.assertIn("ZEVANORY_EMERGENCY_CLOSE::CONFIRMED", logs)

    def test_explicit_failed_webhook_closes(self):
        data = {**STATUS, "webhook_health": {"status": "failed"}}
        r, calls, _ = run(status=data)
        self.assertEqual(r["reason"], "WEBHOOK_FAILED")
        self.assertEqual(calls[0][0], "close")

    def test_delivery_failure_closes(self):
        data = {**COUNTS, "paid": 1, "fulfillment_failed": 1}
        r, calls, _ = run(counts=data)
        self.assertEqual(r["reason"], "FULFILLMENT_FAILED")
        self.assertEqual(calls[0][0], "close")

    def test_closed_switch_never_reopens_or_spams(self):
        data = {**COUNTS, "paid": 1, "overdue_paid": 1}
        r, calls, _ = run(sales={"open": False}, counts=data)
        self.assertTrue(r["breach"])
        self.assertEqual(calls, [])

    def test_failed_owner_email_marks_job_failed(self):
        data = {**COUNTS, "paid": 1, "overdue_paid": 1}
        with patch.dict("os.environ", CANON), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(watchdog.WatchError, "EMERGENCY_RESPONSE_INCOMPLETE"):
                watchdog.watch(STATUS, SALES, data, close_impl=lambda _: True,
                    alert_impl=lambda _: False, comment_impl=lambda _: True)

    def test_wrong_ref_cannot_close_even_with_breach(self):
        with patch.dict("os.environ", {**CANON, "GITHUB_REF": "refs/pull/1/merge"}):
            with self.assertRaisesRegex(watchdog.WatchError, "CANONICAL_WATCH_REQUIRED"):
                watchdog.emergency_close("PAID_UNDELIVERED_15M", close_impl=lambda _: True)

    def test_hmac_signed_get_only_returns_aggregates_without_database_secret(self):
        import hashlib, hmac
        captured = []
        def signed(path, headers):
            captured.append((path, headers))
            return {"schema": "zevanory.first-order-watch.v1", "counts": COUNTS}
        with patch.dict("os.environ", {"CERTIFICATION_E2E_TOKEN": "k"*40}, clear=True):
            output = watchdog.read_paid_delivery_counts(fetch=signed)
        self.assertEqual(output, COUNTS)
        self.assertEqual(len(captured), 1)
        path, headers = captured[0]
        self.assertEqual(path, "/api/internal/watch/paid-delivery")
        expected = hmac.new(b"k"*40, ("GET\n"+path+"\n"+headers["x-zevanory-audit-ts"]).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(headers["x-zevanory-audit-signature"], expected)
        self.assertNotIn("DATABASE_URL", __import__("inspect").getsource(watchdog))
        self.assertNotIn("psycopg", __import__("inspect").getsource(watchdog))

    def test_missing_secret_and_invalid_aggregates_fail_closed(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(watchdog.WatchError, "AUDIT_SECRET_MISSING"):
                watchdog.read_paid_delivery_counts(fetch=lambda *_: None)
        for data in [None, {"paid": 1}, {**COUNTS, "paid": True},
                     {**COUNTS, "paid": -1}, {**COUNTS, "overdue_paid": 1}]:
            with patch.dict("os.environ", {"CERTIFICATION_E2E_TOKEN":"k"*40}, clear=True):
                with self.assertRaises(watchdog.WatchError):
                    watchdog.read_paid_delivery_counts(
                        fetch=lambda *_: {"schema":"zevanory.first-order-watch.v1","counts":data})

    def test_yaml_has_hourly_schedule_and_sealed_production_gate(self):
        import yaml
        wf = yaml.safe_load((ROOT / ".github/workflows/zevanory-first-order-watch.yml").read_text())
        on = wf.get("on", wf.get(True))
        self.assertEqual(on["schedule"][0]["cron"], "7 * * * *")
        self.assertIn("workflow_dispatch", on)
        self.assertIn("pull_request", on)
        watch = wf["jobs"]["first-order-watch"]
        self.assertIn("github.event_name != 'pull_request'", watch["if"])
        self.assertIn("refs/heads/gh-pages", watch["if"])
        self.assertNotIn("DATABASE_URL", watch["env"])
        self.assertIn("RESEND_API_KEY", watch["env"])
        self.assertIn("CERTIFICATION_E2E_TOKEN", watch["env"])
        self.assertEqual(wf["concurrency"]["group"], "zevanory-owner-sales-switch")

    def test_actions_never_receives_primary_database_credentials(self):
        workflow = (ROOT / ".github/workflows/zevanory-first-order-watch.yml").read_text()
        self.assertNotIn("DATABASE_URL", workflow)
        self.assertNotIn("psycopg", workflow)
        self.assertIn("CERTIFICATION_E2E_TOKEN", workflow)
        self.assertIn("CLOUDFLARE_API_TOKEN", workflow)

    def test_get_requests_are_only_read_in_stub(self):
        seen = []
        def stub(path):
            seen.append(path)
            return {"ok": True}
        self.assertEqual(watchdog.get_status("/api/status", fetch=stub), {"ok": True})
        self.assertEqual(seen, ["/api/status"])


if __name__ == "__main__":
    unittest.main()
