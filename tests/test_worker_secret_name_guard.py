import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[1] / "scripts/deploy/worker_secret_name_guard.py"
spec = importlib.util.spec_from_file_location("secret_name_guard", MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class R111SecretNameTests(unittest.TestCase):
    def make(self, names):
        return {"success": True, "result": [{"name": n, "type": "secret_text", "text": "MUST_NOT_PRINT"} for n in names]}
    def test_three_names_pass(self):
        ok, out = module.check(self.make(["ADMIN_AUTH_MODE","ADMIN_PASSPHRASE","SESSION_SIGNING_KEY","EXTRA"]))
        self.assertTrue(ok)
        self.assertNotIn("MUST_NOT_PRINT", out)
    def test_each_missing_name_fail_closed(self):
        for missing in module.REQUIRED:
            with self.subTest(missing=missing):
                ok, out = module.check(self.make(module.REQUIRED - {missing}))
                self.assertFalse(ok)
                self.assertIn(missing, out)
    def test_invalid_response_fails(self):
        for payload in [None, {}, {"success": False, "result": []}, {"success": True, "result": None},
                        {"success": True, "result": [{"name": None}]}]:
            self.assertFalse(module.check(payload)[0])
    def test_values_never_echoed(self):
        ok, reason = module.check(self.make(["ADMIN_AUTH_MODE"]))
        self.assertFalse(ok)
        self.assertNotIn("MUST_NOT_PRINT", reason)

if __name__ == "__main__":
    unittest.main()
