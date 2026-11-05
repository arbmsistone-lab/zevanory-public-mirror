"""R103 offline contract tests: no network, secrets, deploy or rollback."""
import json
import unittest
from scripts.release.cloudflare_rollback_contract import rollback_payload, validate_payload, SnapshotError

A = "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f"
B = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e"

def response(versions):
    return {"success": True, "result": {"deployments": [{"id": B, "versions": versions}]}}


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
