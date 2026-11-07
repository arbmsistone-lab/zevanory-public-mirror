import base64
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



# ---------------- P20: bundles cifrados pelo Worker (envelope AES-256-GCM) ----------------
# Vetor fixo gerado por scripts/p20/backup-envelope.mjs (node:crypto) com chave sintética 0x07*32 e nonce fixo
# 000102..0b SÓ para este vetor: prova que o Python lê exatamente o envelope do Worker/ensaio.
KAT_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="
KAT_KID = "d14e095550c4e08d"
KAT_ENV = ('{"$enc":"zevanory-backup-enc/v1","v":1,"alg":"A256GCM","kid":"d14e095550c4e08d","nonce":"AAECAwQFBgcICQoL",'
           '"aad":{"day":"2026-11-02","part":1,"key":"zpc:backup:v1:neon:2026-11-02:part:1"},'
           '"ct":"Y6OGAnlsqzpViMfHmQROk4VglLQpTisTc6MC0+KLTz+CTSyN9qBxmIyArsYwmJtQm10AW6n5n8pTJtDQgvopshBtfpxHlUOiFx9a5NU+gbyiiQA="}')
KAT_PT = json.dumps({"orders": json.dumps([{"id": 1, "email": SECRET_MARK}, {"id": 2}], separators=(",", ":"))}, separators=(",", ":"))
DAY = "2026-11-02"
OTHER_KEY = base64.b64encode(bytes(range(32))).decode()


