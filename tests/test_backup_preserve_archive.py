import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts", "ops"))
import backup_preserve_archive as m  # noqa: E402

PASS = "x" * 40
SECRET_MARK = "joao@exemplo.com"  # dado pessoal fictício: NUNCA pode aparecer em log


def fake_parts():
    t1 = json.dumps([{"id": 1, "email": SECRET_MARK}, {"id": 2, "email": "b@c.d"}])
    t2 = json.dumps([{"k": "v"}])
    t3 = json.dumps([])
    return {0: json.dumps({"zevanory_leads": t1}).encode(), 1: json.dumps({"orders": t2}).encode(), 2: json.dumps({"empty_table": t3}).encode()}


class FakeKV:
    def __init__(self, parts, day="2026-10-14"):
        self.store = {m.bundle_key(day, p): v for p, v in parts.items()}
        self.puts = []

    def list(self, token, prefix):
        return [{"name": k, "expiration": 1792656000} for k in self.store if k.startswith(prefix)]

    def get(self, token, key):
        return self.store[key]

    def put(self, token, key, value, ttl):
        self.puts.append((key, ttl))
        self.store[key] = value


class PreserveTests(unittest.TestCase):
    def run_mode(self, argv, kv):
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS, "CLOUDFLARE_API_TOKEN": "t"}), \
             mock.patch.object(m, "kv_list", kv.list), mock.patch.object(m, "kv_get", kv.get), mock.patch.object(m, "kv_put", kv.put), \
             redirect_stdout(buf):
            res = m.main(argv)
        return res, buf.getvalue()

    def test_archive_then_verify_roundtrip_without_leaking_data(self):
        kv = FakeKV(fake_parts())
        with tempfile.TemporaryDirectory() as d:
            man, log1 = self.run_mode(["archive", "--out", d, "--expected-tables", "3", "--expected-rows", "3"], kv)
            self.assertEqual(man["totals"], {"parts": 3, "tables": 3, "rows": 3})
            with mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS}), redirect_stdout(io.StringIO()) as b:
                res = m.mode_verify(m.argparse.Namespace(out=d), restore=False)
            self.assertEqual(res["hashes"], "ok")
            blob = open(os.path.join(d, "archive.enc"), "rb").read()
            manifest_txt = open(os.path.join(d, "manifest.json")).read()
            for text in (log1, b.getvalue(), manifest_txt):
                self.assertNotIn(SECRET_MARK, text)
            self.assertNotIn(SECRET_MARK.encode(), blob)  # cifrado

    def test_manifest_sha_matches_worker_definition(self):
        parts = fake_parts()
        tables = m.describe_bundles(parts)
        js = json.loads(parts[0])["zevanory_leads"]
        self.assertEqual(tables["zevanory_leads"]["sha256"], m.sha256_hex(js))
        self.assertEqual(tables["zevanory_leads"]["rows"], 2)

    def test_expected_counts_enforced(self):
        kv = FakeKV(fake_parts())
        with tempfile.TemporaryDirectory() as d, self.assertRaises(SystemExit):
            self.run_mode(["archive", "--out", d, "--expected-tables", "51", "--expected-rows", "18142"], kv)

    def test_tampered_archive_rejected(self):
        kv = FakeKV(fake_parts())
        with tempfile.TemporaryDirectory() as d:
            self.run_mode(["archive", "--out", d, "--expected-tables", "3", "--expected-rows", "3"], kv)
            p = os.path.join(d, "archive.enc")
            b = bytearray(open(p, "rb").read()); b[-1] ^= 1; open(p, "wb").write(bytes(b))
            with mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS}), redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                m.mode_verify(m.argparse.Namespace(out=d), restore=False)

    def test_wrong_passphrase_rejected(self):
        blob = m.encrypt(b"abc", PASS)
        with self.assertRaises(Exception):
            m.decrypt(blob, "y" * 40)

    def test_short_passphrase_refused(self):
        with mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": "curta"}), redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            m.passphrase_or_fail()

    def test_missing_part_fails_inspect(self):
        parts = fake_parts(); del parts[2]
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            self.run_mode(["inspect"], FakeKV(parts))

    def test_kv_extend_requires_exact_confirmation_and_never_touches_original(self):
        kv = FakeKV(fake_parts())
        with self.assertRaises(SystemExit):
            self.run_mode(["kv-extend"], kv)
        before = dict(kv.store)
        self.run_mode(["kv-extend", "--confirm", "PRESERVAR 2026-10-14", "--ttl-days", "75"], kv)
        for k, v in before.items():
            self.assertEqual(kv.store[k], v)
        self.assertEqual(sorted(k for k, _ in kv.puts), sorted(m.preserved_key("2026-10-14", p) for p in range(3)))
        self.assertTrue(all(t == 75 * 86400 for _, t in kv.puts))

    def test_invalid_table_name_rejected(self):
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            m.describe_bundles({0: json.dumps({"x; drop": "[]"}).encode()})


if __name__ == "__main__":
    unittest.main()
