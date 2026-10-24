"""Contrato offline de scripts/ops/resend_receiving_key_certify.py (HTTP e wrangler falsos, sem rede, sem segredo).

Cenário do incidente: chave de OUTRA conta Resend => lista 200, item 404 => recusa e KV intacto.
CERT_MODULE_PATH permite ao runner de mutantes apontar para uma cópia mutada.
"""
import importlib.util
import io
import os
import pathlib
import unittest
import urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = pathlib.Path(os.environ.get("CERT_MODULE_PATH") or ROOT / "scripts/ops/resend_receiving_key_certify.py")
WORKFLOW = ROOT / ".github/workflows/sandbox-resend-receiving-secret.yml"

spec = importlib.util.spec_from_file_location("resend_receiving_key_certify", MODULE_PATH)
cert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cert)

KEY = "re_FAKE_candidate_key_0123456789"
REF = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"
SENDER = "cliente.secreto@example.org"
SUBJECT = "Assunto confidencial do cliente"


def detail(to):
    return {"object": "email", "id": REF, "to": to, "from": SENDER, "subject": SUBJECT,
            "cc": [], "received_for": []}


class FakeResend:
    def __init__(self, list_status=200, item_status=200, item_body=None):
        self.list_status, self.item_status = list_status, item_status
        self.item_body = item_body if item_body is not None else detail(["suporte@zevanory.api.br"])
        self.calls = []

    def __call__(self, path, key):
        self.calls.append((path, key))
        if path == "/emails/receiving?limit=1":
            return self.list_status, {"object": "list", "data": []}
        if path == "/emails/receiving/" + REF:
            return self.item_status, (self.item_body if self.item_status == 200 else None)
        return 404, None


class Writer:
    def __init__(self, ok=True):
        self.ok, self.keys = ok, []

    def __call__(self, key):
        self.keys.append(key)
        return self.ok


def go(fake, key=KEY, ref=REF, writer=None):
    writer = writer or Writer()
    lines = []
    code = cert.run(key, ref, get=fake, writer=writer, out=lines.append)
    return code, writer, "\n".join(lines)


