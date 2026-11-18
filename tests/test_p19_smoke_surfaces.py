"""P19 fase 1: o smoke pós-deploy identifica a sonda e preserva a falha.

Servidor HTTP local (sem produção, sem rede externa):
  S1 leitura saudável: START antes, END com status, ms e diag; nome = host + caminho, nunca a query;
  S2 resposta controlada acima do limite: START antes da chamada, FAIL com error_class=timeout, ::error com o nome
     e a falha ORIGINAL relançada;
  S3 o passo REAL do workflow (texto extraído de central-production-deploy.yml) roda com o smoke apontado ao servidor
     local: reprova, e o log que o próprio passo imprime (o que fica no job mesmo com o rollback em seguida) traz a
     sonda e o tempo; o rollback continua condicionado a deploy feito + falha;
  S4 limites e ordem preservados: 25 s por leitura, mesma lista de URLs, mesmo passo do workflow.
"""
import contextlib
import http.server
import importlib.util
import io
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "verify-production-surfaces.py"
WF = ROOT / ".github" / "workflows" / "central-production-deploy.yml"
STEP = "Verify production API legal surfaces and parity after deploy"


def load_smoke():
    spec = importlib.util.spec_from_file_location("vps", SMOKE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RECEIVED = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        RECEIVED.append(self.headers.get("x-zevanory-diag"))
        if self.path.startswith("/slow"):
            time.sleep(3)
        if self.path.startswith("/bodyhang"):
            # cabeçalhos 200 enviados, corpo suspenso (o caso que a contra-auditoria reproduziu no P18)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("x-zevanory-diag", "abcdef012345")
            self.send_header("content-length", "100")
            self.end_headers()
            try:
                self.wfile.write(b'{"partial":')
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
            time.sleep(3)
            return
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("x-zevanory-diag", "0123456789ab")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


@contextlib.contextmanager
def server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


def step_run_text():
    d = yaml.safe_load(WF.read_text(encoding="utf-8"))
    steps = d["jobs"]["deploy"]["steps"]
    hits = [s for s in steps if s.get("name") == STEP]
    assert len(hits) == 1
    return hits[0]["run"], steps


class SmokeTest(unittest.TestCase):
    def test_s1_leitura_saudavel_registra_inicio_e_fim(self):
        m = load_smoke()
        with server() as port:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code, headers, body = m.get(f"http://127.0.0.1:{port}/api/status?token=SEGREDO")
        out = buf.getvalue().splitlines()
        self.assertEqual(code, 200)
        self.assertRegex(out[0], rf"^SURFACE_PROBE_START seq=\d+ name=127\.0\.0\.1:{port}/api/status rid=[0-9a-f]{{12}} at=\d{{4}}-")
        rid = re.search(r"rid=([0-9a-f]{12})", out[0]).group(1)
        self.assertEqual(RECEIVED[-1], rid, "o rid registrado ANTES da chamada é o que vai no cabeçalho ao Worker")
        self.assertRegex(out[1], rf"^SURFACE_PROBE_HEADERS seq=\d+ name=127\.0\.0\.1:{port}/api/status status=200 ms=\d+ diag=0123456789ab$")
        self.assertRegex(out[2], rf"^SURFACE_PROBE_END seq=\d+ name=127\.0\.0\.1:{port}/api/status status=200 ms=\d+ diag=0123456789ab$")
        self.assertNotIn("SEGREDO", buf.getvalue(), "query string nunca é registrada")

    def test_s2_timeout_identifica_a_sonda_e_relanca_a_falha_original(self):
        m = load_smoke()
        m.TIMEOUT_S = 1  # só no teste; o valor de produção (25 s) é conferido em S4
        with server() as port:
            buf = io.StringIO()
            t0 = time.monotonic()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(Exception) as ctx:
                    m.get(f"http://127.0.0.1:{port}/slow")
            elapsed = time.monotonic() - t0
        out = buf.getvalue().splitlines()
        self.assertLess(elapsed, 2.5)
        self.assertEqual(m.error_class(ctx.exception), "timeout", repr(ctx.exception))
        self.assertRegex(out[0], rf"^SURFACE_PROBE_START seq=1 name=127\.0\.0\.1:{port}/slow rid=[0-9a-f]{{12}} ")
        self.assertEqual(RECEIVED[-1], re.search(r"rid=([0-9a-f]{12})", out[0]).group(1), "sem resposta, o rid já foi enviado e registrado")
        self.assertRegex(out[1], rf"^SURFACE_PROBE_FAIL seq=1 name=127\.0\.0\.1:{port}/slow ms=\d+ phase=headers error_class=timeout diag=-$")
        self.assertRegex(out[2], rf"^::error title=SURFACE_PROBE_TIMEOUT::127\.0\.0\.1:{port}/slow falhou em \d+ ms \(timeout, fase headers; limite 1 s por leitura\)$")
        self.assertEqual(len(out), 3)

    def test_s5_corpo_suspenso_depois_dos_cabecalhos_registra_fase_e_rid(self):
        m = load_smoke()
        m.TIMEOUT_S = 1
        with server() as port:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                with self.assertRaises(Exception) as ctx:
                    m.get(f"http://127.0.0.1:{port}/bodyhang")
        out = buf.getvalue().splitlines()
        self.assertEqual(m.error_class(ctx.exception), "timeout", repr(ctx.exception))
        self.assertRegex(out[1], rf"^SURFACE_PROBE_HEADERS seq=1 name=127\.0\.0\.1:{port}/bodyhang status=200 ms=\d+ diag=abcdef012345$")
        self.assertRegex(out[2], rf"^SURFACE_PROBE_FAIL seq=1 name=127\.0\.0\.1:{port}/bodyhang ms=\d+ phase=body error_class=timeout diag=abcdef012345$")
        self.assertIn("fase body", out[3])

    def test_s3_passo_real_do_workflow_reprova_e_o_log_identifica_a_sonda(self):
        run, steps = step_run_text()
        with server() as port, tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            # python3 falso: roda o smoke REAL, mas com urlopen redirecionado ao servidor local (a 1ª URL, /api/status,
            # vai para /slow) e limite de 1 s. O nome registrado continua sendo o da URL de produção.
            boot = tmp / "boot.py"
            boot.write_text(
                "import importlib.util,sys,urllib.request\n"
                f"spec=importlib.util.spec_from_file_location('vps',{str(SMOKE)!r})\n"
                "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
                "real=urllib.request.urlopen\n"
                "def fake(req,timeout=None):\n"
                "    u=req.full_url\n"
                f"    local='http://127.0.0.1:{port}'+('/slow' if u.endswith('zevanory.api.br/api/status') and u.startswith('https://zevanory') else '/ok')\n"
                "    return real(urllib.request.Request(local,headers=dict(req.header_items())),timeout=timeout)\n"
                "m.urllib.request.urlopen=fake\n"
                "m.TIMEOUT_S=1\n"
                "m.run()\n",
                encoding="utf-8",
            )
            bindir = tmp / "bin"
            bindir.mkdir()
            stub = bindir / "python3"
            stub.write_text(
                "#!/usr/bin/env bash\n"
                'if [ "$1" = "scripts/verify-production-surfaces.py" ]; then exec "$REAL_PY" "$BOOT"; fi\n'
                'exec "$REAL_PY" "$@"\n',
                encoding="utf-8",
            )
            stub.chmod(0o755)
            env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", REAL_PY=sys.executable, BOOT=str(boot))
            p = subprocess.run(["bash", "-c", run], cwd=str(ROOT), env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        out = p.stdout
        # O que o passo imprime vai para o log do job (imutável), antes de o passo de rollback rodar.
        self.assertIn("SURFACE_PROBE_START seq=1 name=zevanory.api.br/api/status", out)
        self.assertRegex(out, r"SURFACE_PROBE_FAIL seq=1 name=zevanory\.api\.br/api/status ms=\d+ phase=headers error_class=timeout")
        self.assertRegex(out, r"::error title=SURFACE_PROBE_TIMEOUT::zevanory\.api\.br/api/status falhou em \d+ ms")
        self.assertIn("::error title=VERIFY_SURFACES::", out, "a anotação do próprio passo continua")
        self.assertLess(out.index("SURFACE_PROBE_START seq=1"), out.index("SURFACE_PROBE_FAIL seq=1"))
        names = [s.get("name", "") for s in steps]
        i_smoke = names.index(STEP)
        rb = [s for s in steps if s.get("name", "").startswith("Automatic rollback")]
        self.assertEqual(len(rb), 1)
        self.assertGreater(names.index(rb[0]["name"]), i_smoke, "rollback roda depois do smoke")
        self.assertIn("failure()", rb[0]["if"])
        self.assertIn("steps.deployworker.outcome == 'success'", rb[0]["if"])

    def test_s4_limites_lista_e_passo_preservados(self):
        m = load_smoke()
        self.assertEqual(m.TIMEOUT_S, 25)
        src = SMOKE.read_text(encoding="utf-8")
        urls = re.findall(r'"(https://[^"]+)"', src.split("def run():", 1)[1].split("]", 1)[0])
        self.assertEqual(urls, [
            "https://zevanory.api.br/api/status",
            "https://edge.zevanory.api.br/api/status",
            "https://zevanory.api.br/api/sales/status",
            "https://zevanory.api.br/api/health",
            "https://zevanory.api.br/api/release",
            "https://zevanory.api.br/api/control-plane",
        ])
        run, _ = step_run_text()
        self.assertIn("python3 scripts/verify-production-surfaces.py > /tmp/surfaces.log 2>&1 ||", run)
        self.assertIn("cat /tmp/surfaces.log; exit 1;", run, "em falha o passo imprime o log inteiro no job")


if __name__ == "__main__":
    unittest.main()
