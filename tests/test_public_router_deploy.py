"""B02 "Conta e rota comercial": guarda do deploy do Worker zevanory-public-router e da descoberta de rotas.

Sem rede: carrega o YAML e EXECUTA os scripts reais dos passos com `curl`, `npx` e `sleep` falsos no PATH
(mesmo padrão de tests/test_mp_rotation_workflow.py::_run_step). As respostas seguem o formato documentado
pela Cloudflare:
  GET /accounts/{id} -> result.id
    https://developers.cloudflare.com/api/operations/accounts-account-details
  GET /accounts/{id}/workers/scripts/{name}/deployments -> result.deployments[0] = implantação ativa
    https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list
  GET/POST /zones/{zone_id}/workers/routes, PUT/DELETE /zones/{zone_id}/workers/routes/{route_id} -> id, pattern, script
    https://developers.cloudflare.com/api/resources/workers/subresources/routes/index.md

Cloudflare falsa com ESTADO (rotas por zona, versão ativa) para os testes de rotas: o `npx wrangler deploy` falso
aplica o efeito documentado do wrangler (rotas do router = toml) e depois efeitos HOSTIS injetados (remove/altera/
acrescenta rotas de outros scripts); o `wrangler rollback` falso só troca a versão — como o real, não toca em rotas.
"""
import json
import os
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ROUTER_WF = Path(os.environ.get("ROUTER_WORKFLOW", ROOT / ".github/workflows/public-router-deploy.yml"))
DISCOVERY_WF = Path(os.environ.get("DISCOVERY_WORKFLOW", ROOT / ".github/workflows/zpc-cloudflare-route-discovery.yml"))
# Mutantes do script de rotas: o passo continua citando scripts/ops/router_routes.py; o teste troca pelo caminho dado.
ROUTES_SCRIPT = Path(os.environ.get("ROUTER_ROUTES_SCRIPT", ROOT / "scripts/ops/router_routes.py"))

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
OTHER = "e3caca88f4343c3cdfcf66eebe6ac124"
SHA = "0123456789abcdef0123456789abcdef01234567"
PREV = "11111111-1111-1111-1111-111111111111"
NEW = "22222222-2222-2222-2222-222222222222"
CANARY = "Authorization: Bearer FAKE_CANARY"
ACCOUNT_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
DEP_URL = f"{ACCOUNT_URL}/workers/scripts/zevanory-public-router/deployments"
APEX = "https://zevanory.api.br/"
SOLUCOES = "https://zevanory.api.br/solucoes"
STORE = "https://vendas.zevanory.api.br/solucoes"
ROUTER = "zevanory-public-router"
ZONE = "0f0e0d0c0b0a09080706050403020100"
OTHER_ZONE = "aa" * 16
# Os 16 padrões vêm do toml real (não de uma cópia no teste).
PATTERNS = tomllib.loads((ROOT / "wrangler.public-router.toml").read_text())["routes"]
PUBLIC = {"zevanory.api.br/", "zevanory.api.br/solucoes*"}  # os 2 cobertos pelas provas públicas
# Rotas de OUTROS scripts na mesma zona, fora das 2 URLs públicas monitoradas (caso concreto do Sol).
OTHERS = [("zevanory.api.br/api/*", "zevanory"), ("zevanory.api.br/admin*", "zevanory"),
          ("edge.zevanory.api.br/*", "zevanory-edge"), ("zevanory.api.br/legacy*", None)]
# Limite por passo (s). Cada passo termina em < 2 s; o limite só existe para que nada prenda a suíte.
STEP_TIMEOUT = int(os.environ.get("ROUTER_TEST_STEP_TIMEOUT", "30"))
# Último registro do `sleep` falso (argumentos de cada chamada) e o estado final da Cloudflare falsa.
LAST = {"sleep": "", "state": None}

