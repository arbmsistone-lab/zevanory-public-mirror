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


class ReadOnlyDatabase:
    def __init__(self, result=(2, 0, 0, 0, 0)):
        self.statements = []
        self.result = result
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def cursor(self):
        return self
    def execute(self, sql, args=None):
        self.statements.append((sql, args))
        return self
    def fetchone(self):
        return self.result


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

    def test_no_raw_customer_record_selected_or_logged(self):
        upper = watchdog.CHECKOUT_SQL.upper()
        self.assertNotIn(" EMAIL", upper)
        self.assertNotIn(" PAYER", upper)
        self.assertNotIn("EXTERNAL_REFERENCE", upper)
        self.assertIn("BEGIN READ ONLY", __import__("inspect").getsource(watchdog.read_paid_delivery_counts))
        self.assertIn("certification_pilot", watchdog.CHECKOUT_SQL)
        self.assertIn("interval '15 minutes'", watchdog.CHECKOUT_SQL)
        self.assertIn("coalesce(confirmed_at,updated_at)", watchdog.CHECKOUT_SQL.lower())

    def test_database_read_only_aggregate(self):
        db = ReadOnlyDatabase()
        options = {}
        def connect(*args, **kwargs):
            options.update(kwargs)
            return db
        with patch.dict("os.environ", {"DATABASE_URL": "postgresql://dummy@localhost/db"}):
            result = watchdog.read_paid_delivery_counts(connector=connect)
        self.assertTrue(options.get("autocommit"), "BEGIN READ ONLY must not be nested inside an implicit transaction")
        self.assertEqual(options.get("sslmode"), "require")
        self.assertEqual(result, COUNTS)
        self.assertEqual(db.statements[0][0], "BEGIN READ ONLY")
        self.assertEqual(db.statements[-1][0], "ROLLBACK")
        self.assertIn("%(launch)s", db.statements[1][0])
        self.assertNotIn("DELETE FROM", db.statements[1][0])

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
        self.assertIn("DATABASE_URL", watch["env"])
        self.assertIn("RESEND_API_KEY", watch["env"])
        self.assertEqual(wf["concurrency"]["group"], "zevanory-owner-sales-switch")

    def test_get_requests_are_only_read_in_stub(self):
        seen = []
        def stub(path):
            seen.append(path)
            return {"ok": True}
        self.assertEqual(watchdog.get_status("/api/status", fetch=stub), {"ok": True})
        self.assertEqual(seen, ["/api/status"])


if __name__ == "__main__":
    unittest.main()
