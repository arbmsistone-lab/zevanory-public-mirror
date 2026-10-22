"""B02 "Conta e rota comercial": guarda do deploy do Worker zevanory-public-router e da descoberta de rotas.

Sem rede: carrega o YAML e EXECUTA os scripts reais dos passos com `curl`, `npx` e `sleep` falsos no PATH
(mesmo padrão de tests/test_mp_rotation_workflow.py::_run_step). As respostas seguem o formato documentado
pela Cloudflare:
  GET /accounts/{id} -> result.id
    https://developers.cloudflare.com/api/operations/accounts-account-details
  GET /accounts/{id}/workers/scripts/{name}/deployments -> result.deployments[0] = implantação ativa
    https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ROUTER_WF = Path(os.environ.get("ROUTER_WORKFLOW", ROOT / ".github/workflows/public-router-deploy.yml"))
DISCOVERY_WF = Path(os.environ.get("DISCOVERY_WORKFLOW", ROOT / ".github/workflows/zpc-cloudflare-route-discovery.yml"))

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
OTHER = "e3caca88f4343c3cdfcf66eebe6ac124"
SHA = "0123456789abcdef0123456789abcdef01234567"
PREV = "11111111-1111-1111-1111-111111111111"
NEW = "22222222-2222-2222-2222-222222222222"
CANARY = "Authorization: Bearer FAKE_CANARY"
ACCOUNT_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
APEX = "https://zevanory.api.br/"
SOLUCOES = "https://zevanory.api.br/solucoes"
STORE = "https://vendas.zevanory.api.br/solucoes"
# Limite por passo (s). Cada passo termina em < 2 s; o limite só existe para que nada prenda a suíte.
STEP_TIMEOUT = int(os.environ.get("ROUTER_TEST_STEP_TIMEOUT", "30"))
# Último registro do `sleep` falso (argumentos de cada chamada), lido pelos testes de nova tentativa.
LAST = {"sleep": ""}

CURL_STUB = r'''#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
url = a[-1]
out = a[a.index("-o") + 1] if "-o" in a else None
fmt = a[a.index("-w") + 1] if "-w" in a else ""
fx = json.load(open(%(fx)r))
with open(%(log)r, "a") as f:
    f.write(json.dumps(a) + "\n")
hit = fx.get(url)
if hit is None:
    keys = sorted((k for k in fx if k in url), key=len, reverse=True)
    hit = fx[keys[0]] if keys else ["404", {}, "", url]
code, body, redirect, effective = (list(hit) + ["", url])[:4]
if out and out != "/dev/null":
    open(out, "w").write(json.dumps(body))
sys.stdout.write(fmt.replace("%%{http_code}", code).replace("%%{redirect_url}", redirect).replace("%%{url_effective}", effective))
'''


def deployments(version, message=f"ZEVANORY public router {SHA}", http="200", extra=None):
    versions = [{"version_id": version, "percentage": 100}] if version else []
    if extra:
        versions = extra
    return [http, {"success": True, "result": {"deployments": [
        {"id": "d1", "versions": versions, "annotations": {"workers/message": message}}]}}]


ACCOUNT_OK = ["200", {"success": True, "result": {"id": ACCOUNT, "name": "ZEVANORY"}}]
APEX_OK = ["308", {}, STORE, APEX]
SOLUCOES_OK = ["200", {}, "", STORE]


def load(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def step(steps, needle):
    hits = [s for s in steps if needle in str(s.get("name", "")) or needle in str(s.get("run", ""))]
    assert hits, f"passo com {needle!r} não encontrado"
    return hits[0]


def run_step(script, fixtures, env_extra=None, npx_rc=0, npx_leak=False):
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / "fx.json").write_text(json.dumps(fixtures))
        (d / "curl").write_text(CURL_STUB % {"fx": str(d / "fx.json"), "log": str(d / "curl.log")})
        leak = ""
        if npx_leak:
            # wrangler hostil: ecoa stdin, o token do ambiente e um Bearer falso, mais um código numérico.
            leak = ('v="$(cat 2>/dev/null || true)"; echo "stdin=$v env=$CLOUDFLARE_API_TOKEN %s"; '
                    'echo "X [ERROR] boom [code: 10021]" >&2\n' % CANARY)
        (d / "npx").write_text("#!/bin/sh\necho \"npx $*\" >> %s/npx.log\n%sexit %d\n" % (d, leak, npx_rc))
        # `sleep` falso: registra o argumento e volta na hora (nenhuma espera real na suíte).
        (d / "sleep").write_text("#!/bin/sh\necho \"$*\" >> %s/sleep.log\nexit 0\n" % d)
        for f in ("curl", "npx", "sleep"):
            (d / f).chmod(0o755)
        (d / "ghenv").write_text("")
        env = {"PATH": f"{d}:{os.environ['PATH']}", "GITHUB_ENV": str(d / "ghenv"),
               "GITHUB_OUTPUT": str(d / "ghout"), "RUNNER_TEMP": str(d),
               "CLOUDFLARE_API_TOKEN": " stub-token\n", "ROUTER_ACCOUNT_ID": ACCOUNT,
               "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "EXPECTED_ACCOUNT_ID": ACCOUNT,
               "ROUTER_SCRIPT": "zevanory-public-router", "GITHUB_SHA": SHA,
               # Leitura de volta: 2 tentativas sem intervalo (produção: 12 x 5 s, padrão do próprio passo).
               "ROUTER_READBACK_ATTEMPTS": "2", "ROUTER_READBACK_SLEEP_SECONDS": "0", **(env_extra or {})}
        # Os falsos têm de vir primeiro no PATH; senão o `sleep` real (5 s por tentativa) entraria.
        for f in ("curl", "npx", "sleep"):
            assert shutil.which(f, path=env["PATH"]) == str(d / f), f"{f} falso não está primeiro no PATH"
        # stdin fechado e limite por passo: nada que leia a entrada padrão prende a suíte.
        p = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=STEP_TIMEOUT, cwd=str(ROOT))
        read = lambda n: (d / n).read_text() if (d / n).exists() else ""
        LAST["sleep"] = read("sleep.log")
        return p.returncode, p.stdout + p.stderr, read("npx.log"), read("curl.log"), read("ghenv")


class PublicRouterDeploy(unittest.TestCase):
    def setUp(self):
        self.doc = load(ROUTER_WF)
        self.job = self.doc["jobs"]["deploy"]
        self.steps = self.job["steps"]
        self.guard = step(self.steps, "Account guard")["run"]
        self.point = step(self.steps, "rollback point")["run"]
        self.deploy = step(self.steps, "Deploy public router Worker")["run"]
        self.readback = step(self.steps, "Readback")["run"]
        self.rollback_step = step(self.steps, "Automatic rollback")
        self.rollback = self.rollback_step["run"]

    # --- estrutura -------------------------------------------------------------------------------
    def test_job_is_behind_protected_environment_and_canonical_account(self):
        self.assertEqual(self.job.get("environment"), "producao-critica")
        self.assertIn("refs/heads/gh-pages", self.job["if"])
        self.assertIn("pull_request", self.job["if"])
        self.assertEqual(self.job["env"]["ROUTER_ACCOUNT_ID"], ACCOUNT)
        self.assertEqual(self.job["env"]["CLOUDFLARE_ACCOUNT_ID"], ACCOUNT)
        on = self.doc.get("on", self.doc.get(True))
        self.assertEqual(set(on), {"pull_request", "push", "workflow_dispatch"})

    def test_step_order_guard_point_deploy_readback_rollback(self):
        names = [s.get("name", "") for s in self.steps]
        idx = lambda n: next(i for i, x in enumerate(names) if n in x)
        self.assertLess(idx("Account guard"), idx("rollback point"))
        self.assertLess(idx("rollback point"), idx("Deploy public router Worker"))
        self.assertLess(idx("Deploy public router Worker"), idx("Readback"))
        self.assertLess(idx("Readback"), idx("Automatic rollback"))
        cond = self.rollback_step["if"]
        for part in ("failure()", "env.DEPLOY_ATTEMPTED == '1'", "env.PREV_VERSION_ID != ''"):
            self.assertIn(part, cond)

    def test_shell_discipline_every_bash_step(self):
        for s in self.steps:
            run = s.get("run")
            if not run or "\n" not in run:
                continue
            first = run.lstrip().splitlines()[0]
            self.assertEqual(first, "set -euo pipefail", s.get("name"))
            for line in run.splitlines():
                t = line.strip()
                # set -e ignora "! cmd" isolado e o primeiro termo de "a && b".
                self.assertFalse(t.startswith("! "), (s.get("name"), t))
                self.assertNotRegex(t, r"^\[.*\]\s*&&", (s.get("name"), t))
            if "CLOUDFLARE_API_TOKEN" in run:
                self.assertIn("tr -d '[:space:]'", run, s.get("name"))

    def test_wrangler_output_never_reaches_the_log(self):
        for run in (self.deploy, self.rollback):
            for line in run.splitlines():
                if "npx" in line and "wrangler" in line:
                    joined = run[run.index(line):].split("; then")[0]
                    self.assertRegex(joined, r'> "\$T/router-[a-z]+\.log" 2>&1', line)
                    self.assertNotIn("tee", joined)
        self.assertNotRegex(self.deploy + self.rollback, r"\b(cat|tail|head)\b[^\n]*router-(deploy|rollback)\.log")

    # --- guarda de conta ---------------------------------------------------------------------------
    def test_account_guard_passes_for_canonical_account_and_sanitizes_token(self):
        rc, out, _, curl, _ = run_step(self.guard, {ACCOUNT_URL: ACCOUNT_OK})
        self.assertEqual(rc, 0, out)
        self.assertIn("ROUTER_ACCOUNT_GUARD=PASS", out)
        self.assertIn('"Authorization: Bearer stub-token"', curl)
        self.assertIn(ACCOUNT_URL, curl)

    def test_account_guard_fails_closed(self):
        cases = {
            "http_403": {ACCOUNT_URL: ["403", ACCOUNT_OK[1]]},
            "other_account_in_body": {ACCOUNT_URL: ["200", {"success": True, "result": {"id": OTHER}}]},
            "success_false": {ACCOUNT_URL: ["200", {"success": False, "result": {"id": ACCOUNT}}]},
            "not_json_object": {ACCOUNT_URL: ["200", []]},
        }
        for name, fx in cases.items():
            rc, out, _, _, _ = run_step(self.guard, fx)
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTER_ACCOUNT_GUARD", out, name)
            self.assertNotIn("ROUTER_ACCOUNT_GUARD=PASS", out, name)
        rc, out, _, curl, _ = run_step(self.guard, {ACCOUNT_URL: ACCOUNT_OK}, {"CLOUDFLARE_API_TOKEN": " \n"})
        self.assertNotEqual(rc, 0)
        self.assertEqual(curl, "", "sem token nenhuma chamada é feita")
        # A conta é fixa: trocar a variável não faz o guarda aceitar outra conta lida pelo token.
        rc, out, _, _, _ = run_step(self.guard, {f"https://api.cloudflare.com/client/v4/accounts/{OTHER}":
                                                 ["200", {"success": True, "result": {"id": OTHER}}]},
                                    {"ROUTER_ACCOUNT_ID": OTHER})
        self.assertNotEqual(rc, 0, "toml declara a conta canônica; outra conta é recusada")

    # --- ponto de retorno ----------------------------------------------------------------------------
    def test_rollback_point_captured(self):
        rc, out, _, curl, ghenv = run_step(self.point, {"/deployments": deployments(PREV)})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"ROLLBACK_POINT={PREV}", out)
        self.assertIn(f"PREV_VERSION_ID={PREV}", ghenv)
        self.assertIn(f"/accounts/{ACCOUNT}/workers/scripts/zevanory-public-router/deployments", curl)
        for name, fx in {"http_500": deployments(PREV, http="500"),
                         "no_100": deployments(None, extra=[{"version_id": PREV, "percentage": 50},
                                                            {"version_id": NEW, "percentage": 50}]),
                         "bad_id": deployments("not-a-uuid"),
                         "empty": ["200", {"success": True, "result": {"deployments": []}}]}.items():
            rc, out, _, _, ghenv = run_step(self.point, {"/deployments": fx})
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTER_ROLLBACK_POINT", out, name)
            self.assertNotIn("PREV_VERSION_ID", ghenv, name)

    # --- deploy ---------------------------------------------------------------------------------------
    def test_deploy_is_tagged_with_release_sha(self):
        rc, out, npx, _, ghenv = run_step(self.deploy, {})
        self.assertEqual(rc, 0, out)
        self.assertIn("DEPLOY_ATTEMPTED=1", ghenv)
        self.assertIn(f"--tag {SHA}", npx)
        self.assertIn(f"--message ZEVANORY public router {SHA}", npx)
        self.assertIn("--config wrangler.public-router.toml", npx)
        rc, out, npx, _, _ = run_step(self.deploy, {}, {"GITHUB_SHA": "main"})
        self.assertNotEqual(rc, 0)
        self.assertEqual(npx, "")

    def test_raw_wrangler_output_never_printed(self):
        rc, out, npx, _, ghenv = run_step(self.deploy, {}, npx_rc=1, npx_leak=True)
        self.assertNotEqual(rc, 0)
        self.assertIn("deploy", npx)
        self.assertIn("ROUTER_DEPLOY_FAILED::codes=10021", out)
        self.assertIn("DEPLOY_ATTEMPTED=1", ghenv, "falha ambígua ainda aciona o retorno")
        for bad in (CANARY, "FAKE_CANARY", "stub-token", "boom"):
            self.assertNotIn(bad, out)
        rc, out, npx, _, _ = run_step(self.rollback, {"/deployments": deployments(PREV)},
                                      {"PREV_VERSION_ID": PREV}, npx_rc=1, npx_leak=True)
        self.assertIn("ROLLBACK_COMMAND_FAILED=1 codes=10021", out)
        for bad in (CANARY, "FAKE_CANARY", "stub-token", "boom"):
            self.assertNotIn(bad, out)

    # --- leitura de volta -----------------------------------------------------------------------------
    def _rb(self, dep=None, apex=APEX_OK, sol=SOLUCOES_OK):
        return {"/deployments": dep or deployments(NEW), APEX: apex, SOLUCOES: sol}

    def test_successful_deploy_readback(self):
        rc, out, _, curl, _ = run_step(self.readback, self._rb(), {"PREV_VERSION_ID": PREV})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"ROUTER_ACTIVE_VERSION={NEW}", out)
        self.assertIn("PUBLIC_ROUTE_READBACK=PASS", out)
        self.assertIn('"-L"', curl)

    def test_readback_failures(self):
        cases = {
            "still_previous_version": self._rb(dep=deployments(PREV)),
            "sha_not_in_message": self._rb(dep=deployments(NEW, message="manual dashboard edit")),
            "split_traffic": self._rb(dep=deployments(None, extra=[{"version_id": NEW, "percentage": 90},
                                                                  {"version_id": PREV, "percentage": 10}])),
            "api_http_500": self._rb(dep=deployments(NEW, http="500")),
            "apex_not_router": self._rb(apex=["200", {}, "", APEX]),
            "public_route_502": self._rb(sol=["502", {}, "", STORE]),
            "public_route_wrong_target": self._rb(sol=["200", {}, "", "https://zevanory.api.br/solucoes"]),
        }
        for name, fx in cases.items():
            rc, out, _, _, _ = run_step(self.readback, fx, {"PREV_VERSION_ID": PREV})
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTER_READBACK_FAIL", out, name)
            self.assertNotIn("PUBLIC_ROUTE_READBACK=PASS", out, name)

    def test_readback_retry_defaults_and_injected_interval(self):
        # Padrão de produção fixo no passo: 12 tentativas, 5 s entre elas.
        self.assertIn('attempts="${ROUTER_READBACK_ATTEMPTS:-12}"', self.readback)
        self.assertIn('pause="${ROUTER_READBACK_SLEEP_SECONDS:-5}"', self.readback)
        # Com 3 tentativas: 3 leituras da API, 2 pausas com o intervalo injetado, nenhuma após a última.
        rc, out, _, curl, _ = run_step(self.readback, self._rb(dep=deployments(PREV)),
                                       {"PREV_VERSION_ID": PREV, "ROUTER_READBACK_ATTEMPTS": "3",
                                        "ROUTER_READBACK_SLEEP_SECONDS": "7"})
        self.assertNotEqual(rc, 0)
        self.assertIn("ROUTER_READBACK_FAIL::attempts=3", out)
        self.assertEqual(curl.count("/deployments"), 3)
        self.assertEqual(LAST["sleep"].split(), ["7", "7"])
        # Sucesso na primeira tentativa: nenhuma pausa.
        rc, out, _, _, _ = run_step(self.readback, self._rb(), {"PREV_VERSION_ID": PREV})
        self.assertEqual(rc, 0, out)
        self.assertEqual(LAST["sleep"], "")

    def test_readback_rejects_invalid_retry_settings(self):
        for env in ({"ROUTER_READBACK_ATTEMPTS": "0"}, {"ROUTER_READBACK_ATTEMPTS": "x"},
                    {"ROUTER_READBACK_SLEEP_SECONDS": "-1"}, {"ROUTER_READBACK_ATTEMPTS": "999"}):
            rc, out, _, curl, _ = run_step(self.readback, self._rb(), {"PREV_VERSION_ID": PREV, **env})
            self.assertNotEqual(rc, 0, env)
            self.assertIn("ROUTER_READBACK_FAIL", out, env)
            self.assertEqual(curl, "", env)

    # --- retorno automático -----------------------------------------------------------------------------
    def test_failed_readback_triggers_rollback_and_it_is_readback_verified(self):
        # 1) leitura falha => passo sai != 0, o que torna failure() verdadeiro para o passo de retorno.
        rc, out, _, _, _ = run_step(self.readback, self._rb(dep=deployments(PREV)), {"PREV_VERSION_ID": PREV})
        self.assertNotEqual(rc, 0)
        # 2) retorno: wrangler rollback <prev> e leitura confirma prev a 100%.
        rc, out, npx, curl, _ = run_step(self.rollback, {"/deployments": deployments(PREV)},
                                         {"PREV_VERSION_ID": PREV, "DEPLOY_ATTEMPTED": "1"})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"rollback {PREV} --name zevanory-public-router --message", npx)
        self.assertIn("ROLLBACK_READBACK=PASS", out)
        self.assertIn("/deployments", curl)

    def test_rollback_readback_mismatch_is_an_incident(self):
        cases = {
            "other_active": {"/deployments": deployments(NEW)},
            "http_500": {"/deployments": deployments(PREV, http="500")},
            "split": {"/deployments": deployments(None, extra=[{"version_id": PREV, "percentage": 50},
                                                               {"version_id": NEW, "percentage": 50}])},
        }
        for name, fx in cases.items():
            rc, out, npx, _, _ = run_step(self.rollback, fx, {"PREV_VERSION_ID": PREV})
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTER_ROLLBACK_READBACK_FAIL", out, name)
            self.assertNotIn("ROLLBACK_READBACK=PASS", out, name)
            self.assertIn("rollback", npx, name)
        # Comando falhou e nada voltou => incidente.
        rc, out, _, _, _ = run_step(self.rollback, {"/deployments": deployments(NEW)}, {"PREV_VERSION_ID": PREV}, npx_rc=1)
        self.assertNotEqual(rc, 0)
        self.assertIn("ROUTER_ROLLBACK_READBACK_FAIL", out)


class RouteDiscoveryAccount(unittest.TestCase):
    def setUp(self):
        self.text = DISCOVERY_WF.read_text(encoding="utf-8")
        self.job = load(DISCOVERY_WF)["jobs"]["discover"]
        self.guard = step(self.job["steps"], "Refuse any account")["run"]

    def test_only_canonical_account_is_configured(self):
        self.assertEqual(self.job["env"]["CLOUDFLARE_ACCOUNT_ID"], ACCOUNT)
        self.assertEqual(self.job["env"]["EXPECTED_ACCOUNT_ID"], ACCOUNT)
        self.assertNotIn("e3caca88", self.text)
        self.assertNotIn("secrets.CLOUDFLARE_ACCOUNT_ID", self.text)
        self.assertEqual(self.job["steps"][0]["name"], "Refuse any account other than the canonical ZEVANORY account")

    def test_discovery_refuses_other_account(self):
        rc, out, _, _, _ = run_step(self.guard, {})
        self.assertEqual(rc, 0, out)
        self.assertIn(f"ROUTE_DISCOVERY_ACCOUNT={ACCOUNT}", out)
        for env in ({"CLOUDFLARE_ACCOUNT_ID": OTHER}, {"CLOUDFLARE_ACCOUNT_ID": ""},
                    {"CLOUDFLARE_ACCOUNT_ID": OTHER, "EXPECTED_ACCOUNT_ID": OTHER}):
            rc, out, _, _, _ = run_step(self.guard, {}, env)
            self.assertNotEqual(rc, 0, env)
            self.assertIn("ROUTE_DISCOVERY_ACCOUNT::", out, env)

    def test_discovery_token_is_sanitized(self):
        for s in self.job["steps"]:
            run = s.get("run", "")
            if "Bearer $CLOUDFLARE_API_TOKEN" in run:
                self.assertIn("tr -d '[:space:]'", run, s.get("name"))


if __name__ == "__main__":
    unittest.main()
