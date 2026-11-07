"""Teste de escala com dados SINTÉTICOS no formato real (51 tabelas, 18.142 linhas, partes
14.543/2.984/615). Exige um Postgres acessível por PG* (no CI: job verify-restore; local: opcional).
Sem PGHOST definido, o teste é pulado."""
import io
import json
import os
import random
import string
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts", "ops"))
import backup_preserve_archive as m  # noqa: E402

PASS = "z" * 48
PARTS_ROWS = {0: (18, 14543), 1: (17, 2984), 2: (16, 615)}


def synth_rows(n, seed):
    rnd = random.Random(seed)
    tricky = ["$zv$", "'aspas'", '"dupla"', "\\barra", "ção é ü 日本", "$$", "\n", None, "", "😀"]
    return [{"id": i, "texto": rnd.choice(tricky), "valor": rnd.random() * 1000, "ativo": rnd.random() < .5,
             "meta": {"k": "".join(rnd.choices(string.ascii_letters, k=rnd.randint(20, 400)))}} for i in range(n)]


def synth_parts():
    parts, t = {}, 0
    for p, (tables, rows) in PARTS_ROWS.items():
        sizes = [rows // tables] * tables
        sizes[0] += rows - sum(sizes)
        bundle = {}
        for s in sizes:
            bundle[f"tabela_{t:02d}"] = json.dumps(synth_rows(s, t), ensure_ascii=False)
            t += 1
        parts[p] = json.dumps(bundle).encode("utf-8")
    return parts


@unittest.skipUnless(os.environ.get("PGHOST"), "Postgres indisponível (defina PG*)")
class ScaleTest(unittest.TestCase):
    def test_51_tables_18142_rows_archive_and_restore(self):
        parts = synth_parts()
        store = {m.bundle_key("2026-10-14", p): v for p, v in parts.items()}
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS, "CLOUDFLARE_API_TOKEN": "t"}), \
             mock.patch.object(m, "kv_list", lambda tok, prefix: [{"name": k, "expiration": None} for k in store if k.startswith(prefix)]), \
             mock.patch.object(m, "kv_get", lambda tok, k: store[k]), redirect_stdout(io.StringIO()):
            t0 = time.time()
            man = m.main(["archive", "--out", d])  # contagens padrão: 51 / 18142
            res = m.mode_verify(m.argparse.Namespace(out=d), restore=True)
            elapsed = time.time() - t0
            size = os.path.getsize(os.path.join(d, "archive.enc"))
        self.assertEqual(man["totals"], {"parts": 3, "tables": 51, "rows": 18142})
        self.assertEqual(res["restore"], {"tables": 51, "rows": 18142, "ok": True})
        print(f"\nSCALE archive+verify+restore: {elapsed:.1f}s, archive {size/1e6:.2f} MB", file=sys.stderr)

    def test_encrypted_parts_archive_and_restore_with_key(self):
        """P20: as 3 partes como envelope AES-256-GCM do Worker (chave sintética deste teste); com P20_BACKUP_KEYS o
        verify decifra só em memória e restaura TUDO; o archive.enc guarda os envelopes, nunca texto claro novo."""
        import base64
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = os.urandom(32)
        kb64 = base64.b64encode(key).decode()
        day = "2026-11-02"
        store = {}
        for p, raw in synth_parts().items():
            nonce = os.urandom(12)
            ct = AESGCM(key).encrypt(nonce, raw, m.aad_bytes(day, p))
            store[m.bundle_key(day, p)] = json.dumps({"$enc": "zevanory-backup-enc/v1", "v": 1, "alg": "A256GCM", "kid": m.kid_of(key),
                "nonce": base64.b64encode(nonce).decode(), "aad": {"day": day, "part": p, "key": m.bundle_key(day, p)},
                "ct": base64.b64encode(ct).decode()}).encode()
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"BACKUP_ARCHIVE_PASSPHRASE": PASS, "CLOUDFLARE_API_TOKEN": "t", "P20_BACKUP_KEYS": kb64}), \
             mock.patch.object(m, "kv_list", lambda tok, prefix: [{"name": k, "expiration": None} for k in store if k.startswith(prefix)]), \
             mock.patch.object(m, "kv_get", lambda tok, k: store[k]), redirect_stdout(io.StringIO()) as out:
            man = m.main(["archive", "--day", day, "--out", d])
            res = m.mode_verify(m.argparse.Namespace(out=d), restore=True)
            inner = m.decrypt(open(os.path.join(d, "archive.enc"), "rb").read(), PASS).decode()
        self.assertEqual(man["content_state"], m.ST_ENC_OK)
        self.assertEqual(man["totals"], {"parts": 3, "tables": 51, "rows": 18142})
        self.assertEqual(res["restore"], {"tables": 51, "rows": 18142, "ok": True})
        self.assertNotIn("tabela_00", inner, "o arquivo guarda só os envelopes")
        self.assertNotIn(kb64, out.getvalue())


if __name__ == "__main__":
    unittest.main()