CURL_STUB = r'''#!/usr/bin/env python3
import json, os, re, sys
a = sys.argv[1:]
url = a[-1]
out = a[a.index("-o") + 1] if "-o" in a else None
fmt = a[a.index("-w") + 1] if "-w" in a else ""
method = a[a.index("-X") + 1] if "-X" in a else "GET"
data = json.loads(a[a.index("--data") + 1]) if "--data" in a else None
heads = [a[i + 1] for i, x in enumerate(a) if x == "-H"]
fx = json.load(open(%(fx)r))
with open(%(log)r, "a") as f:
    f.write(json.dumps(a) + "\n")
API = "https://api.cloudflare.com/client/v4"
ACCOUNT = %(account)r


def emit(code, body, redirect="", effective=None):
    if out and out != "/dev/null":
        open(out, "w").write(json.dumps(body))
    sys.stdout.write(fmt.replace("%%{http_code}", code).replace("%%{redirect_url}", redirect)
                     .replace("%%{url_effective}", effective or url))
    sys.exit(0)


st_path = %(st)r
if os.path.exists(st_path):
    st = json.load(open(st_path))
    fail = st.get("fail", {})
    hostile = {"success": False, "errors": [{"code": 9109, "message": "boom %(canary)s"}]}
    bad_tok = "Authorization: Bearer stub-token" not in heads

    def save():
        json.dump(st, open(st_path, "w"))

    def ok(result):
        emit("200", {"success": True, "errors": [], "messages": [], "result": result})

    if url == API + "/accounts/" + ACCOUNT + "/workers/scripts/zevanory-public-router/deployments":
        if fail.get("deployments"):
            emit(fail["deployments"], hostile)
        vs = [{"version_id": st["active"], "percentage": 100}]
        if st.get("split"):
            vs = [{"version_id": st["active"], "percentage": 50}, {"version_id": st["split"], "percentage": 50}]
        ok({"deployments": [{"id": "d", "versions": vs, "annotations": {"workers/message": st.get("message", "")}}]})
    if url.startswith(API + "/zones"):
        if bad_tok:
            emit("403", hostile)
        m = re.fullmatch(re.escape(API) + r"/zones\?name=([^&]+)&account\.id=([0-9a-f]{32})", url)
        if m and method == "GET":
            if fail.get("zones"):
                emit(fail["zones"], hostile)
            # Hostil: ignora o filtro account.id e devolve a zona com a conta VERDADEIRA dela.
            ok([{"id": zid, "name": z["name"], "account": {"id": z["account"]}}
                for zid, z in st["zones"].items() if z["name"] == m.group(1)])
        m = re.fullmatch(re.escape(API) + r"/zones/([0-9a-f]{32})", url)
        if m and method == "GET" and m.group(1) in st["zones"]:
            if fail.get("zone_get"):
                emit(fail["zone_get"], hostile)
            z = st["zones"][m.group(1)]
            ok({"id": m.group(1), "name": z["name"], "account": {"id": st.get("zone_get_account", z["account"])}})
        m = re.fullmatch(re.escape(API) + r"/zones/([0-9a-f]{32})/workers/routes(?:/([0-9a-f]{32}))?", url)
        if m and m.group(1) in st["zones"]:
            z, rid = st["zones"][m.group(1)], m.group(2)
            if method == "GET" and not rid:
                n = st["lists"] = st.get("lists", 0) + 1
                save()
                if fail.get("list") and n >= fail.get("list_from", 1):
                    emit(fail["list"], hostile)
                ok([{"id": r["id"], "pattern": r["pattern"], **({"script": r["script"]} if r["script"] else {})}
                    for r in z["routes"]])
            if method in ("POST", "PUT", "DELETE"):
                if fail.get("write"):
                    emit(fail["write"], hostile)
                st.setdefault("writes", []).append([method, m.group(1)])
                if st.get("lie_writes"):
                    save()
                    ok({"id": rid or "0" * 32})
                if method == "POST":
                    if any(r["pattern"] == data["pattern"] for r in z["routes"]):
                        emit("409", {"success": False, "errors": [{"code": 10020, "message": "duplicate"}]})
                    st["seq"] = st.get("seq", 0) + 1
                    new = {"id": "%%032x" %% (0xbeef0000 + st["seq"]), "pattern": data["pattern"], "script": data.get("script")}
                    z["routes"].append(new)
                    save()
                    ok(new)
                hit = [r for r in z["routes"] if r["id"] == rid]
                if not hit:
                    emit("404", hostile)
                if method == "PUT":
                    hit[0].update({"pattern": data["pattern"], "script": data.get("script")})
                else:
                    z["routes"].remove(hit[0])
                save()
                ok({"id": rid})
        emit("404", hostile)
    if url in st.get("public", {}):
        emit(*st["public"][url])

hit = fx.get(url)
if hit is None:
    keys = sorted((k for k in fx if k in url), key=len, reverse=True)
    hit = fx[keys[0]] if keys else ["404", {}, "", url]
code, body, redirect, effective = (list(hit) + ["", url])[:4]
emit(code, body, redirect, effective)
'''

NPX_STUB = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(%(log)r, "a") as f:
    f.write("npx " + " ".join(a) + "\n")
if %(leak)r:
    # wrangler hostil: ecoa stdin, o token do ambiente e um Bearer falso, mais um código numérico.
    print("stdin=" + sys.stdin.read() + " env=" + os.environ.get("CLOUDFLARE_API_TOKEN", "") + " " + %(canary)r)
    print("X [ERROR] boom [code: 10021]", file=sys.stderr)
