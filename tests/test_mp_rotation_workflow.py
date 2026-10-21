"""Guarda estática do workflow de troca do token Mercado Pago (achados MP-01..MP-03 do Sol, 21/10/2026).

Nenhum teste aqui lê, grava ou dispara credenciais: só analisa o YAML e executa a expressão jq do
ponto de retorno contra respostas de exemplo no formato documentado pela Cloudflare
(GET /accounts/{id}/workers/scripts/{name}/deployments -> result.deployments[0].versions[]).
"""
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = Path(os.environ.get("MP_ROTATION_WORKFLOW", ROOT / ".github/workflows/mercadopago-production-token-rotate.yml"))


def load():
    text = WORKFLOW.read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    jobs = list(doc["jobs"].values())
    assert len(jobs) == 1, "o workflow deve ter um único job"
    return text, jobs[0]


def step_index(steps, needle):
    hits = [i for i, s in enumerate(steps) if needle in str(s.get("run", ""))]
    assert hits, f"passo com {needle!r} não encontrado"
    return hits[0]


class MpRotationWorkflow(unittest.TestCase):
    def setUp(self):
        self.text, self.job = load()
        self.steps = self.job["steps"]

    def test_mp01_single_cloudflare_token_source(self):
        self.assertNotIn("CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", self.text)
        self.assertEqual(self.job["env"]["CLOUDFLARE_API_TOKEN"], "${{ secrets.CLOUDFLARE_API_TOKEN }}")
        self.assertEqual(self.job.get("environment"), "producao-critica")

    def test_mp02_operational_reads_happen_before_the_write(self):
        put = step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")
        for path in ("/v1/payments/search?limit=1", "/v1/payment_methods"):
            self.assertLess(step_index(self.steps, path), put, f"{path} tem de rodar antes do secret put")
        check = self.steps[step_index(self.steps, "/v1/payment_methods")]["run"]
        self.assertRegex(check, r'test "\$code" = "200" \|\| \{ echo "::error title=MP_OPERATIONAL_CHECK::[^}]*exit 1; \}')
        # Só leitura: nenhum método de escrita contra a API do Mercado Pago.
        self.assertNotRegex(self.text, r"-X\s*(POST|PUT|DELETE|PATCH)[^\n]*mercadopago")

    def test_mp03_rollback_point_captured_before_write(self):
        put = step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")
        rec = step_index(self.steps, 'PREV_VERSION_ID=$prev')
        self.assertLess(rec, put)
        self.assertIn("/workers/scripts/zevanory/deployments", self.steps[rec]["run"])
        self.assertIn("^[0-9a-f-]{36}$", self.steps[rec]["run"], "versão anterior tem de ser validada (fail-closed)")

    def test_mp03_rollback_runs_only_after_a_post_write_failure(self):
        last = self.steps[-1]
        cond = last.get("if", "")
        for token in ("failure()", "env.WRITE_ATTEMPTED_AT != ''", "env.PREV_VERSION_ID != ''"):
            self.assertIn(token, cond)
        self.assertRegex(last["run"], r'wrangler@4\.143\.0 rollback "\$PREV_VERSION_ID" --name zevanory')
        self.assertRegex(last["run"], r'echo "::warning title=MP_ROTATION_ROLLED_BACK::[^"]*OBSERVED_IN_B01_PROBE[^"]*CONFIRM via the next preflight[^"]*10215',
                         "o limite (restauração do valor do segredo) tem de aparecer no resultado do run")
        put = self.steps[step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")]["run"]
        self.assertLess(put.index("secret put"), put.index("echo \"ROTATED_AT="), "ROTATED_AT só depois da gravação")
        # Falha ambígua (Sol 21/10): a tentativa é marcada ANTES da gravação.
        self.assertLess(put.index("WRITE_ATTEMPTED_AT="), put.index("secret put"))

    def test_every_cloudflare_step_strips_whitespace_from_the_token(self):
        for s in self.steps:
            run = str(s.get("run", ""))
            if "CLOUDFLARE_API_TOKEN" in run or "wrangler" in run:
                self.assertIn("tr -d '[:space:]'", run, s.get("name"))

    def test_r1_wait_covers_a_full_hourly_preflight_cycle_at_any_write_minute(self):
        # Ordem 046 R1: o preflight roda só no minuto :00 (cron horário). Para QUALQUER minuto de gravação,
        # o próximo preflight, com até 15 min de atraso do cron/runner e mais uma volta de sondagem (60 s), cai
        # dentro da espera; e o timeout do job cobre a espera + validação + retorno automático.
        m = re.search(r"deadline=\$\(\(SECONDS \+ (\d+)\)\)", self.text)
        self.assertIsNotNone(m)
        wait = int(m.group(1))
        self.assertEqual(wait, 4800)
        cron_delay, poll = 15 * 60, 60
        for write_second in range(0, 3600, 30):
            next_tick = 3600 - write_second + cron_delay
            self.assertLessEqual(next_tick + poll, wait, f"gravação no segundo {write_second} da hora")
        timeout = int(self.job["timeout-minutes"])
        self.assertGreaterEqual(timeout * 60, wait + 15 * 60, "timeout do job < espera + 15 min de validação/retorno")
        self.assertLessEqual(timeout, 120, "limite de custo")

    @unittest.skipUnless(shutil.which("node"), "node ausente")
    def test_r1_freshness_crosses_the_hour_boundary(self):
        run = self.steps[step_index(self.steps, "deadline=$((SECONDS")]["run"]
        snippet = re.search(r"<<'NODE'\n(.*?)\n\s*NODE", run, re.S).group(1)
        snippet = "\n".join(line.strip() for line in snippet.splitlines())
        def fresh(after, generated):
            import tempfile
            with tempfile.TemporaryDirectory() as d:
                pf = Path(d) / "p.json"
                pf.write_text(json.dumps({"generatedAt": generated}))
                code = snippet.replace("/tmp/zpc-sales-preflight.json", str(pf))
                return subprocess.run(["node", "--input-type=module", "-e", code], env={**os.environ, "PREFLIGHT_AFTER": after}).returncode == 0
        self.assertTrue(fresh("2026-10-21T19:59:30Z", "2026-10-21T20:00:49.750Z"), "virada de hora")
        self.assertTrue(fresh("2026-10-21T23:58:00Z", "2026-10-22T00:00:41.000Z"), "virada de dia")
        self.assertFalse(fresh("2026-10-21T19:59:30Z", "2026-10-21T19:00:49.750Z"), "preflight anterior à gravação")
        self.assertFalse(fresh("2026-10-21T19:59:30Z", "2026-10-21T19:59:30Z"), "igual não é mais novo")
        self.assertFalse(fresh("2026-10-21T19:59:30Z", "not-a-date"))
        self.assertFalse(fresh("", "2026-10-21T20:00:49.750Z"), "referência ausente => não fresco")

    def test_secret_value_is_never_printed(self):
        self.assertNotRegex(self.text, r"echo[^\n]*\$\{?MERCADOPAGO_PROD_ACCESS_TOKEN")
        self.assertNotRegex(self.text, r"set -[a-z]*x")
        self.assertIn('printf \'%s\' "$MERCADOPAGO_PROD_ACCESS_TOKEN" |', self.text)

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_rollback_point_jq_against_documented_shapes(self):
        run = self.steps[step_index(self.steps, 'PREV_VERSION_ID=$prev')]["run"]
        expr = re.search(r"jq -r '([^']+)' /tmp/deployments.json", run).group(1)
        a, b = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
        cases = {
            "single": ({"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 100}]}]}}, a),
            "latest_first": ({"result": {"deployments": [{"versions": [{"version_id": b, "percentage": 100}]},
                                                         {"versions": [{"version_id": a, "percentage": 100}]}]}}, b),
            # Implantação gradual: não há versão a 100% => vazio => o passo falha (fail-closed).
            "gradual": ({"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 60},
                                                                  {"version_id": b, "percentage": 40}]}]}}, ""),
            "empty": ({"result": {"deployments": []}}, ""),
        }
        for name, (payload, want) in cases.items():
            got = subprocess.run(["jq", "-r", expr], input=json.dumps(payload), capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(got, want, name)


    # ---- Execução real dos passos com curl/npx substituídos (sem rede, sem credencial) ----
    def _run_step(self, needle, fixtures, env_extra, npx_rc=0):
        import tempfile
        run = self.steps[step_index(self.steps, needle)]["run"]
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "fx.json").write_text(json.dumps(fixtures))
            (d / "curl").write_text("""#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]; out = a[a.index('-o') + 1]; url = a[-1]
fx = json.load(open(%r))
for key, (code, body) in fx.items():
    if key in url:
        open(out, 'w').write(json.dumps(body)); print(code, end=''); sys.exit(0)
open(out, 'w').write('{}'); print('404', end='')
""" % str(d / "fx.json"))
            (d / "npx").write_text("#!/bin/sh\necho \"npx $*\" >> %s/npx.log\nexit %d\n" % (d, npx_rc))
            for f in ("curl", "npx"):
                (d / f).chmod(0o755)
            env = {"PATH": f"{d}:{os.environ['PATH']}", "GITHUB_ENV": str(d / "ghenv"),
                   "MERCADOPAGO_PROD_ACCESS_TOKEN": "stub-not-a-secret", "CLOUDFLARE_API_TOKEN": "stub\n",
                   "CLOUDFLARE_ACCOUNT_ID": "acc", **env_extra}
            p = subprocess.run(["bash", "-c", run], env=env, capture_output=True, text=True)
            npx_log = (d / "npx.log").read_text() if (d / "npx.log").exists() else ""
            return p.returncode, p.stdout + p.stderr, npx_log

    USERS_OK = ["200", {"site_id": "MLB", "tags": []}]
    SEARCH_OK = ["200", {"results": [], "paging": {"total": 0}}]
    METHODS_OK = ["200", [{"id": "pix"}, {"id": "visa"}]]

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_mp02_each_response_is_validated_on_its_own(self):
        needle = "/v1/payment_methods"
        run = self.steps[step_index(self.steps, needle)]["run"]
        outputs = re.findall(r'mp_read\s+"[^"]+"\s+(\S+)', run)
        self.assertEqual(len(outputs), 2)
        self.assertEqual(len(set(outputs)), 2, "cada leitura operacional precisa de arquivo próprio")
        self.assertNotIn("/tmp/mercadopago-user.json", outputs)
        ok = {"/users/me": self.USERS_OK, "/v1/payments/search": self.SEARCH_OK, "/v1/payment_methods": self.METHODS_OK}
        rc, out, _ = self._run_step(needle, ok, {})
        self.assertEqual(rc, 0, out)
        self.assertIn("MERCADOPAGO_OPERATIONAL_READ=PASS", out)
        bad = {
            "search_200_bad_body": {**ok, "/v1/payments/search": ["200", {"error": "x"}]},
            "search_403": {**ok, "/v1/payments/search": ["403", {"results": []}]},
            "methods_200_empty": {**ok, "/v1/payment_methods": ["200", []]},
            "methods_200_object": {**ok, "/v1/payment_methods": ["200", {"results": []}]},
            "methods_401": {**ok, "/v1/payment_methods": ["401", [{"id": "pix"}]]},
        }
        for name, fx in bad.items():
            rc, out, _ = self._run_step(needle, fx, {})
            self.assertNotEqual(rc, 0, name)
            self.assertIn("MP_OPERATIONAL_CHECK", out, name)
            self.assertNotIn("MERCADOPAGO_OPERATIONAL_READ=PASS", out, name)

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_mp03_rollback_certifies_by_readback(self):
        prev, other = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
        dep = lambda v: ["200", {"result": {"deployments": [{"versions": [{"version_id": v, "percentage": 100}]}]}}]
        needle = 'rollback "$PREV_VERSION_ID"'
        rc, out, npx = self._run_step(needle, {"/deployments": dep(prev)}, {"PREV_VERSION_ID": prev, "ROTATED_AT": "x"})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"rollback {prev} --name zevanory", npx)
        self.assertIn("ROLLBACK_READBACK=PASS", out)
        self.assertNotIn("MP_WRITE_UNCERTAIN", out)
        # Gravação ambígua: ROTATED_AT ausente => estado explícito de incidente, e o retorno ainda roda.
        rc, out, npx = self._run_step(needle, {"/deployments": dep(prev)}, {"PREV_VERSION_ID": prev})
        self.assertEqual(rc, 0, out)
        self.assertIn("MP_WRITE_UNCERTAIN", out)
        self.assertIn("rollback", npx)
        # Leitura mostra outra versão ativa => falha, incidente aberto.
        rc, out, _ = self._run_step(needle, {"/deployments": dep(other)}, {"PREV_VERSION_ID": prev, "ROTATED_AT": "x"})
        self.assertNotEqual(rc, 0)
        self.assertIn("MP_ROLLBACK_READBACK_FAIL", out)
        # Leitura com HTTP != 200 não certifica, mesmo que o corpo pareça certo.
        bad_http = ["500", dep(prev)[1]]
        rc, out, _ = self._run_step(needle, {"/deployments": bad_http}, {"PREV_VERSION_ID": prev, "ROTATED_AT": "x"})
        self.assertNotEqual(rc, 0)
        self.assertIn("MP_ROLLBACK_READBACK_FAIL", out)
        # Comando de rollback falhou e a leitura confirma que nada voltou => falha.
        rc, out, _ = self._run_step(needle, {"/deployments": dep(other)}, {"PREV_VERSION_ID": prev}, npx_rc=1)
        self.assertNotEqual(rc, 0)
        self.assertIn("MP_ROLLBACK_READBACK_FAIL", out)


    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_10215_precondition_latest_version_must_be_the_deployed_one(self):
        # Achado do ensaio B01 (run 39643799156): depois de um rollback, secret put => Cloudflare 10215.
        a, b = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
        dep = ["200", {"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 100}]}]}}]
        needle = "MP_LATEST_VERSION_NOT_DEPLOYED_10215"
        ok = {"/deployments": dep, "/versions": ["200", {"result": {"items": [{"id": a, "number": 2}, {"id": b, "number": 1}]}}]}
        rc, out, _ = self._run_step(needle, ok, {})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"ROLLBACK_POINT={a}", out)
        bad = {
            "latest_not_deployed": {**ok, "/versions": ["200", {"result": {"items": [{"id": b, "number": 2}, {"id": a, "number": 1}]}}]},
            # HTTP != 200 falha mesmo com corpo que, sozinho, passaria.
            "versions_http_500": {**ok, "/versions": ["500", {"result": {"items": [{"id": a, "number": 1}]}}]},
            "versions_unparseable": {**ok, "/versions": ["200", {"result": {"items": [{"id": "not-a-uuid", "number": 1}]}}]},
        }
        for name, fx in bad.items():
            rc, out, _ = self._run_step(needle, fx, {})
            self.assertNotEqual(rc, 0, name)
            self.assertNotIn("ROLLBACK_POINT=", out, name)
        rc, out, _ = self._run_step(needle, bad["latest_not_deployed"], {})
        self.assertIn("MP_LATEST_VERSION_NOT_DEPLOYED_10215", out)
        rc, out, _ = self._run_step(needle, bad["versions_http_500"], {})
        self.assertIn("MP_VERSIONS_READ::http=500", out)
        rc, out, _ = self._run_step(needle, bad["versions_unparseable"], {})
        self.assertIn("MP_LATEST_VERSION::not resolvable", out)

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_10215_latest_is_chosen_by_number_not_by_list_order(self):
        # Contestação Sol 038-F1: lista fora de ordem não pode gerar falso PASS.
        a, b = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
        dep = ["200", {"result": {"deployments": [{"versions": [{"version_id": a, "percentage": 100}]}]}}]
        needle = "MP_LATEST_VERSION_NOT_DEPLOYED_10215"
        # a ativa (A, number 7) aparece primeiro, mas B (number 8) é a mais recente => tem de bloquear.
        out_of_order = {"/deployments": dep, "/versions": ["200", {"result": {"items": [{"id": a, "number": 7}, {"id": b, "number": 8}]}}]}
        rc, out, _ = self._run_step(needle, out_of_order, {})
        self.assertNotEqual(rc, 0)
        self.assertIn("MP_LATEST_VERSION_NOT_DEPLOYED_10215", out)
        # sem number, ou com empate => falha fechada (not resolvable)
        for items in ([{"id": a}], [{"id": a, "number": 8}, {"id": b, "number": 8}], [],
                      [{"id": a, "number": 7.9}, {"id": b, "number": 7.1}],   # contestação Codex A1
                      [{"id": a, "number": -1}], [{"id": a, "number": "9"}]):
            rc, out, _ = self._run_step(needle, {"/deployments": dep, "/versions": ["200", {"result": {"items": items}}]}, {})
            self.assertNotEqual(rc, 0, items)
            self.assertIn("MP_LATEST_VERSION::not resolvable", out, items)
        # ordem normal com number: passa
        ok = {"/deployments": dep, "/versions": ["200", {"result": {"items": [{"id": a, "number": 9}, {"id": b, "number": 8}]}}]}
        rc, out, _ = self._run_step(needle, ok, {})
        self.assertEqual(rc, 0, out)

    def test_single_dispatch_on_gh_pages_and_no_concurrency(self):
        doc = yaml.safe_load(self.text)
        self.assertEqual(doc["concurrency"], {"group": "mercadopago-production-token-rotate", "cancel-in-progress": False})
        self.assertEqual(self.job["if"], "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/gh-pages' && github.run_attempt == 1")

    def test_10215_precondition_runs_before_the_write(self):
        put = step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")
        self.assertLess(step_index(self.steps, "MP_LATEST_VERSION_NOT_DEPLOYED_10215"), put)


    # ---- Modo check-only (gate G1/G2 do Sol, Ordem 043) ----
    def test_check_only_is_the_default_and_never_writes(self):
        doc = yaml.safe_load(self.text)
        on = doc.get("on", doc.get(True))
        inp = on["workflow_dispatch"]["inputs"]["mode"]
        self.assertEqual(inp["default"], "check-only")
        self.assertEqual(inp["options"], ["check-only", "rotate", "recover"])
        put = self.steps[step_index(self.steps, "secret put MERCADOPAGO_ACCESS_TOKEN")]
        self.assertEqual(put.get("if"), "inputs.mode == 'rotate'")
        wait = self.steps[step_index(self.steps, "deadline=$((SECONDS")]
        self.assertEqual(wait.get("if"), "inputs.mode == 'rotate' || inputs.mode == 'recover'")
        base = self.steps[step_index(self.steps, "CHECK_ONLY=PASS")]
        self.assertEqual(base.get("if"), "inputs.mode == 'check-only'")
        self.assertNotIn("wrangler", base["run"])
        self.assertNotRegex(base["run"], r"-X\s*(PUT|POST|DELETE|PATCH)")
        # o retorno automático depende de WRITE_ATTEMPTED_AT, que só o passo de troca grava
        self.assertIn("env.WRITE_ATTEMPTED_AT != ''", self.steps[-1]["if"])

    @unittest.skipUnless(shutil.which("jq") and shutil.which("node"), "jq/node ausentes")
    def test_check_only_baseline_requires_fresh_token_ok_and_sales_closed(self):
        import datetime as _dt
        now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        kv_ok = ["200", {"generatedAt": now, "checks": [{"id": "mercadopago_production_token", "ok": True}]}]
        health = {"live": True, "ready": True, "checks": {"database_reachable": True, "schema_ready": True, "commercial_safety_locked": True}}
        status = {"sales_authorization": {"state": "closed"}, "runtime": {"sales": "globally-blocked"}}
        ok = {"zpc-sales-preflight": kv_ok, "/api/health": ["200", health], "/api/sales/status": ["200", {"open": False}],
              "/api/status": ["200", status]}
        def ago(minutes):
            return (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
        def kv(gen):
            return ["200", {"generatedAt": gen, "checks": [{"id": "mercadopago_production_token", "ok": True}]}]
        env = {"KV_NAMESPACE_ID": "kv"}
        rc, out, npx = self._run_step("CHECK_ONLY=PASS", ok, env)
        self.assertEqual(rc, 0, out)
        self.assertIn("CHECK_ONLY=PASS", out)
        self.assertIn('"mercadopago_production_token_ok":true', out)
        self.assertIn("MP_SECRET_SCOPE=UNVERIFIED", out)
        rc2, out2, _ = self._run_step("CHECK_ONLY=PASS", {**ok, "zpc-sales-preflight": kv(ago(100))}, env)
        self.assertEqual(rc2, 0, "100 min ainda está dentro do limite de 120")
        rc3, out3, _ = self._run_step("CHECK_ONLY=PASS", {**ok, "zpc-sales-preflight": kv(ago(120))}, env)
        self.assertEqual(rc3, 0, "120 min exatos ainda estão dentro do limite")
        self.assertEqual(npx, "", "check-only nunca chama wrangler")
        bad = {
            "token_not_ok": {**ok, "zpc-sales-preflight": ["200", {"generatedAt": now, "checks": [{"id": "mercadopago_production_token", "ok": False}]}]},
            "sales_open": {**ok, "/api/sales/status": ["200", {"open": True}]},
            "kv_403": {**ok, "zpc-sales-preflight": ["403", {}]},
            "health_500": {**ok, "/api/health": ["500", {}]},
            "health_500_with_ready_body": {**ok, "/api/health": ["500", health]},
            # 044-F1: preflight velho, no futuro ou com data inválida
            "preflight_stale_121m": {**ok, "zpc-sales-preflight": kv(ago(121))},
            "preflight_stale_3h": {**ok, "zpc-sales-preflight": kv(ago(180))},
            "preflight_future": {**ok, "zpc-sales-preflight": kv(ago(-60))},
            "preflight_bad_date": {**ok, "zpc-sales-preflight": kv("not-a-date")},
            # 044-F3: HTTP 200 com conteúdo ruim
            "health_200_db_down": {**ok, "/api/health": ["200", {**health, "checks": {**health["checks"], "database_reachable": False}}]},
            "health_200_not_ready": {**ok, "/api/health": ["200", {**health, "ready": False}]},
            "status_open": {**ok, "/api/status": ["200", {**status, "sales_authorization": {"state": "open"}}]},
            "status_runtime_not_blocked": {**ok, "/api/status": ["200", {**status, "runtime": {"sales": "open"}}]},
            "status_500": {**ok, "/api/status": ["500", status]},
        }
        for name, fx in bad.items():
            rc, out, _ = self._run_step("CHECK_ONLY=PASS", fx, env)
            self.assertNotEqual(rc, 0, name)
            self.assertNotIn("CHECK_ONLY=PASS (nada", out, name)

    # ---- Ordem 046 R2: alvo da recuperação e modo recover ----
    A = "11111111-1111-1111-1111-111111111111"
    N = "33333333-3333-3333-3333-333333333333"

    @classmethod
    def dep(cls, v):
        return ["200", {"result": {"deployments": [{"versions": [{"version_id": v, "percentage": 100}]}]}}]

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_r2_rotate_records_the_version_that_holds_the_new_token(self):
        needle = "secret put MERCADOPAGO_ACCESS_TOKEN"
        rc, out, npx = self._run_step(needle, {"/deployments": self.dep(self.N)}, {"PREV_VERSION_ID": self.A})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"NEW_SECRET_VERSION={self.N}", out)
        self.assertIn("secret put MERCADOPAGO_ACCESS_TOKEN --name zevanory", npx)
        # Leitura que não mostra versão nova não derruba a rotação (não é motivo de retorno), só avisa.
        for name, fx in {"same_as_prev": {"/deployments": self.dep(self.A)}, "http_500": {"/deployments": ["500", {}]}}.items():
            rc, out, _ = self._run_step(needle, fx, {"PREV_VERSION_ID": self.A})
            self.assertEqual(rc, 0, name)
            self.assertIn("NEW_SECRET_VERSION_UNREAD", out, name)
            self.assertNotIn("NEW_SECRET_VERSION=", out.replace("NEW_SECRET_VERSION_UNREAD", ""), name)

    @unittest.skipUnless(shutil.which("jq"), "jq ausente")
    def test_r2_automatic_return_prints_the_recovery_target(self):
        needle = 'rollback "$PREV_VERSION_ID"'
        versions = lambda items: ["200", {"result": {"items": items}}]
        base = {"/deployments": self.dep(self.A)}
        ok = {**base, "/versions": versions([{"id": self.N, "number": 682}, {"id": self.A, "number": 681}])}
        rc, out, _ = self._run_step(needle, ok, {"PREV_VERSION_ID": self.A, "ROTATED_AT": "x", "NEW_SECRET_VERSION": self.N})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"RECOVERY_TARGET_VERSION={self.N}", out)
        self.assertIn(f"mode=recover target_version={self.N}", out)
        # Gravação ambígua (sem NEW_SECRET_VERSION): o alvo vem da mais recente por number.
        rc, out, _ = self._run_step(needle, ok, {"PREV_VERSION_ID": self.A})
        self.assertIn(f"RECOVERY_TARGET_VERSION={self.N}", out)
        # Divergência entre a mais recente e a versão registrada => erro explícito, nenhum alvo sugerido.
        other = "44444444-4444-4444-4444-444444444444"
        rc, out, _ = self._run_step(needle, ok, {"PREV_VERSION_ID": self.A, "ROTATED_AT": "x", "NEW_SECRET_VERSION": other})
        self.assertIn("MP_RECOVERY_TARGET_MISMATCH", out)
        self.assertNotIn("RECOVERY_TARGET_VERSION=" + self.N, out)
        # Nenhuma versão nova (a gravação não aconteceu) => nada a recuperar.
        rc, out, _ = self._run_step(needle, {**base, "/versions": versions([{"id": self.A, "number": 681}])}, {"PREV_VERSION_ID": self.A})
        self.assertIn("RECOVERY_TARGET_VERSION=none", out)

    def test_r2_recover_mode_uses_the_rehearsed_script_and_never_auto_returns(self):
        rec = [s for s in self.steps if "worker-version-recover.sh" in str(s.get("run", ""))]
        self.assertEqual(len(rec), 1)
        rec = rec[0]
        self.assertEqual(rec.get("if"), "inputs.mode == 'recover'")
        self.assertEqual(rec["env"], {"RECOVER_WORKER_NAME": "zevanory", "RECOVER_TARGET_VERSION": "${{ inputs.target_version }}"})
        self.assertIn("bash scripts/ops/worker-version-recover.sh", rec["run"])
        checkout = self.steps[0]
        self.assertEqual(checkout.get("if"), "inputs.mode == 'recover'")
        self.assertEqual(checkout["with"], {"persist-credentials": False})
        # O passo do ponto de retorno (que recusa 10215) não roda no recover; o retorno automático depende de
        # WRITE_ATTEMPTED_AT, que só o rotate grava => nunca volta para o token antigo depois de recuperar.
        point = self.steps[step_index(self.steps, 'PREV_VERSION_ID=$prev')]
        self.assertEqual(point.get("if"), "inputs.mode != 'recover'")
        self.assertNotIn("WRITE_ATTEMPTED_AT", rec["run"])
        self.assertLess(self.steps.index(rec), step_index(self.steps, "deadline=$((SECONDS"))
        self.assertIn("PREFLIGHT_AFTER=", rec["run"])


if __name__ == "__main__":
    unittest.main()
