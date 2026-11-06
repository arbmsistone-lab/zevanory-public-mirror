"""R106 offline contract tests: strict current deployment selection, no network or writes."""
import json
import unittest
from scripts.release.cloudflare_rollback_contract import rollback_payload, validate_payload, SnapshotError

A = "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f"
B = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e"

def response(versions):
    return {"success": True, "result": {"deployments": [{"id": B, "created_on": "2026-11-05T12:00:00Z", "versions": versions}]}}


class RollbackContractTests(unittest.TestCase):
    def test_single_version_current_api(self):
        body = rollback_payload(response([{"version_id": A, "percentage": 100}]))
        self.assertEqual(body["strategy"], "percentage")
        self.assertEqual(body["versions"], [{"version_id": A, "percentage": 100}])
        self.assertNotIn("force", body)
        validate_payload(body)

    def test_split_preserves_percentages(self):
        body = rollback_payload(response([{"version_id": A, "percentage": 25}, {"version_id": B, "percentage": 75}]))
        self.assertEqual(sum(v["percentage"] for v in body["versions"]), 100)
        validate_payload(body)

    def test_oldest_first_selects_latest(self):
        old = {"id": A, "created_on": "2026-11-05T09:00:00Z", "versions": [{"version_id": A, "percentage": 100}]}
        newest = {"id": B, "created_on": "2026-11-05T11:00:00Z", "versions": [{"version_id": B, "percentage": 100}]}
        middle = {"id": A, "created_on": "2026-11-05T10:00:00Z", "versions": [{"version_id": A, "percentage": 100}]}
        self.assertEqual(rollback_payload({"success": True, "result": {"deployments": [old, middle, newest]}})["versions"][0]["version_id"], B)

    def test_newest_first_selects_same_latest(self):
        old = {"created_on": "2026-11-05T09:00:00.000Z", "versions": [{"version_id": A, "percentage": 100}]}
        newest = {"created_on": "2026-11-05T11:00:00.000Z", "versions": [{"version_id": B, "percentage": 100}]}
        middle = {"created_on": "2026-11-05T10:00:00.000Z", "versions": [{"version_id": A, "percentage": 100}]}
        self.assertEqual(rollback_payload({"success": True, "result": {"deployments": [newest, middle, old]}})["versions"][0]["version_id"], B)

    def test_timezone_normalization_and_split_weights(self):
        early = {"created_on": "2026-11-05T11:00:00+00:00", "versions": [{"version_id": A, "percentage": 100}]}
        latest = {"created_on": "2026-11-05T09:30:00-03:00", "versions": [
            {"version_id": A, "percentage": 30}, {"version_id": B, "percentage": 70}
        ]}
        body = rollback_payload({"success": True, "result": {"deployments": [early, latest]}})
        self.assertEqual(body["versions"], [{"version_id": A, "percentage": 30}, {"version_id": B, "percentage": 70}])

    def test_missing_invalid_and_tied_dates_fail_closed(self):
        valid = {"created_on": "2026-11-05T12:00:00Z", "versions": [{"version_id": A, "percentage": 100}]}
        bad = [
            [valid, {"versions": [{"version_id": B, "percentage": 100}]}],
            [valid, {"created_on": None, "versions": [{"version_id": B, "percentage": 100}]}],
            [valid, {"created_on": "not-an-iso-date", "versions": [{"version_id": B, "percentage": 100}]}],
            [valid, {"created_on": "2026-11-05T13:00:00", "versions": [{"version_id": B, "percentage": 100}]}],
            [valid, {"created_on": "2026-11-05T09:00:00-03:00", "versions": [{"version_id": B, "percentage": 100}]}],
            [valid, {"created_on": "2026-11-05T12:00:00Z", "versions": [{"version_id": B, "percentage": 100}]}],
        ]
        for deployments in bad:
            with self.subTest(deployments=deployments), self.assertRaises(SnapshotError):
                rollback_payload({"success": True, "result": {"deployments": deployments}})

    def test_legacy_result_list_order_is_also_independent(self):
        early = {"created_on": "2026-11-05T10:00:00Z", "versions": [{"version_id": A, "percentage": 100}]}
        latest = {"created_on": "2026-11-05T12:00:00Z", "versions": [{"version_id": B, "percentage": 100}]}
        self.assertEqual(rollback_payload({"success": True, "result": [early, latest]})["versions"][0]["version_id"], B)

    def test_no_prior_release(self):
        self.assertIsNone(rollback_payload({"success": True, "result": {"deployments": []}}))

    def test_fail_closed_invalid_snapshots(self):
        broken = [
            {"success": False, "result": {"deployments": []}},
            {"success": True, "result": {}},
            response([]),
            response([{"version_id": "not-uuid", "percentage": 100}]),
            response([{"version_id": A, "percentage": 99}]),
            response([{"version_id": A, "percentage": 100.0001}]),
            response([{"version_id": A, "percentage": 100}, {"version_id": A, "percentage": 0.01}]),
            response([{"version_id": A, "percentage": "NaN"}]),
            response([{"version_id": A, "percentage": 0}]),
        ]
        for item in broken:
            with self.subTest(item=item), self.assertRaises(SnapshotError):
                rollback_payload(item)

    def test_payload_never_accepts_unexpected_keys(self):
        body = rollback_payload(response([{"version_id": A, "percentage": 100}]))
        for extra in [{"force": True}, {"script_name": "zevanory-sales-public"}]:
            with self.assertRaises(SnapshotError):
                validate_payload({**body, **extra})


if __name__ == "__main__":
    unittest.main()