st_path = %(st)r
if os.path.exists(st_path):
    st = json.load(open(st_path))
    if "deploy" in a:
        st["deploys"] = st.get("deploys", 0) + 1
        for z in st["zones"].values():
            if z["account"] != st["config_account"]:
                continue
            # Efeito documentado: as rotas do router passam a ser exatamente as do arquivo de configuração.
            z["routes"] = [r for r in z["routes"] if r["script"] != st["router"]]
            for p in st["config"]:
                z["routes"] = [r for r in z["routes"] if r["pattern"] != p]
                st["seq"] = st.get("seq", 0) + 1
                z["routes"].append({"id": "%%032x" %% (0xdead0000 + st["seq"]), "pattern": p, "script": st["router"]})
            # Efeitos hostis injetados pelo teste (fora do que o toml pede).
            for op in st.get("on_deploy", []):
                if op[0] == "remove":
                    z["routes"] = [r for r in z["routes"] if r["pattern"] != op[1]]
                elif op[0] == "set":
                    for r in z["routes"]:
                        if r["pattern"] == op[1]:
                            r["script"] = op[2]
                elif op[0] == "add":
                    st["seq"] = st.get("seq", 0) + 1
                    z["routes"].append({"id": "%%032x" %% (0xadd00000 + st["seq"]), "pattern": op[1], "script": op[2]})
        st["active"] = st.get("deploy_version", "22222222-2222-2222-2222-222222222222")
        st["message"] = "ZEVANORY public router " + os.environ.get("GITHUB_SHA", "")
    elif "rollback" in a and not st.get("rollback_noop"):
        st["active"] = a[a.index("rollback") + 1]  # como o real: só a versão; rotas ficam como estão
    json.dump(st, open(st_path, "w"))
sys.exit(%(rc)d)
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


def cf_state(others=OTHERS, router=PATTERNS, extra_zones=None, **kw):
    """Estado inicial: os 16 padrões já no router + rotas de outros scripts; versão ativa PREV; provas públicas OK."""
    routes = [{"id": "%032x" % (0x1000 + i), "pattern": p, "script": ROUTER} for i, p in enumerate(router)]
    routes += [{"id": "%032x" % (0x2000 + i), "pattern": p, "script": s} for i, (p, s) in enumerate(others)]
    st = {"zones": {ZONE: {"name": "zevanory.api.br", "account": ACCOUNT, "routes": routes}},
          "active": PREV, "router": ROUTER, "config": list(PATTERNS), "config_account": ACCOUNT,
          "public": {APEX: APEX_OK, SOLUCOES: SOLUCOES_OK}}
    st["zones"].update(extra_zones or {})
    st.update(kw)
    return st


def inv(state, zone=ZONE):
    return sorted((r["pattern"], r["script"] or "") for r in state["zones"][zone]["routes"])


def load(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def step(steps, needle):
    hits = [s for s in steps if needle in str(s.get("name", "")) or needle in str(s.get("run", ""))]
    assert hits, f"passo com {needle!r} não encontrado"
    return hits[0]


def _run_in(d, script, fixtures, env_extra, npx_rc, npx_leak, state, gha):
    (d / "fx.json").write_text(json.dumps(fixtures))
    if state is not None:
        (d / "st.json").write_text(json.dumps(state))
    for n in ("curl.log", "npx.log", "sleep.log"):
        (d / n).unlink(missing_ok=True)
    (d / "curl").write_text(CURL_STUB % {"fx": str(d / "fx.json"), "log": str(d / "curl.log"), "st": str(d / "st.json"),
                                         "account": ACCOUNT, "canary": CANARY})
    (d / "npx").write_text(NPX_STUB % {"log": str(d / "npx.log"), "st": str(d / "st.json"), "leak": npx_leak,
                                       "canary": CANARY, "rc": npx_rc})
    # `sleep` falso: registra o argumento e volta na hora (nenhuma espera real na suíte).
    (d / "sleep").write_text("#!/bin/sh\necho \"$*\" >> %s/sleep.log\nexit 0\n" % d)
    for f in ("curl", "npx", "sleep"):
        (d / f).chmod(0o755)
    if not (d / "ghenv").exists():
        (d / "ghenv").write_text("")
    env = {"PATH": f"{d}:{os.environ['PATH']}", "GITHUB_ENV": str(d / "ghenv"),
           "GITHUB_OUTPUT": str(d / "ghout"), "RUNNER_TEMP": str(d), "PYTHONDONTWRITEBYTECODE": "1",
           "CLOUDFLARE_API_TOKEN": " stub-token\n", "ROUTER_ACCOUNT_ID": ACCOUNT,
           "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "EXPECTED_ACCOUNT_ID": ACCOUNT,
           "ROUTER_SCRIPT": ROUTER, "GITHUB_SHA": SHA,
           # Leitura de volta: 2 tentativas sem intervalo (produção: 12 x 5 s, padrão do próprio passo).
           "ROUTER_READBACK_ATTEMPTS": "2", "ROUTER_READBACK_SLEEP_SECONDS": "0"}
    if gha:
        env["GITHUB_ACTIONS"] = "true"
    # Como no Actions: o que um passo anterior gravou em $GITHUB_ENV chega aos passos seguintes.
    for line in (d / "ghenv").read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    env.update(env_extra or {})
    # Os falsos têm de vir primeiro no PATH; senão o `sleep` real (5 s por tentativa) entraria.
    for f in ("curl", "npx", "sleep"):
        assert shutil.which(f, path=env["PATH"]) == str(d / f), f"{f} falso não está primeiro no PATH"
    script = script.replace("scripts/ops/router_routes.py", str(ROUTES_SCRIPT))
    # stdin fechado e limite por passo: nada que leia a entrada padrão prende a suíte.
    p = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=STEP_TIMEOUT, cwd=str(ROOT))
    read = lambda n: (d / n).read_text() if (d / n).exists() else ""
    LAST["sleep"] = read("sleep.log")
    LAST["state"] = json.loads(read("st.json")) if (d / "st.json").exists() else None
    return p.returncode, p.stdout + p.stderr, read("npx.log"), read("curl.log"), read("ghenv")