def seal(pt, day, part, key_b64):
    """Envelope de teste (mesmo contrato), cifrado aqui com AESGCM: terceira implementação independente do selo."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw, nonce = base64.b64decode(key_b64), os.urandom(12)
    ct = AESGCM(raw).encrypt(nonce, pt.encode(), m.aad_bytes(day, part))
    return json.dumps({"$enc": "zevanory-backup-enc/v1", "v": 1, "alg": "A256GCM", "kid": m.kid_of(raw), "nonce": base64.b64encode(nonce).decode(),
                       "aad": {"day": day, "part": part, "key": m.bundle_key(day, part)}, "ct": base64.b64encode(ct).decode()}, separators=(",", ":"))


def enc_parts():
    """Parte 0 legado em claro; 1 = vetor do node; 2 = envelope cifrado aqui."""
    return {0: json.dumps({"empty_table": "[]"}).encode(), 1: KAT_ENV.encode(),
            2: seal(json.dumps({"zevanory_leads": json.dumps([{"email": SECRET_MARK}])}), DAY, 2, KAT_KEY).encode()}


class EncryptedBundleTests(unittest.TestCase):
    def run_mode(self, argv, kv, keys=None):
        env = {"BACKUP_ARCHIVE_PASSPHRASE": PASS, "CLOUDFLARE_API_TOKEN": "t"}
        buf = self.last = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(m, "kv_list", kv.list), mock.patch.object(m, "kv_get", kv.get), redirect_stdout(buf):
            os.environ.pop("P20_BACKUP_KEYS", None)
            if keys is not None:
                os.environ["P20_BACKUP_KEYS"] = keys
            res = m.main(argv)
        return res, buf.getvalue()

    def verify(self, d, keys=None):
        buf = self.last = io.StringIO()
        with mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS}), redirect_stdout(buf):
            os.environ.pop("P20_BACKUP_KEYS", None)
            if keys is not None:
                os.environ["P20_BACKUP_KEYS"] = keys
            res = m.mode_verify(m.argparse.Namespace(out=d), restore=False)
        return res, buf.getvalue()

    def archive(self, d, keys=None, parts=None):
        return self.run_mode(["archive", "--day", DAY, "--out", d, "--expected-tables", "3", "--expected-rows", "3"], FakeKV(parts or enc_parts(), DAY), keys)

    def rewrite(self, d, fn, outer_only=True):
        """Adultera um envelope DENTRO do archive.enc, recifrando com a senha (atacante que tem a senha). outer_only:
        recalcula só os hashes do arquivo; senão também parts_sha256 (só a tag/estrutura do envelope pode pegar)."""
        man = json.load(open(os.path.join(d, "manifest.json")))
        doc = json.loads(m.decrypt(open(os.path.join(d, "archive.enc"), "rb").read(), PASS))
        doc["parts"]["1"] = fn(doc["parts"]["1"])
        pt = json.dumps(doc, separators=(",", ":")).encode()
        blob = m.encrypt(pt, PASS)
        open(os.path.join(d, "archive.enc"), "wb").write(blob)
        man["plaintext_sha256"], man["ciphertext_sha256"] = m.sha256_hex(pt), m.sha256_hex(blob)
        if not outer_only:
            man["parts_sha256"]["1"] = m.sha256_hex(doc["parts"]["1"].encode())
        json.dump(man, open(os.path.join(d, "manifest.json"), "w"))

    def test_kat_node_envelope_opens_in_python(self):
        ring = m.parse_keyring(KAT_KEY)
        self.assertEqual(list(ring), [KAT_KID], "kid derivado igual ao do node")
        self.assertEqual(m.open_envelope(json.loads(KAT_ENV), DAY, 1, ring), KAT_PT)
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            m.open_envelope(json.loads(KAT_ENV), DAY, 2, ring)  # AAD de outra parte
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            m.parse_keyring(json.dumps({"0" * 16: KAT_KEY}))  # kid declarado diferente do derivado

    def test_archive_and_verify_with_key_check_content_and_write_no_new_plaintext(self):
        with tempfile.TemporaryDirectory() as d:
            man, log = self.archive(d, KAT_KEY)
            self.assertEqual(man["content_state"], m.ST_ENC_OK)
            self.assertEqual(man["totals"], {"parts": 3, "tables": 3, "rows": 3})
            self.assertEqual({p: i["state"] for p, i in man["parts"].items()}, {"0": m.ST_PLAIN, "1": m.ST_ENC_OK, "2": m.ST_ENC_OK})
            doc = json.loads(m.decrypt(open(os.path.join(d, "archive.enc"), "rb").read(), PASS))
            self.assertEqual(doc["parts"]["1"], KAT_ENV, "envelope arquivado como está")
            self.assertNotIn(SECRET_MARK, json.dumps(doc), "nenhum texto claro novo dentro do arquivo")
            res, vlog = self.verify(d, KAT_KEY)
            self.assertEqual((res["content_state"], res["tables"], res["rows"]), (m.ST_ENC_OK, 3, 3))
            for t in (log, vlog, open(os.path.join(d, "manifest.json")).read()):
                self.assertNotIn(SECRET_MARK, t)
                self.assertNotIn(KAT_KEY, t)

    def test_archive_and_verify_without_key_are_opaque_and_say_so(self):
        with tempfile.TemporaryDirectory() as d:
            man, log = self.archive(d)
            self.assertEqual(man["content_state"], m.ST_ENC_OPAQUE)
            self.assertIn("BACKUP_PRESERVE_NAO_VERIFICADO", log)
            self.assertEqual(man["parts"]["1"], {"format": "cifrado", "state": m.ST_ENC_OPAQUE, "kid": KAT_KID})
            self.assertEqual(man["totals"]["tables"], 1, "só a parte legada tem conteúdo contado")
            res, vlog = self.verify(d)
            self.assertEqual(res["content_state"], m.ST_ENC_OPAQUE)
            self.assertIn("::warning title=BACKUP_PRESERVE_NAO_VERIFICADO::", vlog)
            res2, _ = self.verify(d, KAT_KEY)  # chave disponível depois: o conteúdo passa a ser provado
            self.assertEqual((res2["content_state"], res2["tables"]), (m.ST_ENC_OK, 3))

    def test_archived_with_key_then_verified_without_key(self):
        with tempfile.TemporaryDirectory() as d:
            self.archive(d, KAT_KEY)
            res, _ = self.verify(d)
            self.assertEqual((res["content_state"], res["tables"]), (m.ST_ENC_OPAQUE, 1))

    def fails(self, code, fn, *a):
        with self.assertRaises(SystemExit):
            fn(*a)
        self.assertIn(code, self.last.getvalue())

    def test_tampered_archived_envelope_fails_verify(self):
        flip = lambda e: json.dumps(dict(json.loads(e), ct=base64.b64encode(bytes([base64.b64decode(json.loads(e)["ct"])[0] ^ 1]) + base64.b64decode(json.loads(e)["ct"])[1:]).decode()), separators=(",", ":"))
        for keys in (KAT_KEY, None):
            with tempfile.TemporaryDirectory() as d:
                self.archive(d, keys)
                self.rewrite(d, flip)
                self.fails("part_hash_mismatch part=1", self.verify, d, keys)
        with tempfile.TemporaryDirectory() as d:  # hashes todos recalculados: só a tag GCM pega (com chave)
            self.archive(d, KAT_KEY)
            self.rewrite(d, flip, outer_only=False)
            self.fails("envelope_decrypt_failed part=1", self.verify, d, KAT_KEY)
        with tempfile.TemporaryDirectory() as d:  # sem chave: a validação estrutural pega envelope malformado
            self.archive(d)
            self.rewrite(d, lambda e: json.dumps(dict(json.loads(e), nonce="AAECAwQFBgc="), separators=(",", ":")), outer_only=False)
            self.fails("envelope_malformed part=1", self.verify, d)
        with tempfile.TemporaryDirectory() as d:  # rebaixamento: envelope trocado por texto claro
            self.archive(d)
            self.rewrite(d, lambda e: json.dumps({"orders": "[]"}), outer_only=False)
            self.fails("part_encryption_downgrade part=1", self.verify, d)

    def test_unknown_kid_or_wrong_key_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            self.fails("envelope_kid_unknown part=1", self.archive, d, OTHER_KEY)
        with tempfile.TemporaryDirectory() as d:
            self.archive(d)
            self.fails("envelope_kid_unknown part=1", self.verify, d, OTHER_KEY)
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(SystemExit):
            m.parse_keyring(KAT_KEY[:-8])
        self.assertIn("backup_keyring_malformed", out.getvalue())
        self.assertNotIn(KAT_KEY[:20], out.getvalue())


if __name__ == "__main__":
    unittest.main()
