#!/usr/bin/env python3
"""Mutantes B02 sandbox (sandbox-route-probe): cada mutante altera uma CÓPIA temporária da prova, do router_routes, do
workflow ou do guard, roda tests/test_sandbox_route_probe.py contra ela e o original nunca é modificado.
Imprime `MUTANT <id> KILLED|SURVIVED` e sai != 0 se algum sobreviver ou se a suíte sem mutação falhar.
Uso: python3 scripts/ci/mutants_sandbox_route_probe.py [raiz-do-repo]
"""
import os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
P = (REPO / "sandbox/route-probe/run_route_probe.py").read_text()
S = (REPO / "scripts/ops/router_routes.py").read_text()
W = (REPO / ".github/workflows/sandbox-route-probe.yml").read_text()
G = (REPO / "sandbox/rollback-secret-probe/single-run-guard.sh").read_text()
TARGET = {"P": ("SANDBOX_PROBE_SCRIPT", "run_route_probe.py", P), "S": ("ROUTER_ROUTES_SCRIPT", "router_routes.py", S),
          "W": ("SANDBOX_PROBE_WORKFLOW", "wf.yml", W), "G": ("SINGLE_RUN_GUARD", "guard.sh", G)}


def sub(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new, 1)


M = {
    # --- prova (run_route_probe.py) ---
    "P1 same token accepted": ("P", 'if full == noroutes:', 'if False:'),
    "P2 negative pre-deploy pass tolerated": ("P", 'if rc == 0:\n            raise Fail("token sem Workers Routes Write', 'if False:\n            raise Fail("token sem Workers Routes Write'),
    "P3 negative pre-deploy without 403": ("P", 'if "403" not in http:\n            raise Fail(f"falha sem 403', 'if False:\n            raise Fail(f"falha sem 403'),
    "P4 negative pre-deploy runs only snapshot": ("P", 'if rc == 0:\n            where = "preflight"', 'if False:\n            where = "preflight"'),
    "P5 verify counts not required": ("P", 'if rc == 0 or "missing_expected=1 missing_other=0 changed=1 extra=1" not in out:', 'if rc == 0:'),
    "P6 negative restore divergence not checked": ("P", 'if divergent != 3:', 'if False:'),
    "P7 restore exact counts not required": ("P", 'if rc != 0 or "ROUTES_RESTORE created=1 updated=1 deleted=1 write_failed=0" not in out \\', 'if rc != 0 \\'),
    "P8 inventory equality not required": ("P", 'lambda: as_set(inventory(full)) == target', 'lambda: True'),
    "P9 rollback version not checked": ("P", 'lambda: active_version(full) == prev', 'lambda: True'),
    "P10 public restore not required": ("P", 'raise Fail("provas públicas não voltaram à linha de base")', 'pass'),
    "P11 wrangler output printed": ("P", 'say(f"WRANGLER {label} rc={p.returncode} codes={codes}")', 'say(text); say(f"WRANGLER {label} rc={p.returncode} codes={codes}")'),
    "P12 negative token used for the v2 deploy": ("P", 'wrangler(full, ["deploy", "--config", PROBE_CFG, "--var", "PROBE_VERSION:v2"', 'wrangler(noroutes, ["deploy", "--config", PROBE_CFG, "--var", "PROBE_VERSION:v2"'),
    "P13 API scope allows any zone id": ("P", 'if zid and re.fullmatch(re.escape(f"{API}/zones/{zid}")', 'if re.fullmatch(f"{API}/zones/[0-9a-f]{{32}}"'),
    "P14 cleanup keeps the Workers": ("P", 'ok, code, _ = api(full, "DELETE", f"{API}/accounts/{ACCOUNT}/workers/scripts/{s}?force=true")', 'ok, code = False, "404"'),
    "P15 cleanup ignores leftovers": ("P", 'if left or failed:', 'if failed:'),
    "P16 zone activation not checked": ("P", 'if z.get("status") != "active":', 'if False:'),
    "P17 dirty environment accepted": ("P", 'raise Fail("ambiente não está limpo', 'say("ambiente não está limpo'),
    "P18 expected failures annotated as errors": ("P", 'elif not expect_ok and line.startswith("::error title="):', 'elif False:'),
    "P19 wrong routing not required in public": ("P", 'raise Fail("roteamento errado não observado em público — prova inconclusiva")', 'pass'),
    "P20 readback ignores attempts (single try)": ("P", 'for i in range(attempts):', 'for i in range(1):'),
    "P21 API scope allows other scripts": ("P", '+ f"({PROBE}|{NEIGHBOUR})"', '+ "[a-z0-9-]+"'),
    "P22 probe token variables leak into the wrangler env": ("P", 'env = {k: v for k, v in os.environ.items() if k not in ("CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES")}\n    env.update({"CLOUDFLARE_API_TOKEN": full,', 'env = dict(os.environ)\n    env.update({"CLOUDFLARE_API_TOKEN": full,'),
    # --- router_routes.py (modo sandbox e preflight) ---
    "S1 production zone not recognized": ("S", 'return PRODUCTION_ZONE in name', 'return False'),
    "S2 sandbox zone list not enforced": ("S", 'if zone not in SANDBOX_ZONES:', 'if False:'),
    "S3 sandbox config dir not enforced": ("S", 'if ".." in cfg or not re.fullmatch(', 'if False and re.fullmatch('),
    "S4 sandbox patterns not checked": ("S", 'raise Fail("padrão fora da zona sandbox — recusado")', 'pass'),
    "S5 zone answer not checked in sandbox": ("S", 'if SANDBOX and (name != SANDBOX or in_production_zone(z.get("name"))):', 'if False:'),
    "S6 snapshot mode not checked": ("S", 'if snap.get("sandbox_zone") != SANDBOX:', 'if False:'),
    "S7 preflight trusts without PUT": ("S", 'ok, code, _ = call(tok, "PUT", f"{API}/zones/{zid}/workers/routes/{live[pat][\'id\']}",', 'ok, code, _ = True, "200", (tok, "PUT", f"{API}/zones/{zid}/workers/routes/{live[pat][\'id\']}",'),
    "S8 preflight skips divergence check": ("S", 'raise Fail("zona diverge da foto antes da prova de escrita")', 'pass'),
    "S9 sandbox zone query not restricted": ("S", 'if SANDBOX and "?" in url and not url.startswith(f"{API}/zones?name={SANDBOX}&"):', 'if False:'),
    "S10 half sandbox settings accepted": ("S", 'if not zone or not cfg:\n        raise Fail(', 'if False:\n        raise Fail('),
    "S11 snapshot zone names not checked": ("S", 'if SANDBOX and any(not isinstance(z, dict) or z.get("name") != SANDBOX', 'if False and any(not isinstance(z, dict) or z.get("name") != SANDBOX'),
    "S12 preflight passes with no own route": ("S", 'if not probed:\n        raise Fail("nenhuma rota do script', 'if False:\n        raise Fail("nenhuma rota do script'),
    # --- workflow e guard ---
    "W1 production environment": ("W", 'environment: sandbox-route-probe', 'environment: producao-critica'),
    "W2 cleanup not always": ("W", "if: ${{ always() && steps.guard.outcome == 'success' }}", "if: ${{ steps.guard.outcome == 'success' }}"),
    "W3 push trigger added": ("W", 'on:\n  workflow_dispatch:', 'on:\n  push:\n    branches: [gh-pages]\n  workflow_dispatch:'),
    "W4 guard bypassed": ("W", 'run: bash sandbox/rollback-secret-probe/single-run-guard.sh sandbox-route-probe.yml', 'run: "true"'),
    "W5 phrase not required": ("W", " && inputs.confirmacao == 'PROVA ROTAS GIROLOCAL UMA VEZ'", ""),
    "W6 negative token given to cleanup": ("W", "          CF_PROBE_TOKEN: ${{ secrets.CF_PROBE_TOKEN }}\n        run: python3 sandbox/route-probe/run_route_probe.py cleanup", "          CF_PROBE_TOKEN: ${{ secrets.CF_PROBE_TOKEN }}\n          CF_PROBE_TOKEN_NO_ROUTES: ${{ secrets.CF_PROBE_TOKEN_NO_ROUTES }}\n        run: python3 sandbox/route-probe/run_route_probe.py cleanup"),
    "G1 guard quota raised to 1": ("G", 'sandbox-route-probe.yml) readonly ALLOWED_PRIOR_RUNS=0 ;;', 'sandbox-route-probe.yml) readonly ALLOWED_PRIOR_RUNS=1 ;;'),
}


def run(env_extra, failfast=False):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
    cmd = [sys.executable, "-m", "unittest"] + (["-f"] if failfast else []) + ["tests.test_sandbox_route_probe"]
    return subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=1200)


def one(item):
    name, (which, old, new) = item
    var, fname, text = TARGET[which]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / fname
        f.write_text(sub(text, old, new))
        p = run({var: str(f)}, failfast=True)
    return name, p.returncode != 0


base = run({})
if base.returncode != 0:
    print(base.stderr[-3000:])
    print("MUTANT BASELINE FAILED (suíte sem mutação não passa)")
    sys.exit(2)
print("MUTANT BASELINE PASS", flush=True)
survivors = 0
with ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2)) as ex:
    for name, killed in ex.map(one, M.items()):
        mid = name.split()[0]
        survivors += 0 if killed else 1
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} — {name[len(mid) + 1:]}", flush=True)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
