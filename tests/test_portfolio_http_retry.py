"""Transport-only retry of portfolio-five-digital-target-exact-cert (scripts/portfolio_http_retry.py).

Offline: the opener is injected, sleep is recorded (no real waiting), no network.
"""
import http.client
import io
import json
import pathlib
import socket
import sys
import unittest
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import portfolio_http_retry as R  # noqa: E402


class FakeResponse:
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status = status
        self._body = body
        self.headers = headers or {"Content-Type": "application/json"}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Script:
    """Opener that plays a fixed script of outcomes (exception instance or FakeResponse)."""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = 0

    def __call__(self, req, timeout):
        self.calls += 1
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


def http_error(code):
    return urllib.error.HTTPError("https://x/api/health", code, "err", {}, io.BytesIO(b""))


def health_contract(body):
    """Same contract the cert script applies to /api/health after get() returns."""
    j = json.loads(body.decode())
    assert j.get("live") is True and j.get("ready") is True, j


class TransportRetryTest(unittest.TestCase):
    def setUp(self):
        R.attempt_log.clear()
        self.sleeps = []
        self.lines = []

    def call(self, opener, **kw):
        return R.get("https://zevanory.api.br/api/health", opener=opener, sleep=self.sleeps.append,
                     log=self.lines.append, **kw)

    def test_timeout_then_success_passes(self):
        op = Script(urllib.error.URLError(socket.timeout("timed out")),
                    FakeResponse(200, b'{"live":true,"ready":true}'))
        code, body, _, _ = self.call(op)
        self.assertEqual(code, 200)
        health_contract(body)
        self.assertEqual(op.calls, 2)
        self.assertEqual(self.sleeps, [2])
        self.assertEqual([a["outcome"] for a in R.attempt_log], ["timeout", "response"])
        self.assertEqual(len(self.lines), 2)
        self.assertIn("attempt=1/3 outcome=timeout", self.lines[0])
        self.assertIn("retry=yes backoff=2s", self.lines[0])
        self.assertIn("attempt=2/3 outcome=response status=200", self.lines[1])

    def test_divergent_content_fails_first_attempt_without_retry(self):
        op = Script(FakeResponse(200, b'{"live":true,"ready":false}'),
                    FakeResponse(200, b'{"live":true,"ready":true}'))  # must never be fetched
        code, body, _, _ = self.call(op)
        with self.assertRaises(AssertionError):
            health_contract(body)
        self.assertEqual(op.calls, 1)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(len(R.attempt_log), 1)
        self.assertEqual(len(op.steps), 1)

    def test_persistent_timeout_fails_after_n_attempts(self):
        op = Script(*[socket.timeout("timed out") for _ in range(3)])
        with self.assertRaises(R.TransportExhausted):
            self.call(op)
        self.assertEqual(op.calls, 3)
        self.assertEqual(self.sleeps, [2, 5])
        self.assertEqual([a["attempt"] for a in R.attempt_log], [1, 2, 3])
        self.assertTrue(all(a["outcome"] == "timeout" for a in R.attempt_log))
        self.assertIn("attempt=3/3 outcome=timeout", self.lines[-1])
        self.assertIn("retry=no", self.lines[-1])

    def test_transport_classes_are_retried(self):
        for exc, kind in [
            (ConnectionResetError(104, "reset"), "connection_reset"),
            (urllib.error.URLError(socket.gaierror(-3, "Temporary failure in name resolution")), "dns"),
            (http_error(503), "http_503"),
            (http_error(429), "http_429"),
            (http.client.RemoteDisconnected("closed"), "connection_dropped"),
            (TimeoutError("read timed out"), "timeout"),
        ]:
            with self.subTest(kind=kind):
                R.attempt_log.clear()
                self.sleeps.clear()
                op = Script(exc, FakeResponse(200, b'{"live":true,"ready":true}'))
                code, _, _, _ = self.call(op)
                self.assertEqual(code, 200)
                self.assertEqual(op.calls, 2)
                self.assertEqual(R.attempt_log[0]["outcome"], kind)

    def test_functional_http_errors_are_not_retried(self):
        for code in (400, 403, 404, 410):
            with self.subTest(code=code):
                R.attempt_log.clear()
                op = Script(http_error(code), FakeResponse(200))
                with self.assertRaises(urllib.error.HTTPError):
                    self.call(op)
                self.assertEqual(op.calls, 1)
                self.assertEqual(R.attempt_log[0]["outcome"], "non_transport_error")
        self.assertEqual(self.sleeps, [])

    def test_non_transport_exception_not_retried(self):
        op = Script(ValueError("bad"), FakeResponse(200))
        with self.assertRaises(ValueError):
            self.call(op)
        self.assertEqual(op.calls, 1)
        self.assertEqual(self.sleeps, [])

    def test_bounded_defaults(self):
        self.assertEqual(R.ATTEMPTS, 3)
        self.assertEqual(R.BACKOFF_SECONDS, (2, 5))

    def test_cert_script_uses_retry_and_has_no_other_fetch(self):
        src = (ROOT / "scripts" / "portfolio_target_exact_cert.py").read_text("utf-8")
        self.assertIn("get=portfolio_http_retry.get", src)
        self.assertNotIn("urlopen(", src)
        self.assertIn('"http_attempts":portfolio_http_retry.attempt_log', src)


if __name__ == "__main__":
    unittest.main()
