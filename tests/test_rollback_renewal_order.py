"""Rollback renewal is GET-only and may start only after post-rollback health succeeds."""
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[1]

class RollbackProofRenewalContract(unittest.TestCase):
    def test_verified_health_precedes_financial_renewal(self):
        source=(ROOT/".github/workflows/central-production-deploy.yml").read_text(encoding="utf-8")
        start=source.index("      - name: Automatic rollback after failed post-deploy smoke")
        end=source.index("      - name: Dispatch exact-production ZEES-16",start)
        rollback=source[start:end]
        self.assertIn("if: failure()",rollback)
        self.assertIn("GH_TOKEN: ${{ github.token }}",rollback)
        self.assertIn('echo "AUTO_ROLLBACK_HEALTH=PASS"',rollback)
        self.assertIn('gh workflow run order12a-financial-proof-renewal.yml',rollback)
        self.assertEqual(rollback.count("gh workflow run order12a-financial-proof-renewal.yml"),1)
        self.assertTrue(rollback.index('echo "AUTO_ROLLBACK_HEALTH=PASS"') <
                        rollback.index('gh workflow run order12a-financial-proof-renewal.yml') <
                        rollback.index('echo "AUTO_ROLLBACK_FINANCIAL_PROOF_RENEWAL_DISPATCH=PASS"') <
                        rollback.index("              exit 0"))
        self.assertIn('if [ "$code" = "200" ] && python3 scripts/deploy/verify-rollback-health.py',rollback)
        self.assertIn('echo "AUTO_ROLLBACK_HEALTH=FAIL"',rollback)

if __name__ == "__main__":
    unittest.main()