def run_step(script, fixtures, env_extra=None, npx_rc=0, npx_leak=False, state=None, gha=False, workdir=None):
    if workdir is not None:
        return _run_in(Path(workdir), script, fixtures, env_extra, npx_rc, npx_leak, state, gha)
    with tempfile.TemporaryDirectory() as d:
        return _run_in(Path(d), script, fixtures, env_extra, npx_rc, npx_leak, state, gha)


class Job:
    """Simula o job `deploy` passo a passo num mesmo runner: $GITHUB_ENV acumulado, `failure()` e o `if` do retorno."""
    ORDER = ("Account guard", "rollback point", "Snapshot Worker routes", "Deploy public router Worker",
             "Verify full route inventory", "Readback", "Automatic rollback")

    def __init__(self, steps, state, gha=False):
        self.steps, self.state, self.gha, self.res = steps, state, gha, {}

    def run(self):
        fx = {ACCOUNT_URL: ACCOUNT_OK}
        with tempfile.TemporaryDirectory() as d:
            failed, first = False, True
            for name in self.ORDER:
                s = step(self.steps, name)
                if name == "Automatic rollback":
                    envs = dict(l.split("=", 1) for l in (Path(d) / "ghenv").read_text().splitlines() if "=" in l)
                    if not (failed and envs.get("DEPLOY_ATTEMPTED") == "1" and envs.get("PREV_VERSION_ID")):
                        break
                elif failed:
                    continue
                rc, out, npx, curl, _ = run_step(s["run"], fx, state=self.state if first else None, gha=self.gha, workdir=d)
                first = False
                self.res[name] = (rc, out, npx, curl)
                failed = failed or rc != 0
        self.final = LAST["state"]
        return self


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
        self.snapshot = step(self.steps, "Snapshot Worker routes")["run"]
        self.verify = step(self.steps, "Verify full route inventory")["run"]

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
        self.assertLess(idx("rollback point"), idx("Snapshot Worker routes"))
        self.assertLess(idx("Snapshot Worker routes"), idx("Deploy public router Worker"))
        self.assertLess(idx("Deploy public router Worker"), idx("Verify full route inventory"))
        self.assertLess(idx("Verify full route inventory"), idx("Readback"))
        self.assertLess(idx("Readback"), idx("Automatic rollback"))
        self.assertEqual(idx("Automatic rollback"), len(names) - 1)
        # Foto e verificação não têm `if`: rodam sempre que os anteriores passam (failure() padrão encerra o resto).
        for n in ("Snapshot Worker routes", "Verify full route inventory"):
            self.assertNotIn("if", self.steps[idx(n)], n)
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

    def test_readbacks_query_only_the_canonical_account(self):
        # Fixture pela URL COMPLETA da conta canônica: uma leitura em outra conta cai no 404 do stub e não passa.
        dep_url = f"{ACCOUNT_URL}/workers/scripts/zevanory-public-router/deployments"
        rc, out, _, curl, _ = run_step(self.readback, {dep_url: deployments(NEW), APEX: APEX_OK, SOLUCOES: SOLUCOES_OK},
                                       {"PREV_VERSION_ID": PREV})
        self.assertEqual(rc, 0, out)
        self.assertIn(dep_url, curl)
        self.assertNotIn(OTHER, curl)
        # Retorno: a Cloudflare falsa só responde as implantações na URL completa da conta canônica.
        job = Job(self.steps, cf_state(deploy_version=PREV)).run()
        rc, out, _, curl = job.res["Automatic rollback"]
        self.assertEqual(rc, 0, out)
        self.assertIn("ROLLBACK_READBACK=PASS", out)
        self.assertIn(dep_url, curl)
        for name, (_, _, _, c) in job.res.items():
            self.assertNotIn(OTHER, c, name)

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
        # Deploy "aplica" mas a versão ativa continua a anterior => leitura falha => retorno certificado.
        job = Job(self.steps, cf_state(deploy_version=PREV)).run()
        self.assertNotEqual(job.res["Readback"][0], 0)
        rc, out, npx, curl = job.res["Automatic rollback"]
        self.assertEqual(rc, 0, out)
        self.assertIn(f"rollback {PREV} --name zevanory-public-router --message", npx)
        self.assertIn("ROLLBACK_READBACK=PASS", out)
        self.assertIn("ROUTES_RESTORE_READBACK=PASS", out)
        self.assertIn("/deployments", curl)

    def _rollback_after_snapshot(self, state, npx_rc=0, env=None):
        """Foto real (passo Snapshot) e depois só o passo de retorno, no mesmo runner."""
        with tempfile.TemporaryDirectory() as d:
            rc, out, _, _, _ = run_step(self.snapshot, {}, state=state, workdir=d)
            self.assertEqual(rc, 0, out)
            return run_step(self.rollback, {}, {"PREV_VERSION_ID": PREV, "DEPLOY_ATTEMPTED": "1", **(env or {})},
                            npx_rc=npx_rc, workdir=d)

    def test_rollback_readback_mismatch_is_an_incident(self):
        # Rotas e provas públicas OK; só a versão diverge => incidente (a versão não pode ser ignorada).
        cases = {
            "other_active": (cf_state(active=NEW, rollback_noop=True), 1),
            "http_500": (cf_state(fail={"deployments": "500"}), 0),
            "split": (cf_state(split=NEW), 0),
        }
        for name, (st, rc_npx) in cases.items():
            rc, out, npx, _, _ = self._rollback_after_snapshot(st, npx_rc=rc_npx)
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTER_ROLLBACK_READBACK_FAIL", out, name)
            self.assertIn("version=0 routes=1 public=1", out, name)
            self.assertNotIn("ROLLBACK_READBACK=PASS", out, name)
            self.assertIn("rollback", npx, name)
        # Sem foto de rotas: nunca PASS, mesmo com a versão certa.
        rc, out, _, _, _ = run_step(self.rollback, {}, {"PREV_VERSION_ID": PREV}, state=cf_state())
        self.assertNotEqual(rc, 0)
        self.assertIn("ROUTER_ROLLBACK_ROUTES_FAIL", out)
        self.assertIn("version=1 routes=0", out)

