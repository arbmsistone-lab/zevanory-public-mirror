import importlib.util
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "provider_independence_gate",
    ROOT / "scripts" / "provider_independence_gate.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderIndependenceSalesAuthorityTests(unittest.TestCase):
    def test_open_switch_requires_enabled_runtime_and_commercial_quorum(self):
        self.assertIsNone(MODULE.validate_live_sales_authority(
            {"runtime": {"sales": "enabled"}},
            {"open": True},
            ["zevanory", "email", "whatsapp"],
        ))
        self.assertIn("authority mismatch", MODULE.validate_live_sales_authority(
            {"runtime": {"sales": "globally-blocked"}},
            {"open": True},
            [],
        ))

    def test_closed_switch_remains_fail_closed(self):
        self.assertIsNone(MODULE.validate_live_sales_authority(
            {"runtime": {"sales": "globally-blocked"}},
            {"open": False},
            [],
        ))
        self.assertIn("unexpectedly active", MODULE.validate_live_sales_authority(
            {"runtime": {"sales": "globally-blocked"}},
            {"open": False},
            ["zevanory"],
        ))


if __name__ == "__main__":
    unittest.main()
