"""B02 — prova real em sandbox (girolocal.api.br): contrato offline de .github/workflows/sandbox-route-probe.yml,
sandbox/route-probe/run_route_probe.py e do modo sandbox/preflight de scripts/ops/router_routes.py.

Sem rede: `curl` e `npx` falsos no PATH simulam uma Cloudflare com ESTADO (zonas, rotas, scripts, versões e
PERMISSÕES POR TOKEN) e as respostas públicas (o host/caminho é atendido pelo script da rota mais específica). O
wrangler falso aplica o efeito documentado do `deploy` (rotas do script = toml; sem Workers Routes Write o código sobe
e as rotas falham — o perigo que a prova negativa cobre) e do `rollback` (só a versão; rotas não são versionadas).
Mutantes: scripts/ci/mutants_sandbox_route_probe.py (variáveis SANDBOX_PROBE_SCRIPT / ROUTER_ROUTES_SCRIPT /
SANDBOX_PROBE_WORKFLOW / SINGLE_RUN_GUARD apontam para cópias mutadas).
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
PROBE_SRC = Path(os.environ.get("SANDBOX_PROBE_SCRIPT", ROOT / "sandbox/route-probe/run_route_probe.py"))
ROUTES_SRC = Path(os.environ.get("ROUTER_ROUTES_SCRIPT", ROOT / "scripts/ops/router_routes.py"))
WORKFLOW = Path(os.environ.get("SANDBOX_PROBE_WORKFLOW", ROOT / ".github/workflows/sandbox-route-probe.yml"))
GUARD = Path(os.environ.get("SINGLE_RUN_GUARD", ROOT / "sandbox/rollback-secret-probe/single-run-guard.sh"))

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
ZID = "9a" * 16
PRODZ = "0f" * 16
ZONE = "girolocal.api.br"
PROBE, NEIGH = "zevanory-route-probe", "zevanory-route-neighbour"
FULL, NOR = "full-token-AAAA", "noroutes-token-BBBB"
CANARY = "FAKE_CANARY_SECRET_VALUE"
FOREIGN0 = ("other.girolocal.api.br/*", None)  # rota pré-existente, alheia à prova: tem de sobreviver intacta
BASELINE = {("probe.girolocal.api.br/*", PROBE), ("probe.girolocal.api.br/b*", PROBE),
            ("neighbour.girolocal.api.br/*", NEIGH), ("neighbour.girolocal.api.br/n*", NEIGH)}
PHRASE = "PROVA ROTAS GIROLOCAL UMA VEZ"
FULL_PERMS = ("zone_read", "routes_write", "scripts")
NOR_PERMS = ("zone_read", "routes_read")

FAKE_CF = r'''#!/usr/bin/env python3
import json, os, re, sys, tomllib
ST = %(st)r
LOG = %(log)r
API = "https://api.cloudflare.com/client/v4"
ACCOUNT = %(account)r
CANARY = %(canary)r


def load():
    return json.load(open(ST))


def save(st):
    json.dump(st, open(ST, "w"))


def perms(st, tok):
    return set(st["tokens"].get(tok, []))


def new_version(st, name, vars_):
    st["seq"] += 1
    vid = "%%08x-0000-4000-8000-%%012x" %% (st["seq"], st["seq"])
    st["scripts"].setdefault(name, {"versions": {}, "active": None})
    st["scripts"][name]["versions"][vid] = vars_
    st["scripts"][name]["active"] = vid
    return vid


def rid(st):
    st["seq"] += 1
    return "%%032x" %% (0xc0de0000 + st["seq"])


def match(pattern, host, path):
    ph, _, pp = pattern.partition("/")
    pp = "/" + pp
    if ph != host:
        return False
    return path.startswith(pp[:-1]) if pp.endswith("*") else path == pp


def serve(st, host, path):
    if st.get("no_dns"):
        return "000", ""
    routes = st.get("public_frozen") or [r for z in st["zones"].values() for r in z["routes"]]
    hits = sorted((r for r in routes if match(r["pattern"], host, path)), key=lambda r: len(r["pattern"]), reverse=True)
    if not hits or not hits[0]["script"] or hits[0]["script"] not in st["scripts"]:
        return "404", "no worker"
    sc = st["scripts"][hits[0]["script"]]
    if hits[0]["script"] == "zevanory-route-neighbour":
        return "200", "zevanory-route-neighbour\n"
    return "200", "zevanory-route-probe %%s\n" %% sc["versions"][sc["active"]].get("PROBE_VERSION", "unset")
'''

CURL_STUB = FAKE_CF + r'''
a = sys.argv[1:]
url = a[-1]
out = a[a.index("-o") + 1] if "-o" in a else None
fmt = a[a.index("-w") + 1] if "-w" in a else ""
method = a[a.index("-X") + 1] if "-X" in a else "GET"
data = json.loads(a[a.index("--data") + 1]) if "--data" in a else None
heads = [a[i + 1] for i, x in enumerate(a) if x == "-H"]
tok = next((h[len("Authorization: Bearer "):] for h in heads if h.startswith("Authorization: Bearer ")), "")
with open(LOG, "a") as f:
    f.write(json.dumps([method, url, tok]) + "\n")
st = load()


def emit(code, body):
    if out:
        open(out, "w").write(body if isinstance(body, str) else json.dumps(body))
    sys.stdout.write(fmt.replace("%%{http_code}", code))
    save(st)
    sys.exit(0)


def ok(result):
    emit("200", {"success": True, "errors": [], "messages": [], "result": result})


def deny():
    emit(st.get("deny_code", "403"), {"success": False, "errors": [{"code": 10000, "message": "Authentication error " + CANARY}]})


m = re.fullmatch(r"https://([a-z.]+)(/.*)", url)
if m and not url.startswith(API):
    code, body = serve(st, m.group(1), m.group(2))
    emit(code, body)
p = perms(st, tok)
m = re.fullmatch(re.escape(API) + r"/zones\?name=([^&]+)&account\.id=([0-9a-f]{32})", url)
if m:
    if "zone_read" not in p:
        deny()
    ok([{"id": zid, "name": st.get("zone_name_override", z["name"]), "status": z["status"], "account": {"id": z["account"]}}
        for zid, z in st["zones"].items() if z["name"] == m.group(1)])
m = re.fullmatch(re.escape(API) + r"/zones/([0-9a-f]{32})", url)
if m and m.group(1) in st["zones"]:
    if "zone_read" not in p:
        deny()
    z = st["zones"][m.group(1)]
    ok({"id": m.group(1), "name": z["name"], "status": z["status"], "account": {"id": z["account"]}})
m = re.fullmatch(re.escape(API) + r"/zones/([0-9a-f]{32})/workers/routes(?:/([0-9a-f]{32}))?", url)
if m and m.group(1) in st["zones"]:
    z, r_id = st["zones"][m.group(1)], m.group(2)
    if method == "GET":
        if not p & {"routes_read", "routes_write"}:
            deny()
        ok([{"id": r["id"], "pattern": r["pattern"], **({"script": r["script"]} if r["script"] else {})} for r in z["routes"]])
    if "routes_write" not in p and not (method == "DELETE" and "routes_delete" in p):
        deny()
    st.setdefault("writes", []).append([method, m.group(1)])
    if method in st.get("fail_methods", []):
        emit("500", {"success": False, "errors": [{"code": 10013, "message": "boom " + CANARY}]})
    if method == "POST":
        if any(r["pattern"] == data["pattern"] for r in z["routes"]):
            emit("409", {"success": False, "errors": [{"code": 10020}]})
        new = {"id": rid(st), "pattern": data["pattern"], "script": data.get("script")}
        z["routes"].append(new)
        ok(new)
    hit = [r for r in z["routes"] if r["id"] == r_id]
    if not hit:
        emit("404", {"success": False, "errors": [{"code": 10007}]})
    if method == "PUT":
        hit[0].update({"pattern": data["pattern"], "script": data.get("script")})
    elif not st.get("lie_deletes"):
        z["routes"].remove(hit[0])
    ok({"id": r_id})
m = re.fullmatch(re.escape(API) + r"/accounts/" + ACCOUNT + r"/workers/scripts/([a-z0-9-]+)(/deployments|\?force=true)", url)
if m:
    if "scripts" not in p:
        deny()
    name, what = m.groups()
    sc = st["scripts"].get(name)
    if sc is None:
        emit("404", {"success": False, "errors": [{"code": 10007, "message": "script not found"}]})
    if what == "/deployments" and method == "GET":
        if st.get("version_lag", 0) > 0 and name == "zevanory-route-probe" and st.get("lag_old"):
            st["version_lag"] -= 1
            vid = st["lag_old"]
        else:
            vid = sc["active"]
        ok({"deployments": [{"id": "d", "versions": [{"version_id": vid, "percentage": 100}]}]})
    if what == "?force=true" and method == "DELETE":
        if st.get("fail_script_delete"):
            emit("500", {"success": False, "errors": [{"code": 10013}]})
        del st["scripts"][name]
        ok(None)
emit("404", {"success": False, "errors": [{"code": 7003, "message": "no route " + CANARY}]})
'''

NPX_STUB = FAKE_CF + r'''
a = sys.argv[1:]
tok = os.environ.get("CLOUDFLARE_API_TOKEN", "")
with open(%(npxlog)r, "a") as f:
    f.write(json.dumps({"args": a, "tok": tok, "probe_vars": sorted(k for k in os.environ if k.startswith("CF_PROBE_"))}) + "\n")
st = load()
if st.get("leak"):
    print("wrangler hostil env=" + tok + " " + CANARY)
p = perms(st, tok)
if "deploy" in a:
    cfg = tomllib.load(open(a[a.index("--config") + 1], "rb"))
    if "scripts" not in p:
        print("X [ERROR] auth [code: 10000]")
        sys.exit(1)
    vars_ = dict(cfg.get("vars", {}))
    for i, x in enumerate(a):
        if x == "--var":
            k, v = a[i + 1].split(":", 1)
            vars_[k] = v
    old = (st["scripts"].get(cfg["name"]) or {}).get("active")
    new_version(st, cfg["name"], vars_)
    st.setdefault("deploys", []).append(cfg["name"])
    if "routes_write" not in p:
        save(st)  # o código JÁ subiu; só as rotas falham — o perigo coberto pela prova negativa antes do deploy
        print("X [ERROR] routes [code: 10000]")
        sys.exit(1)
    z = st["zones"][[k for k, v in st["zones"].items() if v["name"] == "girolocal.api.br"][0]]
    pats = [r["pattern"] for r in cfg["routes"]]
    z["routes"] = [r for r in z["routes"] if r["script"] != cfg["name"]]
    for pat in pats:
        if any(r["pattern"] == pat for r in z["routes"]):
            save(st)
            print("X [ERROR] taken [code: 10020]")
            sys.exit(1)
        z["routes"].append({"id": rid(st), "pattern": pat, "script": cfg["name"]})
    st["lag_old"] = old
    save(st)
    sys.exit(0)
if "rollback" in a:
    name = a[a.index("--name") + 1]
    if "scripts" not in p or name not in st["scripts"]:
        print("X [ERROR] [code: 10007]")
        sys.exit(1)
    st["lag_old"] = st["scripts"][name]["active"]
    st["scripts"][name]["active"] = a[a.index("rollback") + 1]
    st.setdefault("rollbacks", []).append(name)
    save(st)
    sys.exit(0)
sys.exit(3)
'''


WRAP = r'''import json, os, subprocess, sys
p = subprocess.run([sys.executable, %(real)r] + sys.argv[1:], capture_output=True, text=True, stdin=subprocess.DEVNULL)
out = p.stdout + p.stderr
for old, new in json.loads(os.environ.get("STUB_REWRITE", "{}")).get(sys.argv[1], []):
    out = out.replace(old, new)
after = json.loads(os.environ.get("STUB_AFTER_RESTORE", "null"))
if after and sys.argv[1] == "restore" and p.returncode == 0:
    st = json.load(open(%(st)r))
    zid = [k for k, v in st["zones"].items() if v["name"] == "girolocal.api.br"][0]
    if "add_route" in after:
        st["zones"][zid]["routes"].append({"id": "%%032x" %% 0xd1f7, "pattern": after["add_route"], "script": None})
    if "freeze_public" in after:
        st["public_frozen"] = after["freeze_public"]
    json.dump(st, open(%(st)r, "w"))
sys.stdout.write(out)
sys.exit(p.returncode)
'''


def state(**kw):
    st = {"zones": {ZID: {"name": ZONE, "account": ACCOUNT, "status": "active",
                          "routes": [{"id": "%032x" % 0xf00, "pattern": FOREIGN0[0], "script": FOREIGN0[1]}]},
                    PRODZ: {"name": "zevanory.api.br", "account": ACCOUNT, "status": "active",
                            "routes": [{"id": "%032x" % 0xa11, "pattern": "zevanory.api.br/", "script": "zevanory-public-router"}]}},
          "scripts": {}, "seq": 0,
          # Permissões MÍNIMAS (AVAL 101): completo = Workers Scripts Edit + Zone Read + Workers Routes Edit;
          # negativo = Zone Read + Workers Routes Read (sem Workers Scripts, sem Routes Edit).
          "tokens": {FULL: list(FULL_PERMS), NOR: list(NOR_PERMS)}}
    st.update(kw)
    return st


def ours(st):
    z = st["zones"][ZID]
    return {(r["pattern"], r["script"]) for r in z["routes"]}


class Box:
    """Um runner: diretório com curl/npx falsos, estado da Cloudflare falsa e logs."""

    def __init__(self, st):
        self.d = Path(tempfile.mkdtemp(prefix="srp-"))
        (self.d / "st.json").write_text(json.dumps(st))
        fmt = {"st": str(self.d / "st.json"), "log": str(self.d / "curl.log"), "npxlog": str(self.d / "npx.log"),
               "account": ACCOUNT, "canary": CANARY}
        (self.d / "curl").write_text(CURL_STUB % fmt)
        (self.d / "npx").write_text(NPX_STUB % fmt)
        for f in ("curl", "npx"):
            (self.d / f).chmod(0o755)
        # Cópia da prova que chama um invólucro do router_routes (possivelmente mutado). O invólucro roda o script
        # real e, se o teste pedir (STUB_REWRITE / STUB_AFTER_RESTORE), adultera a saída ou o estado depois dele —
        # para provar que cada checagem da prova vale sozinha.
        (self.d / "routes_wrap.py").write_text(WRAP % {"real": str(ROUTES_SRC), "st": str(self.d / "st.json")})
        src = PROBE_SRC.read_text().replace('ROUTES = "scripts/ops/router_routes.py"',
                                            f'ROUTES = {str(self.d / "routes_wrap.py")!r}')
        (self.d / "probe.py").write_text(src)

    def close(self):
        shutil.rmtree(self.d, ignore_errors=True)

    @property
    def st(self):
        return json.loads((self.d / "st.json").read_text())

    def patch(self, **kw):
        st = self.st
        st.update(kw)
        (self.d / "st.json").write_text(json.dumps(st))

    def env(self, extra=None, gha=False):
        env = {"PATH": f"{self.d}:{os.environ['PATH']}", "RUNNER_TEMP": str(self.d), "PYTHONDONTWRITEBYTECODE": "1",
               "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "CF_PROBE_TOKEN": f" {FULL}\n", "CF_PROBE_TOKEN_NO_ROUTES": NOR,
               "PROBE_ATTEMPTS": "2", "PROBE_SLEEP_SECONDS": "0", "HOME": str(self.d)}
        if gha:
            env["GITHUB_ACTIONS"] = "true"
        env.update(extra or {})
        assert shutil.which("curl", path=env["PATH"]) == str(self.d / "curl")
        return env

    def run(self, sub, extra=None, gha=False):
        p = subprocess.run([sys.executable, str(self.d / "probe.py"), sub], env=self.env(extra, gha), cwd=str(ROOT),
                           capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def routes(self, sub, path, tok=FULL, extra=None):
        env = self.env({"CLOUDFLARE_API_TOKEN": tok, "ROUTER_ACCOUNT_ID": ACCOUNT, "ROUTER_SCRIPT": PROBE,
                        "ROUTER_SANDBOX_ZONE": ZONE, "ROUTER_CONFIG": "sandbox/route-probe/wrangler.probe.toml",
                        **(extra or {})})
        env = {k: v for k, v in env.items() if v is not None}
        p = subprocess.run([sys.executable, str(ROUTES_SRC), sub, str(path)], env=env, cwd=str(ROOT),
                           capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
        return p.returncode, p.stdout + p.stderr

    def log(self, name):
        f = self.d / name
        return [json.loads(l) for l in f.read_text().splitlines()] if f.exists() else []


def box(test, st=None):
    b = Box(st or state())
    test.addCleanup(b.close)
    return b


def lines(out, prefix):
    return [l for l in out.splitlines() if l.startswith(prefix)]


class Workflow(unittest.TestCase):
    def setUp(self):
        self.doc = yaml.safe_load(WORKFLOW.read_text())
        self.text = WORKFLOW.read_text()
        self.job = self.doc["jobs"]["probe"]
        self.steps = self.job["steps"]

    def test_manual_only_own_environment_single_ref_attempt_and_phrase(self):
        on = self.doc[True]
        self.assertEqual(list(on), ["workflow_dispatch"])
        self.assertEqual(list(self.doc["jobs"]), ["probe"])
        self.assertEqual(self.job["environment"], "sandbox-route-probe")
        self.assertNotIn("producao-critica", self.text)
        self.assertNotIn("gh-pages-automacao", self.text)
        self.assertEqual(self.job["if"], "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/gh-pages' "
                                         f"&& github.run_attempt == 1 && inputs.confirmacao == '{PHRASE}'")
        self.assertEqual(self.doc["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(self.job["env"]["CLOUDFLARE_ACCOUNT_ID"], ACCOUNT)
        self.assertEqual(on["workflow_dispatch"]["inputs"]["confirmacao"]["required"], True)

    def test_secrets_scoped_guard_first_cleanup_always_after_guard(self):
        self.assertEqual(sorted(set(re.findall(r"secrets\.([A-Z_]+)", self.text))), ["CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES"])
        self.assertNotIn("secrets", json.dumps(self.job.get("env", {})))
        self.assertEqual(self.steps[0]["with"]["persist-credentials"], False)
        guard = self.steps[2]
        self.assertEqual(guard["id"], "guard")
        self.assertEqual(guard["run"], "bash sandbox/rollback-secret-probe/single-run-guard.sh sandbox-route-probe.yml")
        self.assertEqual(set(guard["env"]), {"GITHUB_TOKEN"})
        probe, cleanup = self.steps[3], self.steps[4]
        self.assertEqual(len(self.steps), 5)
        self.assertEqual(probe["run"], "python3 sandbox/route-probe/run_route_probe.py probe")
        self.assertNotIn("if", probe)
        self.assertEqual(set(probe["env"]), {"CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES"})
        self.assertEqual(cleanup["run"], "python3 sandbox/route-probe/run_route_probe.py cleanup")
        self.assertEqual(cleanup["if"], "${{ always() && steps.guard.outcome == 'success' }}")
        self.assertEqual(set(cleanup["env"]), {"CF_PROBE_TOKEN"}, "cleanup nunca recebe o token negativo")
        # Permissões mínimas documentadas no workflow (AVAL 101).
        for want in ("Account > Workers Scripts > Edit (só a conta ZEVANORY) + Zone > Zone > Read +",
                     "Zone > Workers Routes > Edit (só girolocal.api.br)",
                     "CF_PROBE_TOKEN_NO_ROUTES  Zone > Zone > Read + Zone > Workers Routes > Read (só girolocal.api.br)",
                     "TTL <= 24h", "NEGATIVE_TOKEN_READ_DENIED_MISCONFIGURED"):
            self.assertIn(want, self.text)

    def guard(self, workflow, runs):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            body = d / "runs.json"
            body.write_text(json.dumps({"total_count": len(runs), "workflow_runs": [{"id": r} for r in runs]}))
            (d / "curl").write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > {d}/url\nwhile [ $# -gt 0 ]; do [ \"$1\" = --output ] && cp {body} \"$2\"; shift; done\nprintf 200\n")
            (d / "curl").chmod(0o755)
            env = {**os.environ, "CURL_BIN": str(d / "curl"), "PYTHON_BIN": sys.executable,
                   "GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "100"}
            p = subprocess.run(["bash", str(GUARD), workflow], env=env, text=True, capture_output=True,
                               stdin=subprocess.DEVNULL, timeout=30)
            return p, (d / "url").read_text() if (d / "url").exists() else ""

    def test_single_run_guard_quota_zero(self):
        p, url = self.guard("sandbox-route-probe.yml", [100])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("/actions/workflows/sandbox-route-probe.yml/runs", url)
        self.assertIn("SINGLE_RUN_GUARD=PASS prior_runs=0", p.stdout)
        p, _ = self.guard("sandbox-route-probe.yml", [100, 99])
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SINGLE_RUN_GUARD_REFUSED prior_runs=1 allowed=0", p.stderr)
        p, _ = self.guard("public-router-deploy.yml", [100])
        self.assertIn("SINGLE_RUN_GUARD_WORKFLOW_REFUSED", p.stderr)

    def test_probe_configs_only_target_the_sandbox_zone(self):
        import tomllib
        for name, script in (("wrangler.probe.toml", PROBE), ("wrangler.neighbour.toml", NEIGH)):
            cfg = tomllib.loads((ROOT / "sandbox/route-probe" / name).read_text())
            self.assertEqual((cfg["name"], cfg["account_id"], cfg["workers_dev"]), (script, ACCOUNT, False))
            self.assertEqual({r["zone_name"] for r in cfg["routes"]}, {ZONE})
            self.assertTrue(all(r["pattern"].split("/")[0].endswith("." + ZONE) for r in cfg["routes"]))
            self.assertNotIn("zevanory.api.br", (ROOT / "sandbox/route-probe" / name).read_text())
        self.assertEqual({(r[0], r[1]) for r in BASELINE}, BASELINE)


class Probe(unittest.TestCase):
    def test_full_probe_passes_with_exact_counts_and_restores_everything(self):
        b = box(self)
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 0, out)
        for want in ("PROBE_GUARD=PASS zone=active foreign_routes_in_zone=1",
                     "PROBE_SETUP=PASS routes=4 rollback_point=recorded",
                     "ROUTES_SNAPSHOT=PASS zones=1 routes=5 router_routes=2 expected_patterns=2 ",
                     "ROUTES_PREFLIGHT=PASS write_probe=1 zones=1",
                     "NEG_PREDEPLOY=PASS read=200 write=403 wrangler_calls=0 version=unchanged routes=unchanged",
                     "MUTATION_TRIPLE=APPLIED changed=1 removed=1 added=1",
                     "VERIFY_DETECTS_TRIPLE=PASS missing_expected=1 missing_other=0 changed=1 extra=1",
                     "NEG_RESTORE=PASS read=200 write=403 write_failed=3 divergent=3",
                     "ROUTES_RESTORE created=1 updated=1 deleted=1 write_failed=0",
                     "ROUTES_RESTORE_READBACK=PASS routes=5",
                     "INVENTORY_EQUALS_SNAPSHOT=PASS routes=5 version=rollback_point",
                     "ROUTES_VERIFY=PASS checked=5 expected_patterns=2 missing_expected=0 missing_other=0 changed=0 extra=0",
                     "ROUTE_PROBE_RESULT=PASS"):
            # A foto aparece 2x: token completo e token negativo (que LÊ rotas e só falha na prova de escrita).
            n = 2 if want.startswith("ROUTES_SNAPSHOT=PASS") else 1
            self.assertEqual(len([l for l in out.splitlines() if l.startswith(want)]), n, want + "\n" + out)
        self.assertRegex(out, r"(?m)^WRONG_ROUTING_WINDOW_SECONDS=\d+\.\d first_public_observation_s=\d+\.\d "
                              r"restore_to_inventory_s=\d+\.\d restore_to_public_s=\d+\.\d$")
        self.assertIn("PUBLIC mutated neighbour:/n http=200 serves=probe-v2", out)
        self.assertIn("PUBLIC mutated neighbour:/x http=200 serves=probe-v2", out)
        self.assertIn("PUBLIC restored neighbour:/x http=200 serves=neighbour", out)
        self.assertIn("PUBLIC restored probe:/ http=200 serves=probe-v1", out)
        # Falhas ESPERADAS não viram anotação de erro do run; nenhuma linha ::error.
        self.assertNotIn("::error", out)
        self.assertEqual(len(lines(out, "EXPECTED ROUTES_")), 3, out)
        st = b.st
        self.assertEqual(ours(st), BASELINE | {FOREIGN0})
        self.assertEqual(st["deploys"], [NEIGH, PROBE, PROBE])
        self.assertEqual(st["rollbacks"], [PROBE])
        v1 = [v for v, vars_ in st["scripts"][PROBE]["versions"].items() if vars_["PROBE_VERSION"] == "v1"]
        self.assertEqual([st["scripts"][PROBE]["active"]], v1)
        # Produção intocada: nenhuma chamada à zona zevanory.api.br, nenhuma escrita fora da zona sandbox.
        calls = b.log("curl.log")
        self.assertFalse([c for c in calls if PRODZ in c[1] or "zevanory.api.br" in c[1]])
        self.assertEqual({w[1] for w in st["writes"]}, {ZID})
        # Escritas de rota: preflight(1 PUT) + preflight negativo(1, recusado) + mutação(3) + restore negativo(3,
        # recusadas) + restore(3). As 4 do token negativo voltaram 403 (st["writes"] só registra as aceitas).
        writes = [c for c in calls if c[0] in ("PUT", "POST", "DELETE") and "/workers/routes" in c[1]]
        self.assertEqual(len(writes), 11)
        self.assertEqual(len([c for c in writes if c[2] == NOR]), 4)
        self.assertEqual(len(st["writes"]), 7)

    def test_negative_token_never_reaches_wrangler_and_no_secret_is_printed(self):
        b = box(self, state(leak=True))
        rc, out = b.run("probe")
        self.assertEqual(rc, 0, out)
        npx = b.log("npx.log")
        self.assertEqual(len(npx), 4)
        self.assertEqual({n["tok"] for n in npx}, {FULL})
        self.assertEqual([n["probe_vars"] for n in npx], [[]] * 4, "variáveis dos tokens da prova nunca chegam ao wrangler")
        for secret in (FULL, NOR, CANARY, ZID, "Bearer"):
            self.assertNotIn(secret, out)
        self.assertEqual(lines(out, "WRANGLER deploy-probe-v2"), ["WRANGLER deploy-probe-v2 rc=0 codes=none"])

    def test_read_only_negative_token_read_ok_write_403_passes(self):
        # Só Zone Read + Workers Routes Read: leitura OK e escrita 403 nos dois estágios = prova negativa válida.
        b = box(self)
        self.assertEqual(sorted(b.st["tokens"][NOR]), ["routes_read", "zone_read"])
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 0, out)
        self.assertIn("NEG_PREDEPLOY=PASS read=200 write=403 wrangler_calls=0", out)
        self.assertIn("NEG_RESTORE=PASS read=200 write=403 write_failed=3 divergent=3", out)
        neg = [c for c in b.log("curl.log") if c[2] == NOR]
        self.assertFalse([c for c in neg if "/workers/scripts/" in c[1]], "token negativo nunca toca Workers Scripts")
        reads = [c for c in neg if c[0] == "GET" and c[1].endswith("/workers/routes")]
        self.assertEqual(len(reads), 4, "snapshot + preflight + restore (leitura + releitura)")
        self.assertEqual([c[0] for c in neg if c[0] != "GET"], ["PUT", "DELETE", "PUT", "POST"])

    def test_negative_token_read_403_is_misconfiguration_not_negative_evidence(self):
        # Leitura 403 no snapshot (antes do deploy): falha com erro próprio, nunca NEG_PREDEPLOY=PASS.
        b = box(self, state(tokens={FULL: list(FULL_PERMS), NOR: ["zone_read"]}))
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 1, out)
        self.assertIn("::error title=NEGATIVE_TOKEN_READ_DENIED_MISCONFIGURED::token negativo sem leitura no estágio "
                      "snapshot (http=200,403)", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-predeploy", out)
        self.assertNotIn("NEG_PREDEPLOY=PASS", out)
        self.assertNotIn("ROUTE_PROBE_RESULT=PASS", out)
        self.assertEqual(b.st["deploys"], [NEIGH, PROBE], "o deploy v2 nunca acontece")
        # Zona ilegível para o token negativo (sem Zone Read) também é má configuração.
        b = box(self, state(tokens={FULL: list(FULL_PERMS), NOR: ["routes_read"]}))
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 1, out)
        self.assertIn("::error title=NEGATIVE_TOKEN_READ_DENIED_MISCONFIGURED::", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-predeploy", out)
        # Leitura 403 no restore negativo (permissão perdida depois do deploy v2): idem, nunca NEG_RESTORE=PASS.
        b = box(self)
        npx = (b.d / "npx").read_text().replace(
            'st["lag_old"] = old\n',
            'st["lag_old"] = old\n    if vars_.get("PROBE_VERSION") == "v2": st["tokens"][%r] = ["zone_read"]\n' % NOR)
        (b.d / "npx").write_text(npx)
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 1, out)
        self.assertIn("NEG_PREDEPLOY=PASS read=200 write=403", out)
        self.assertIn("::error title=NEGATIVE_TOKEN_READ_DENIED_MISCONFIGURED::token negativo sem leitura no estágio "
                      "restore", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-restore", out)
        self.assertNotIn("NEG_RESTORE=PASS", out)

    def test_negative_token_that_can_write_routes_fails_the_probe_before_any_deploy(self):
        # Leitura OK + escrita 200: token largo demais -> falha, nunca PASS.
        b = box(self, state(tokens={FULL: list(FULL_PERMS), NOR: ["zone_read", "routes_read", "routes_write"]}))
        rc, out = b.run("probe", gha=True)
        self.assertEqual(rc, 1, out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-predeploy", out)
        self.assertIn("::error title=NEGATIVE_TOKEN_TOO_BROAD::token sem Workers Routes Write passou preflight", out)
        self.assertNotIn("NEG_PREDEPLOY=PASS", out)
        self.assertEqual(b.st["deploys"], [NEIGH, PROBE], "o deploy v2 nunca acontece")

    def test_negative_restore_write_denied_without_403_fails(self):
        # Leitura OK, escritas recusadas com 500 (não 403) no restore negativo: a zona segue divergente, mas não é prova.
        b = box(self)
        npx = (b.d / "npx").read_text().replace(
            'st["lag_old"] = old\n', 'st["lag_old"] = old\n    if vars_.get("PROBE_VERSION") == "v2": st["deny_code"] = "500"\n')
        (b.d / "npx").write_text(npx)
        rc, out = b.run("probe")
        self.assertEqual(rc, 1, out)
        self.assertIn("falha sem 403 no estágio restore (http=200,500)", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-restore", out)
        self.assertNotIn("NEG_RESTORE=PASS", out)

    def test_negative_failure_must_be_a_403(self):
        b = box(self, state(deny_code="500"))
        rc, out = b.run("probe")
        self.assertEqual(rc, 1, out)
        self.assertIn("falha sem 403 no estágio preflight (http=200,500)", out)
        self.assertEqual(b.st["deploys"], [NEIGH, PROBE])

    def test_negative_restore_that_partially_writes_fails_the_probe(self):
        b = box(self, state(tokens={FULL: list(FULL_PERMS), NOR: ["zone_read", "routes_read", "routes_delete"]}))
        rc, out = b.run("probe")
        self.assertEqual(rc, 1, out)
        self.assertIn("zona deveria seguir divergente em 3 rotas, está em 2", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=negative-restore", out)

    def test_each_certification_check_holds_on_its_own(self):
        mutated = [{"pattern": p, "script": s} for p, s in BASELINE if p != "probe.girolocal.api.br/b*"] + \
                  [{"pattern": "neighbour.girolocal.api.br/x*", "script": PROBE}]
        mutated = [dict(r, script=PROBE) if r["pattern"] == "neighbour.girolocal.api.br/n*" else r for r in mutated]
        cases = {
            "verify counts": ({"STUB_REWRITE": json.dumps({"verify": [["changed=1 extra=1", "changed=1 extra=2"]]})},
                              "verify não acusou exatamente a mutação tripla", "mutation"),
            "restore counts": ({"STUB_REWRITE": json.dumps({"restore": [["deleted=1 write_failed=0", "deleted=0 write_failed=0"]]})},
                               "restore não fez exatamente 1 criação", "rollback"),
            "inventory re-read": ({"STUB_AFTER_RESTORE": json.dumps({"add_route": "late.girolocal.api.br/*"})},
                                  "releitura do inventário diferente da foto", "rollback"),
            "public restored": ({"STUB_AFTER_RESTORE": json.dumps({"freeze_public": mutated})},
                                "provas públicas não voltaram à linha de base", "rollback"),
        }
        for name, (env, msg, stage) in cases.items():
            b = box(self)
            rc, out = b.run("probe", env)
            self.assertEqual(rc, 1, name)
            self.assertIn(msg, out, name)
            self.assertIn(f"ROUTE_PROBE_RESULT=FAIL stage={stage}", out, name)

    def test_guard_refusals_happen_before_any_resource_is_created(self):
        cases = {
            "same token": ({"CF_PROBE_TOKEN_NO_ROUTES": FULL}, {}, "os dois tokens são iguais", 0),
            "wrong account": ({"CLOUDFLARE_ACCOUNT_ID": "e3caca88f4343c3cdfcf66eebe6ac124"}, {}, "conta canônica", 0),
            "missing negative token": ({"CF_PROBE_TOKEN_NO_ROUTES": " "}, {}, "CF_PROBE_TOKEN_NO_ROUTES ausente", 0),
            "bad attempts": ({"PROBE_ATTEMPTS": "0"}, {}, "inválidos", 0),
            "zone pending": ({}, {"status": "pending"}, "ainda não está ativa", 1),
            "zone renamed": ({}, {"zone_name_override": "zevanory.api.br"}, "não é a zona sandbox", 1),
        }
        for name, (env, zone, msg, ncalls) in cases.items():
            st = state()
            if "status" in zone:
                st["zones"][ZID]["status"] = zone["status"]
            st.update({k: v for k, v in zone.items() if k != "status"})
            b = box(self, st)
            rc, out = b.run("probe", env)
            self.assertEqual(rc, 1, name)
            self.assertIn(msg, out, name)
            self.assertEqual(len(b.log("curl.log")), ncalls, name)
            self.assertEqual(b.log("npx.log"), [], name)

    def test_dirty_environment_is_refused_without_deploying(self):
        for dirty in ("route", "script"):
            st = state()
            if dirty == "route":
                st["zones"][ZID]["routes"].append({"id": "%032x" % 0xbad, "pattern": "neighbour.girolocal.api.br/q*", "script": None})
            else:
                st["scripts"][PROBE] = {"versions": {}, "active": None}
            b = box(self, st)
            rc, out = b.run("probe")
            self.assertEqual(rc, 1, dirty)
            self.assertIn("ambiente não está limpo", out)
            self.assertEqual(b.log("npx.log"), [], dirty)

    def test_rollback_readback_retries_are_limited(self):
        # A versão demora 1 leitura a refletir o rollback: 2 tentativas bastam, 1 não (limite respeitado).
        for attempts, rc_want in (("2", 0), ("1", 1)):
            b = box(self)
            npx = (b.d / "npx").read_text().replace('st.setdefault("rollbacks", []).append(name)',
                                                    'st.setdefault("rollbacks", []).append(name); st["version_lag"] = 1')
            (b.d / "npx").write_text(npx)
            rc, out = b.run("probe", {"PROBE_ATTEMPTS": attempts})
            self.assertEqual(rc, rc_want, out)
            if rc_want:
                self.assertIn("versão ativa diferente do ponto de retorno", out)
                self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=rollback", out)

    def test_failed_restore_fails_the_probe_and_cleanup_still_removes_everything(self):
        b = box(self)
        npx = (b.d / "npx").read_text().replace('st.setdefault("rollbacks", []).append(name)',
                                                'st.setdefault("rollbacks", []).append(name); st["fail_methods"] = ["POST"]')
        (b.d / "npx").write_text(npx)
        rc, out = b.run("probe")
        self.assertEqual(rc, 1, out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=rollback", out)
        b.patch(fail_methods=[])
        rc, out = b.run("cleanup")
        self.assertEqual(rc, 0, out)
        self.assertEqual(ours(b.st), {FOREIGN0})
        self.assertEqual(b.st["scripts"], {})

    def test_public_baseline_and_wrong_routing_must_be_observed(self):
        b = box(self, state(no_dns=True))
        rc, out = b.run("probe")
        self.assertEqual(rc, 1)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=setup", out)
        self.assertIn("registros DNS proxied", out)
        self.assertNotIn("ROUTES_SNAPSHOT", out)
        # Público "congelado" na linha de base: a mutação não aparece -> prova inconclusiva, não PASS.
        b = box(self)
        frozen = [{"pattern": p, "script": s} for p, s in BASELINE]
        npx = (b.d / "npx").read_text().replace('st["lag_old"] = old\n', 'st["lag_old"] = old\n    if vars_.get("PROBE_VERSION") == "v2": st["public_frozen"] = %r\n' % frozen)
        (b.d / "npx").write_text(npx)
        rc, out = b.run("probe")
        self.assertEqual(rc, 1, out)
        self.assertIn("roteamento errado não observado em público", out)
        self.assertIn("ROUTE_PROBE_RESULT=FAIL stage=mutation", out)

    def test_cleanup_deletes_only_probe_resources_and_rereads_zero_leftovers(self):
        b = box(self)
        rc, out = b.run("probe")
        self.assertEqual(rc, 0, out)
        n = len(b.log("curl.log"))
        rc, out = b.run("cleanup", gha=True)
        self.assertEqual(rc, 0, out)
        self.assertIn("ROUTE_PROBE_CLEANUP routes_deleted=4 scripts_deleted=2 failed=0 leftover=0", out)
        self.assertEqual(ours(b.st), {FOREIGN0})
        self.assertEqual(b.st["scripts"], {})
        self.assertEqual(len(b.st["zones"][PRODZ]["routes"]), 1)
        self.assertEqual({c[2] for c in b.log("curl.log")[n:]}, {FULL}, "cleanup só usa o token completo")
        rc, out = b.run("cleanup")
        self.assertEqual(rc, 0, out)
        self.assertIn("routes_deleted=0 scripts_deleted=0 failed=0 leftover=0", out)
        b = box(self)
        b.run("probe")
        b.patch(fail_script_delete=True)
        rc, out = b.run("cleanup")
        self.assertEqual(rc, 1)
        self.assertIn("leftover=2", out)
        # API que responde 200 ao DELETE sem apagar: só a releitura acusa (failed=0, leftover=4).
        b = box(self)
        b.run("probe")
        b.patch(lie_deletes=True)
        rc, out = b.run("cleanup")
        self.assertEqual(rc, 1)
        self.assertIn("routes_deleted=4 scripts_deleted=2 failed=0 leftover=4", out)

    def test_probe_api_scope_refuses_production_and_other_scripts(self):
        spec = importlib.util.spec_from_file_location("srp_probe", PROBE_SRC)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        api = "https://api.cloudflare.com/client/v4"
        m.STATE["zid"] = ZID
        self.assertTrue(m.allowed(f"{api}/zones?name=girolocal.api.br&account.id={ACCOUNT}"))
        self.assertTrue(m.allowed(f"{api}/zones/{ZID}/workers/routes"))
        self.assertTrue(m.allowed(f"{api}/accounts/{ACCOUNT}/workers/scripts/{PROBE}/deployments"))
        self.assertTrue(m.allowed(f"{api}/accounts/{ACCOUNT}/workers/scripts/{NEIGH}?force=true"))
        for bad in (f"{api}/zones?name=zevanory.api.br&account.id={ACCOUNT}", f"{api}/zones/{PRODZ}/workers/routes",
                    f"{api}/accounts/{ACCOUNT}/workers/scripts/zevanory-public-router?force=true",
                    f"{api}/accounts/e3caca88f4343c3cdfcf66eebe6ac124/workers/scripts/{PROBE}/deployments",
                    f"{api}/zones/{ZID}/dns_records", "https://zevanory.api.br/"):
            self.assertFalse(m.allowed(bad), bad)
        self.assertEqual((m.ZONE, m.PROBE, m.NEIGHBOUR), (ZONE, PROBE, NEIGH))
        with self.assertRaises(m.Fail):
            m.public("zevanory.api.br", "/")


class RouterRoutesSandbox(unittest.TestCase):
    def test_each_production_refusal_layer_holds_on_its_own(self):
        spec = importlib.util.spec_from_file_location("srp_routes", ROUTES_SRC)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.SANDBOX = ZONE
        api = "https://api.cloudflare.com/client/v4"
        with self.assertRaises(m.Fail):  # busca de zona: só a zona sandbox
            m.call("t", "GET", f"{api}/zones?name=zevanory.api.br&account.id={ACCOUNT}")
        self.assertEqual(m.CODES, [], "recusa antes do curl")
        with self.assertRaises(m.Fail):  # resposta de zona: só a zona sandbox
            m.check_zone({"id": PRODZ, "name": "zevanory.api.br", "account": {"id": ACCOUNT}}, "zevanory.api.br")
        self.assertEqual(m.check_zone({"id": ZID, "name": ZONE, "account": {"id": ACCOUNT}}, ZONE), ZID)
        self.assertEqual(m.zone_candidates("a.b.girolocal.api.br/*", None), [ZONE])
        self.assertTrue(m.in_production_zone("x.ZEVANORY.api.br."))
        self.assertFalse(m.in_production_zone(ZONE))
        m.SANDBOX = None  # produção inalterada
        self.assertEqual(m.check_zone({"id": PRODZ, "name": "zevanory.api.br", "account": {"id": ACCOUNT}}, "zevanory.api.br"), PRODZ)

    def test_production_zone_and_bad_sandbox_settings_are_refused_without_network(self):
        cases = {
            "prod zone": ({"ROUTER_SANDBOX_ZONE": "zevanory.api.br"}, "zona de produção recusada"),
            "prod subdomain": ({"ROUTER_SANDBOX_ZONE": "x.zevanory.api.br"}, "zona de produção recusada"),
            "prod upper": ({"ROUTER_SANDBOX_ZONE": "ZEVANORY.API.BR"}, "zona de produção recusada"),
            "unlisted zone": ({"ROUTER_SANDBOX_ZONE": "example.com"}, "zona fora da lista sandbox"),
            "prod config": ({"ROUTER_CONFIG": "wrangler.public-router.toml"}, "config fora de sandbox/route-probe/"),
            "traversal": ({"ROUTER_CONFIG": "sandbox/route-probe/../../wrangler.public-router.toml"}, "config fora de sandbox/route-probe/"),
            "zone alone": ({"ROUTER_CONFIG": None}, "só valem juntos"),
            "config alone": ({"ROUTER_SANDBOX_ZONE": None}, "só valem juntos"),
        }
        for name, (env, msg) in cases.items():
            b = box(self)
            for sub in ("snapshot", "preflight", "restore"):
                rc, out = b.routes(sub, b.d / "s.json", extra=env)
                self.assertEqual(rc, 1, name)
                self.assertIn(msg, out, name)
                self.assertIn("http=none", out, name)
            self.assertEqual(b.log("curl.log"), [], name)

    def test_sandbox_config_with_a_production_pattern_is_refused(self):
        rel = f"sandbox/route-probe/zz-test-bad-{os.getpid()}.toml"  # nome por processo: mutantes rodam em paralelo
        bad = ROOT / rel
        self.addCleanup(bad.unlink, missing_ok=True)
        for routes in ('[{ pattern = "zevanory.api.br/*", zone_name = "girolocal.api.br" }]',
                       '[{ pattern = "probe.girolocal.api.br/*", zone_name = "zevanory.api.br" }]',
                       '["probe.zevanory.api.br.girolocal.api.br/*"]', '["probe.example.com/*"]'):
            bad.write_text(f'name = "zevanory-route-probe"\naccount_id = "{ACCOUNT}"\nroutes = {routes}\n')
            b = box(self)
            rc, out = b.routes("snapshot", b.d / "s.json", extra={"ROUTER_CONFIG": rel})
            self.assertEqual(rc, 1, routes)
            self.assertIn("padrão fora da zona sandbox", out, routes)
            self.assertEqual(b.log("curl.log"), [], routes)

    def test_snapshot_of_production_or_of_another_mode_is_refused_before_any_write(self):
        b = box(self)
        rc, out = b.routes("snapshot", b.d / "s.json")
        self.assertEqual(rc, 0, out)
        good = json.loads((b.d / "s.json").read_text())
        self.assertEqual(good["sandbox_zone"], ZONE)
        tampered = {
            "zone renamed": dict(good, zones={PRODZ: dict(list(good["zones"].values())[0], name="zevanory.api.br")}),
            "production snapshot": {k: v for k, v in good.items() if k != "sandbox_zone"},
            "other sandbox": dict(good, sandbox_zone="zevanory.api.br"),
        }
        for name, snap in tampered.items():
            (b.d / "t.json").write_text(json.dumps(snap))
            n = len(b.log("curl.log"))
            for sub in ("restore", "preflight", "verify"):
                rc, out = b.routes(sub, b.d / "t.json")
                self.assertEqual(rc, 1, name)
            self.assertEqual(len(b.log("curl.log")), n, f"{name}: nenhuma chamada")
        # E o modo produção recusa a foto sandbox.
        rc, out = b.routes("restore", b.d / "s.json", extra={"ROUTER_SANDBOX_ZONE": None, "ROUTER_CONFIG": None,
                                                             "ROUTER_SCRIPT": PROBE})
        self.assertEqual(rc, 1)
        self.assertIn("foto de outro modo", out)

    def test_zone_lookup_answering_another_zone_is_refused(self):
        b = box(self, state(zone_name_override="zevanory.api.br"))
        rc, out = b.routes("snapshot", b.d / "s.json")
        self.assertEqual(rc, 1)
        self.assertFalse([c for c in b.log("curl.log") if "/workers/routes" in c[1]])
        self.assertTrue(all("name=girolocal.api.br&" in c[1] for c in b.log("curl.log")))

    def test_preflight_proves_route_write_with_one_idempotent_put(self):
        st = state()
        st["zones"][ZID]["routes"] += [{"id": "%032x" % (0xe00 + i), "pattern": p, "script": s}
                                       for i, (p, s) in enumerate(sorted(BASELINE, key=str))]
        b = box(self, st)
        rc, out = b.routes("snapshot", b.d / "s.json")
        self.assertEqual(rc, 0, out)
        before = ours(b.st)
        rc, out = b.routes("preflight", b.d / "s.json")
        self.assertEqual(rc, 0, out)
        self.assertIn("ROUTES_PREFLIGHT=PASS write_probe=1 zones=1", out)
        self.assertEqual(b.st["writes"], [["PUT", ZID]])
        self.assertEqual(ours(b.st), before)
        rc, out = b.routes("preflight", b.d / "s.json", tok=NOR)
        self.assertEqual(rc, 1)
        self.assertIn("token sem escrita de rotas (PUT http=403)", out)
        self.assertEqual(ours(b.st), before)
        # Zona divergente da foto: recusa antes de escrever.
        b.patch(zones=dict(b.st["zones"], **{ZID: dict(b.st["zones"][ZID], routes=b.st["zones"][ZID]["routes"][:-1])}))
        rc, out = b.routes("preflight", b.d / "s.json")
        self.assertEqual(rc, 1)
        self.assertIn("zona diverge da foto", out)
        self.assertEqual(len(b.st["writes"]), 1)
        # Sem rota do próprio script não há como provar escrita: recusa.
        b2 = box(self)
        rc, out = b2.routes("snapshot", b2.d / "s.json")
        self.assertEqual(rc, 0, out)
        rc, out = b2.routes("preflight", b2.d / "s.json")
        self.assertEqual(rc, 1)
        self.assertIn("nenhuma rota do script", out)


if __name__ == "__main__":
    unittest.main()