class Certify(unittest.TestCase):
    def assertRefused(self, code, writer, log, reason):
        self.assertEqual(code, 2)
        self.assertEqual(writer.keys, [], "KV não pode ser tocado sem certificação")
        self.assertIn("RESEND_RECEIVING_KEY_CERT=NAO_COMPROVADO reason=" + reason, log)
        self.assertIn("WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED", log)
        self.assertNotIn("=SET", log)

    def test_other_account_key_list_200_item_404_refuses(self):
        fake = FakeResend(list_status=200, item_status=404)
        code, w, log = go(fake)
        self.assertRefused(code, w, log, "reference_not_found_other_account_or_expired")
        self.assertIn("RESEND_RECEIVING_LIST_STATUS=200", log)
        self.assertIn("RESEND_RECEIVING_REFERENCE_STATUS=404", log)
        self.assertEqual([p for p, _ in fake.calls], ["/emails/receiving?limit=1", "/emails/receiving/" + REF])

    def test_wrong_domain_refuses(self):
        code, w, log = go(FakeResend(item_body=detail(["suporte@outrodominio.com.br"])))
        self.assertRefused(code, w, log, "domain_mismatch")
        self.assertIn("RESEND_RECEIVING_DOMAIN_MATCH=false", log)

    def test_lookalike_domains_refuse(self):
        for to in (["a@evil.zevanory.api.br"], ["a@zevanory.api.br.evil.com"], ["zevanory.api.br"],
                   ["a@xzevanory.api.br"], ["Fulano <a@zevanory.api.br.evil.com>"], [], None, "a@zevanory.api.brx"):
            with self.subTest(to=to):
                code, w, log = go(FakeResend(item_body=detail(to)))
                self.assertRefused(code, w, log, "domain_mismatch")

    def test_domain_only_in_cc_or_received_for_refuses(self):
        body = detail(["outro@example.com"])
        body["cc"] = ["suporte@zevanory.api.br"]
        body["received_for"] = ["suporte@zevanory.api.br"]
        code, w, log = go(FakeResend(item_body=body))
        self.assertRefused(code, w, log, "domain_mismatch")

    def test_missing_reference_refuses_without_http(self):
        for ref in ("", "   ", None):
            with self.subTest(ref=ref):
                fake = FakeResend()
                code, w, log = go(fake, ref=ref)
                self.assertRefused(code, w, log, "reference_missing")
                self.assertEqual(fake.calls, [])

    def test_invalid_reference_refuses_without_http(self):
        for ref in ("../emails", "a/b", "id?limit=1", "x" * 129, "id with space"):
            with self.subTest(ref=ref):
                fake = FakeResend()
                code, w, log = go(fake, ref=ref)
                self.assertRefused(code, w, log, "reference_invalid")
                self.assertEqual(fake.calls, [])

    def test_missing_key_refuses_without_http(self):
        fake = FakeResend()
        code, w, log = go(fake, key="")
        self.assertRefused(code, w, log, "key_missing")
        self.assertEqual(fake.calls, [])

    def test_list_precondition_kept(self):
        for st in (401, 403, 404, 429, 500, 0):
            with self.subTest(status=st):
                fake = FakeResend(list_status=st)
                code, w, log = go(fake)
                self.assertRefused(code, w, log, "list_not_200")
                self.assertEqual(len(fake.calls), 1, "item não deve ser lido se a lista falhou")

    def test_item_non_200_refuses(self):
        for st in (401, 403, 422, 429, 500, 0, 201):
            with self.subTest(status=st):
                code, w, log = go(FakeResend(item_status=st))
                self.assertRefused(code, w, log, "item_not_200")

    def test_item_200_unparseable_refuses(self):
        fake = FakeResend()
        fake.item_body = "not-json-object"
        code, w, log = go(fake)
        self.assertRefused(code, w, log, "domain_mismatch")

    def test_good_key_writes(self):
        fake = FakeResend()
        code, w, log = go(fake)
        self.assertEqual(code, 0)
        self.assertEqual(w.keys, [KEY])
        self.assertIn("RESEND_RECEIVING_KEY_CERT=COMPROVADO reason=ok", log)
        self.assertIn("RESEND_RECEIVING_DOMAIN_MATCH=true", log)
        self.assertIn("WORKER_KV_RESEND_RECEIVING_KEY=SET", log)
        self.assertTrue(all(k == KEY for _, k in fake.calls), "as duas chamadas usam a chave candidata")

    def test_good_key_address_forms(self):
        for to in (["Suporte <SUPORTE@Zevanory.Api.Br>"], [{"email": "contato@zevanory.api.br"}],
                   "suporte@zevanory.api.br", ["x@example.com", "suporte@zevanory.api.br"]):
            with self.subTest(to=to):
                code, w, _ = go(FakeResend(item_body=detail(to)))
                self.assertEqual(code, 0)
                self.assertEqual(w.keys, [KEY])

    def test_write_failure_is_nonzero(self):
        code, w, log = go(FakeResend(), writer=Writer(ok=False))
        self.assertEqual(code, 3)
        self.assertIn("WORKER_KV_RESEND_RECEIVING_KEY=WRITE_FAILED", log)
        self.assertNotIn("=SET", log)

    def test_logs_are_categorical_only(self):
        for fake in (FakeResend(), FakeResend(item_status=404), FakeResend(item_body=detail(["a@b.com"]))):
            _, _, log = go(fake)
            for secret in (KEY, REF, SENDER, SUBJECT, "zevanory.api.br"):
                self.assertNotIn(secret, log)
            for line in log.splitlines():
                self.assertRegex(line, r"^[A-Z_]+=[A-Za-z0-9_]+( reason=[a-z0-9_]+)?$")


