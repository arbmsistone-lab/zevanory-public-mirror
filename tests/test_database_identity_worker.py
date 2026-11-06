"""B07 T4 (classe B): worker/database-identity.mjs gera o MESMO hash que scripts/ops/database_url_inventory.py para os
mesmos vetores FALSOS, e o /api/health do Worker publica só esse hash (nunca a URL). Requer node (o runner tem)."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
JS = Path(os.environ.get("DBINV_JS", ROOT / "worker/database-identity.mjs"))
RECOVERED = ROOT / "worker/cloudflare-worker.recovered.mjs"
NEW_HOST = "ep-fake-new-000111.sa-east-1.aws.neon.tech"
NEW = f"postgresql://fakeuser:FAKE_PASSWORD_1@{NEW_HOST}/fakedb?sslmode=require"
NEW_POOLED = "postgres://pooluser7:FAKE_PASSWORD_2@EP-FAKE-NEW-000111-POOLER.sa-east-1.aws.neon.tech.:5432/x"
OLD = "postgresql://fakeuser:FAKE_PASSWORD_3@ep-fake-old-999888.us-east-2.aws.neon.tech/fakedb"


def python_hash(url):
    spec = __import__("importlib.util").util.spec_from_file_location("dbinv", ROOT / "scripts/ops/database_url_inventory.py")
    m = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(m)
    r = m.identity(url) if url else None
    return r[0] if r else "null"


class WorkerIdentity(unittest.TestCase):
    def test_worker_module_hashes_exactly_like_python(self):
        node = shutil.which("node")
        self.assertIsNotNone(node)
        vec = [NEW, NEW_POOLED, OLD, "postgresql://u:p@db.example.internal/x", "not a url", "",
               "https://ep-x.neon.tech/db", "postgresql://u:p@h_o_st/db", "postgres://"]
        code = ("import {databaseHostSha256} from %s;" % json.dumps(JS.as_uri())
                + "for (const u of JSON.parse(process.argv[1])) console.log(String(databaseHostSha256(u)));"
                + "console.log(String(databaseHostSha256(undefined)));")
        p = subprocess.run([node, "--input-type=module", "-e", code, json.dumps(vec)], capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        got = p.stdout.split()
        self.assertEqual(got[:-1], [python_hash(u) for u in vec])
        self.assertEqual(got[-1], "null")
        self.assertEqual(got[0], hashlib.sha256(NEW_HOST.encode()).hexdigest())
        self.assertEqual(got[0], got[1], "direto e pooler do mesmo endpoint")
        self.assertNotIn("FAKE_PASSWORD", p.stdout)

    def test_health_publishes_only_the_hash(self):
        src = RECOVERED.read_text()
        self.assertTrue(src.startswith('import { saveWhatsappObservation } from "./voice-operational-audit.mjs";\n'
                                       'import { databaseHostSha256 } from "./database-identity.mjs";\n'))
        self.assertEqual(src.count("databaseHostSha256(process.env.DATABASE_URL)"), 1)
        self.assertEqual(src.count("database_host_sha256: databaseHostHash"), 2)  # resposta completa e pública
        start = src.index("async function healthProbe(req, res) {")
        body = src[start:src.index('__name(healthProbe, "healthProbe");')]
        self.assertNotIn("DATABASE_URL,", body)
        self.assertNotIn("database_url", body.lower().replace("database_url)", ""))


if __name__ == "__main__":
    unittest.main()