class RouteInventory(unittest.TestCase):
    """Achado do Sol: o rollback devolve a versão, não as rotas. Foto antes, verificação completa depois e
    restauração certificada no retorno — contra uma Cloudflare falsa com estado e efeitos hostis."""

    def setUp(self):
        self.steps = load(ROUTER_WF)["jobs"]["deploy"]["steps"]
        self.snapshot = step(self.steps, "Snapshot Worker routes")["run"]
        self.verify = step(self.steps, "Verify full route inventory")["run"]
        self.rollback = step(self.steps, "Automatic rollback")["run"]

    def _snap_then(self, state, mutate, script, gha=False, env=None):
        """Foto real; depois `mutate(estado)` (o que o deploy teria feito); depois `script` no mesmo runner."""
        with tempfile.TemporaryDirectory() as d:
            rc, out, _, _, _ = run_step(self.snapshot, {}, state=state, workdir=d, gha=gha)
            self.assertEqual(rc, 0, out)
            st = json.loads((Path(d) / "st.json").read_text())
            mutate(st)
            (Path(d) / "st.json").write_text(json.dumps(st))
            return run_step(script, {}, env, workdir=d, gha=gha)

    @staticmethod
    def _routes(st):
        return st["zones"][ZONE]["routes"]

    def _no_leak(self, out, gha):
        for bad in ("stub-token", "FAKE_CANARY", "boom", ZONE, "zevanory.api.br/api/", "\"result\""):
            lines = [l for l in out.splitlines() if bad in l and not (gha and l.startswith("::add-mask::"))]
            self.assertEqual(lines, [], (bad, gha))
        masks = [l for l in out.splitlines() if l.startswith("::add-mask::")]
        if gha:
            self.assertIn("::add-mask::stub-token", masks)
        else:
            self.assertEqual(masks, [], "fora do Actions nada é ecoado nem para mascarar")

    # --- estrutura ----------------------------------------------------------------------------------------
    def test_route_steps_are_wired_to_the_inventory_script(self):
        self.assertIn('python3 scripts/ops/router_routes.py snapshot "$T/router-routes-before.json"', self.snapshot)
        self.assertIn('echo "ROUTES_SNAPSHOT=$T/router-routes-before.json" >> "$GITHUB_ENV"', self.snapshot)
        self.assertNotRegex(self.snapshot, r"\|\|\s*true|wrangler")
        self.assertIn('python3 scripts/ops/router_routes.py verify "${ROUTES_SNAPSHOT:?', self.verify)
        self.assertIn('python3 scripts/ops/router_routes.py restore "$ROUTES_SNAPSHOT"', self.rollback)
        src = ROUTES_SCRIPT.read_text()
        self.assertIn('CANONICAL_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"', src)
        self.assertNotIn(OTHER, src)

    # --- foto antes do deploy -------------------------------------------------------------------------------
    def test_snapshot_is_read_only_complete_and_prints_only_counts(self):
        for gha in (False, True):
            with tempfile.TemporaryDirectory() as d:
                rc, out, _, curl, ghenv = run_step(self.snapshot, {}, state=cf_state(), workdir=d, gha=gha)
                self.assertEqual(rc, 0, out)
                self.assertIn("ROUTES_SNAPSHOT=PASS zones=1 routes=20 router_routes=16 expected_patterns=16", out)
                self.assertIn(f"ROUTES_SNAPSHOT={d}/router-routes-before.json", ghenv)
                snap = json.loads((Path(d) / "router-routes-before.json").read_text())
                self.assertEqual(oct((Path(d) / "router-routes-before.json").stat().st_mode & 0o777), "0o600")
                self.assertEqual(snap["account"], ACCOUNT)
                self.assertEqual(sorted((r["pattern"], r["script"] or "") for r in snap["zones"][ZONE]["routes"]),
                                 inv(cf_state()))
                calls = [json.loads(l) for l in curl.splitlines()]
                self.assertTrue(calls)
                self.assertEqual({c[c.index("-X") + 1] for c in calls}, {"GET"}, "a foto é só leitura")
                self.assertNotIn("writes", LAST["state"])
                self._no_leak(out, gha)
                if gha:
                    self.assertIn(f"::add-mask::{ZONE}", out.splitlines())

    def test_snapshot_fails_closed_and_blocks_the_deploy(self):
        conflict = cf_state(others=OTHERS + [("zevanory.api.br/termos*", "zevanory")],
                            router=[p for p in PATTERNS if p != "zevanory.api.br/termos*"])
        drift = cf_state(others=OTHERS + [("zevanory.api.br/painel*", ROUTER)])
        cases = {"list_500": cf_state(fail={"list": "500"}), "zones_403": cf_state(fail={"zones": "403"}),
                 "zone_missing": cf_state(extra_zones={}, zones={}),
                 "expected_owned_by_other_script": conflict, "router_route_outside_toml": drift}
        cases["zone_missing"]["zones"] = {}
        for gha in (False, True):
            for name, st in cases.items():
                with tempfile.TemporaryDirectory() as d:
                    rc, out, _, curl, ghenv = run_step(self.snapshot, {}, state=st, workdir=d, gha=gha)
                    self.assertNotEqual(rc, 0, name)
                    self.assertIn("ROUTES_SNAPSHOT_FAIL", out, name)
                    self.assertNotIn("ROUTES_SNAPSHOT=PASS", out, name)
                    self.assertNotIn("ROUTES_SNAPSHOT=", ghenv, name)
                    self.assertFalse((Path(d) / "router-routes-before.json").exists(), name)
                    self._no_leak(out, gha)
        # No job inteiro: foto falhou => wrangler deploy nunca roda e não há retorno (nada foi tentado).
        job = Job(self.steps, cf_state(fail={"list": "500"})).run()
        self.assertNotIn("Deploy public router Worker", job.res)
        self.assertNotIn("Automatic rollback", job.res)
        self.assertNotIn("deploys", job.final)

    def test_zone_of_another_account_is_rejected(self):
        # A Cloudflare falsa ignora o filtro account.id; a zona encontrada é de outra conta => recusa, sem listar rotas.
        st = cf_state()
        st["zones"][ZONE]["account"] = OTHER
        rc, out, _, curl, _ = run_step(self.snapshot, {}, state=st)
        self.assertNotEqual(rc, 0)
        self.assertIn("outra conta", out)
        self.assertNotIn("/workers/routes", curl)
        self.assertIn(f"account.id={ACCOUNT}", curl)
        # ROUTER_ACCOUNT_ID trocado: recusa antes de qualquer chamada.
        rc, out, _, curl, _ = run_step(self.snapshot, {}, {"ROUTER_ACCOUNT_ID": OTHER}, state=cf_state())
        self.assertNotEqual(rc, 0)
        self.assertEqual(curl, "")

    # --- verificação pós-deploy -----------------------------------------------------------------------------
    def test_verify_requires_every_one_of_the_16_patterns(self):
        self.assertEqual(len(PATTERNS), 16)
        with tempfile.TemporaryDirectory() as d:
            rc, out, _, _, _ = run_step(self.snapshot, {}, state=cf_state(), workdir=d)
            self.assertEqual(rc, 0, out)
            rc, out, _, _, _ = run_step(self.verify, {}, workdir=d)
            self.assertEqual(rc, 0, out)
            self.assertIn("ROUTES_VERIFY=PASS checked=20 expected_patterns=16", out)
            # Cada um dos 16 padrões (não só os 2 das provas públicas): ausente, ou apontando para outro script.
            for p in PATTERNS:
                for kind, marker in (("gone", "missing_expected=1"), ("moved", "changed=1")):
                    st = cf_state()
                    if kind == "gone":
                        st["zones"][ZONE]["routes"] = [r for r in self._routes(st) if r["pattern"] != p]
                    else:
                        next(r for r in self._routes(st) if r["pattern"] == p)["script"] = "zevanory"
                    rc, out, _, _, _ = run_step(self.verify, {}, state=st, workdir=d)
                    self.assertNotEqual(rc, 0, (p, kind))
                    self.assertIn(marker, out, (p, kind))

    def test_verify_detects_any_change_to_other_scripts_routes(self):
        def removed(st):  # caso do Sol: rota de outro script, fora das 2 URLs públicas, some
            st["zones"][ZONE]["routes"] = [r for r in self._routes(st) if r["pattern"] != "zevanory.api.br/api/*"]
        def changed(st):
            next(r for r in self._routes(st) if r["pattern"] == "edge.zevanory.api.br/*")["script"] = ROUTER
        def unbound(st):
            next(r for r in self._routes(st) if r["pattern"] == "zevanory.api.br/admin*")["script"] = None
        def added(st):
            self._routes(st).append({"id": "c" * 32, "pattern": "zevanory.api.br/novo*", "script": ROUTER})
        for gha in (False, True):
            for name, fn, marker in (("removed", removed, "missing_other=1"), ("changed", changed, "changed=1"),
                                     ("unbound", unbound, "changed=1"), ("added", added, "extra=1")):
                rc, out, _, _, _ = self._snap_then(cf_state(), fn, self.verify, gha=gha)
                self.assertNotEqual(rc, 0, name)
                self.assertIn("ROUTES_VERIFY_FAIL", out, name)
                self.assertIn(marker, out, name)
                self._no_leak(out, gha)
        # Falha da API na verificação também fecha.
        rc, out, _, _, _ = self._snap_then(cf_state(), lambda st: st.update(fail={"list": "500"}), self.verify)
        self.assertNotEqual(rc, 0)
        self.assertIn("ROUTES_VERIFY_FAIL", out)

    # --- retorno: versão + rotas + provas públicas ----------------------------------------------------------
    def test_sol_case_route_outside_public_urls_removed_by_deploy_is_restored(self):
        for gha in (False, True):
            before = cf_state()
            job = Job(self.steps, cf_state(on_deploy=[["remove", "zevanory.api.br/api/*"]]), gha=gha).run()
            # O deploy em si "deu certo"; só o inventário completo vê a rota de outro script que sumiu.
            self.assertEqual(job.res["Deploy public router Worker"][0], 0)
            rc, out, _, _ = job.res["Verify full route inventory"]
            self.assertNotEqual(rc, 0)
            self.assertIn("missing_other=1", out)
            rc, out, npx, _ = job.res["Automatic rollback"]
            self.assertEqual(rc, 0, out)
            self.assertIn(f"rollback {PREV}", npx)
            self.assertIn("ROUTES_RESTORE created=1 updated=0 deleted=0 write_failed=0", out)
            self.assertIn("ROUTES_RESTORE_READBACK=PASS routes=20", out)
            self.assertIn("ROLLBACK_READBACK=PASS", out)
            self.assertEqual(job.final["active"], PREV)
            self.assertEqual(inv(job.final), inv(before), "a rota removida voltou e nada mais mudou")
            self._no_leak(out, gha)

    def test_rollback_reverts_changed_script_and_deletes_added_route(self):
        before = cf_state()
        job = Job(self.steps, cf_state(on_deploy=[["set", "edge.zevanory.api.br/*", ROUTER],
                                                  ["add", "zevanory.api.br/novo*", ROUTER],
                                                  ["remove", "zevanory.api.br/lucro-e-caixa*"]])).run()
        rc, out, _, _ = job.res["Automatic rollback"]
        self.assertEqual(rc, 0, out)
        self.assertIn("ROUTES_RESTORE created=1 updated=1 deleted=1 write_failed=0", out)
        self.assertEqual(inv(job.final), inv(before))
        self.assertEqual(job.final["active"], PREV)

    def test_restore_is_certified_by_reread_not_by_write_status(self):
        # Escritas "com sucesso" que não aplicam nada (API mentirosa) e escritas recusadas (token sem permissão).
        for name, extra in (("lying_writes", {"lie_writes": True}), ("write_403", {"fail": {"write": "403"}})):
            st = cf_state(on_deploy=[["remove", "zevanory.api.br/api/*"]], **extra)
            job = Job(self.steps, st).run()
            rc, out, _, _ = job.res["Automatic rollback"]
            self.assertNotEqual(rc, 0, name)
            self.assertIn("ROUTES_RESTORE_FAIL", out, name)
            self.assertIn("version=1 routes=0 public=1", out, name)
            self.assertIn("ROUTER_ROLLBACK_READBACK_FAIL", out, name)
            self.assertNotIn("ROLLBACK_READBACK=PASS", out, name)

    def test_rollback_repeats_the_public_readbacks(self):
        def broken(st):
            st["public"][APEX] = ["200", {}, "", APEX]
        rc, out, _, curl, _ = self._snap_then(cf_state(), broken, self.rollback,
                                              env={"PREV_VERSION_ID": PREV, "DEPLOY_ATTEMPTED": "1"})
        self.assertNotEqual(rc, 0)
        self.assertIn("version=1 routes=1 public=0", out)
        self.assertEqual(curl.count(json.dumps(APEX)), 2, "mesmas tentativas da leitura de volta")
        rc, out, _, _, _ = self._snap_then(cf_state(), lambda st: None, self.rollback,
                                           env={"PREV_VERSION_ID": PREV, "DEPLOY_ATTEMPTED": "1"})
        self.assertEqual(rc, 0, out)
        self.assertIn("ROLLBACK_READBACK=PASS", out)

    def test_restore_refuses_snapshot_or_zone_of_another_account(self):
        def tamper(st):
            st["zone_get_account"] = OTHER  # a zona da foto agora responde como de outra conta
        for script in (self.verify, self.rollback):
            rc, out, _, _, _ = self._snap_then(cf_state(on_deploy=[]), tamper, script,
                                               env={"PREV_VERSION_ID": PREV})
            self.assertNotEqual(rc, 0)
            self.assertIn("outra conta", out)
            self.assertNotIn("writes", LAST["state"])
        # Foto adulterada (conta trocada no arquivo): recusada sem nenhuma escrita.
        with tempfile.TemporaryDirectory() as d:
            run_step(self.snapshot, {}, state=cf_state(), workdir=d)
            f = Path(d) / "router-routes-before.json"
            snap = json.loads(f.read_text())
            snap["account"] = OTHER
            f.write_text(json.dumps(snap))
            st = json.loads((Path(d) / "st.json").read_text())
            st["zones"][ZONE]["routes"].pop()
            (Path(d) / "st.json").write_text(json.dumps(st))
            rc, out, _, curl, _ = run_step(self.rollback, {}, {"PREV_VERSION_ID": PREV}, workdir=d)
            self.assertNotEqual(rc, 0)
            self.assertIn("foto de outra conta", out)
            self.assertNotIn("writes", LAST["state"])
            self.assertNotIn(OTHER, curl)

    def test_clean_deploy_passes_with_no_route_writes_and_no_rollback(self):
        for gha in (False, True):
            job = Job(self.steps, cf_state(), gha=gha).run()
            for name in Job.ORDER[:-1]:
                self.assertEqual(job.res[name][0], 0, (name, job.res[name][1]))
            self.assertNotIn("Automatic rollback", job.res)
            self.assertIn("ROUTES_VERIFY=PASS", job.res["Verify full route inventory"][1])
            self.assertNotIn("writes", job.final, "o fluxo de sucesso nunca escreve rotas pela API")
            self.assertEqual(inv(job.final), inv(cf_state()))

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