class HttpAndMain(unittest.TestCase):
    def test_http_get_maps_errors(self):
        err = urllib.error.HTTPError(cert.API, 404, "nf", {}, io.BytesIO(b"{}"))
        with mock.patch.object(cert.urllib.request, "urlopen", side_effect=err):
            self.assertEqual(cert.http_get("/emails/receiving/x", KEY), (404, None))
        with mock.patch.object(cert.urllib.request, "urlopen", side_effect=OSError("down")):
            self.assertEqual(cert.http_get("/emails/receiving/x", KEY), (0, None))

    def test_http_get_sends_bearer_and_parses(self):
        seen = {}

        class Resp(io.BytesIO):
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout):
            seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
            return Resp(b'{"to":["suporte@zevanory.api.br"]}')

        with mock.patch.object(cert.urllib.request, "urlopen", side_effect=fake_urlopen):
            st, body = cert.http_get("/emails/receiving/" + REF, KEY)
        self.assertEqual((st, body), (200, {"to": ["suporte@zevanory.api.br"]}))
        self.assertEqual(seen, {"url": "https://api.resend.com/emails/receiving/" + REF, "auth": "Bearer " + KEY})

    def test_main_reads_env_and_fails_closed_without_reference(self):
        with mock.patch.dict(os.environ, {"RESEND_RECEIVING_KEY": KEY, "REFERENCE_EMAIL_ID": ""}, clear=False), \
                mock.patch.object(cert, "http_get", side_effect=AssertionError("sem rede")), \
                mock.patch.object(cert, "wrangler_put", side_effect=AssertionError("sem KV")), \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cert.main(), 2)

    def test_wrangler_put_uses_private_tempfile_not_argv(self):
        seen = {}

        def fake_run(argv, **kw):
            p = argv[argv.index("--path") + 1]
            seen["argv"], seen["mode"] = argv, os.stat(p).st_mode & 0o777
            seen["content"] = pathlib.Path(p).read_text()
            seen["path"] = p
            return mock.Mock(returncode=0)

        with mock.patch.object(cert.subprocess, "run", side_effect=fake_run):
            self.assertTrue(cert.wrangler_put(KEY))
        self.assertNotIn(KEY, " ".join(seen["argv"]))
        self.assertEqual(seen["mode"], 0o600)
        self.assertEqual(seen["content"], KEY)
        self.assertFalse(os.path.exists(seen["path"]))
        self.assertIn("sandbox-config:resend-receiving-key", seen["argv"])
        self.assertIn("728a45738e4047f29bcb89934fd533c1", seen["argv"])


class WorkflowStatic(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_workflow_writes_only_through_certifier(self):
        self.assertIn("python3 -I scripts/ops/resend_receiving_key_certify.py", self.text)
        self.assertNotIn("kv key put", self.text)
        self.assertNotIn("curl", self.text)
        self.assertNotIn("continue-on-error", self.text)
        self.assertIn("set -euo pipefail", self.text)

    def test_reference_input_required_and_not_interpolated_in_shell(self):
        self.assertRegex(self.text, r"reference_email_id:\n\s+description: .+\n\s+required: true")
        self.assertIn("REFERENCE_EMAIL_ID: ${{ inputs.reference_email_id }}", self.text)
        run_blocks = self.text.split("run: |", 1)[1]
        self.assertNotIn("${{", run_blocks, "nada de expressão interpolada no shell")

    def test_trigger_and_guards_unchanged(self):
        self.assertIn("on:\n  workflow_dispatch:", self.text)
        for t in ("pull_request", "push:", "schedule"):
            self.assertNotIn(t, self.text)
        self.assertIn("github.ref == 'refs/heads/gh-pages' && github.run_attempt == 1", self.text)
        self.assertIn("environment: sandbox-financial-approved", self.text)
        self.assertIn("permissions:\n  contents: read", self.text)


if __name__ == "__main__":
    unittest.main()
