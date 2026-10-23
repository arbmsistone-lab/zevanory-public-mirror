#!/usr/bin/env python3
"""B02 — prova REAL em sandbox do caminho de rotas do router (pedida pelo auditor Sol). Usado SOMENTE por
.github/workflows/sandbox-route-probe.yml (workflow_dispatch, environment `sandbox-route-probe`, execução única).

Zona descartável: girolocal.api.br (domínio sem uso do proprietário, na conta ZEVANORY 1b264158…). zevanory.api.br é
RECUSADA aqui (constante, sem variável que a troque) e em scripts/ops/router_routes.py (modo sandbox).

  probe    1. guarda (conta, tokens distintos, zona ativa da conta, ambiente limpo)
           2. sobe o vizinho (zevanory-route-neighbour) e o probe v1 (zevanory-route-probe) com rotas pelo wrangler
           3. provas públicas da linha de base; foto (router_routes snapshot) e prova de escrita (preflight)
           4. NEGATIVA antes do deploy: snapshot/preflight com o token SEM Workers Routes Write -> falha com 403 e
              nenhum deploy acontece (versão e rotas inalteradas, zero chamadas ao wrangler)
           5. deploy do probe v2 e MUTAÇÃO TRIPLA via API: troca o script de uma rota do vizinho, remove uma rota do
              probe, acrescenta uma rota estranha; verify tem de acusar exatamente 1/0/1/1; o erro aparece em público
           6. NEGATIVA no retorno: restore com o token sem Routes Write falha com 403 e a zona continua divergente (3)
           7. retorno: wrangler rollback + router_routes restore (1 criada, 1 revertida, 1 apagada); releitura própria
              com tentativas limitadas exige inventário IDÊNTICO à foto e versão == ponto de retorno; provas públicas
           8. mede a janela de roteamento errado (da 1ª mutação até a prova pública restaurada)
  cleanup  apaga as rotas dos dois scripts/hosts e os dois Workers; relê e exige zero sobras (roda em always())

Saída: só códigos HTTP, contagens, rótulos públicos (probe-v1/probe-v2/neighbour) e durações. Nunca token, id de zona,
corpo de resposta da API ou saída do wrangler (vai para arquivo; só `[code: N]` é extraído).
API: https://developers.cloudflare.com/api/resources/workers/subresources/routes/index.md
     https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/ (?force=true)
     https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
API = "https://api.cloudflare.com/client/v4"
ZONE = "girolocal.api.br"
PRODUCTION_ZONE = "zevanory.api.br"
PROBE, NEIGHBOUR = "zevanory-route-probe", "zevanory-route-neighbour"
SCRIPTS = (PROBE, NEIGHBOUR)
PROBE_CFG = "sandbox/route-probe/wrangler.probe.toml"
NEIGHBOUR_CFG = "sandbox/route-probe/wrangler.neighbour.toml"
WRANGLER = "wrangler@4.135.0"
ROUTES = "scripts/ops/router_routes.py"
HOST_P, HOST_N = f"probe.{ZONE}", f"neighbour.{ZONE}"
HOSTS = (HOST_P, HOST_N)
BASELINE = {(f"{HOST_P}/*", PROBE), (f"{HOST_P}/b*", PROBE), (f"{HOST_N}/*", NEIGHBOUR), (f"{HOST_N}/n*", NEIGHBOUR)}
CHANGED = f"{HOST_N}/n*"  # mutação 1: rota do vizinho passa a apontar para o probe
REMOVED = f"{HOST_P}/b*"  # mutação 2: rota do probe removida
FOREIGN = f"{HOST_N}/x*"  # mutação 3: rota estranha acrescentada (rouba tráfego do vizinho para o probe)
PUBLIC_PATHS = {(HOST_P, "/"), (HOST_P, "/b"), (HOST_N, "/n"), (HOST_N, "/x"), (HOST_N, "/")}
LABELS = {"zevanory-route-probe v1": "probe-v1", "zevanory-route-probe v2": "probe-v2",
          "zevanory-route-neighbour": "neighbour"}
HEX32 = re.compile(r"[0-9a-f]{32}")
VID = re.compile(r"[0-9a-f-]{36}")
GHA = os.environ.get("GITHUB_ACTIONS") == "true"
CODES = []
STATE = {"zid": None, "wrangler_calls": 0}

assert PRODUCTION_ZONE not in ZONE and all(PRODUCTION_ZONE not in h for h in HOSTS)


class Fail(Exception):
    pass


def say(line):
    print(line, flush=True)


def err(title, msg):
    say(f"::error title={title}::{msg}" if GHA else f"ERROR {title}: {msg}")


def mask(value):
    if GHA and value:
        say(f"::add-mask::{value}")


def tmpfile(prefix):
    fd, path = tempfile.mkstemp(prefix=prefix, dir=os.environ.get("RUNNER_TEMP") or None)
    os.close(fd)
    return path


def settings():
    if os.environ.get("CLOUDFLARE_ACCOUNT_ID", "") != ACCOUNT:
        raise Fail("CLOUDFLARE_ACCOUNT_ID diferente da conta canônica")
    attempts = os.environ.get("PROBE_ATTEMPTS", "12")
    pause = os.environ.get("PROBE_SLEEP_SECONDS", "5")
    if not re.fullmatch(r"[0-9]{1,2}", attempts) or int(attempts) < 1 or not re.fullmatch(r"[0-9]{1,2}", pause):
        raise Fail("PROBE_ATTEMPTS/PROBE_SLEEP_SECONDS inválidos")
    return int(attempts), int(pause)


def token(name):
    tok = re.sub(r"\s", "", os.environ.get(name, ""))
    if not tok:
        raise Fail(f"{name} ausente")
    mask(tok)
    return tok


def allowed(url):
    if PRODUCTION_ZONE in url:
        return False
    if url == f"{API}/zones?name={ZONE}&account.id={ACCOUNT}":
        return True
    zid = STATE["zid"]
    if zid and re.fullmatch(re.escape(f"{API}/zones/{zid}") + r"(/workers/routes(/[0-9a-f]{32})?)?", url):
        return True
    return bool(re.fullmatch(re.escape(f"{API}/accounts/{ACCOUNT}/workers/scripts/") + f"({PROBE}|{NEIGHBOUR})"
                             + r"(/deployments|\?force=true)", url))


def api(tok, method, url, body=None):
    """Só a API da Cloudflare, só a zona sandbox resolvida e só os dois scripts descartáveis."""
    if not allowed(url):
        raise Fail("URL fora do escopo sandbox — recusada")
    out = tmpfile("cfp-")
    args = ["curl", "-sS", "--max-time", "30", "-o", out, "-w", "%{http_code}", "-X", method,
            "-H", f"Authorization: Bearer {tok}"]
    if body is not None:
        args += ["-H", "Content-Type: application/json", "--data", json.dumps(body)]
    args.append(url)
    try:
        p = subprocess.run(args, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
        code = p.stdout.strip()[-3:] if p.returncode == 0 else "000"
        try:
            with open(out) as f:
                data = json.load(f)
        except Exception:
            data = None
    except subprocess.TimeoutExpired:
        code, data = "000", None
    finally:
        os.remove(out)
    CODES.append(code)
    ok = code == "200" and isinstance(data, dict) and data.get("success") is True
    return ok, code, (data if ok else None)


def resolve_zone(tok):
    ok, code, d = api(tok, "GET", f"{API}/zones?name={ZONE}&account.id={ACCOUNT}")
    if not ok or not isinstance(d.get("result"), list) or len(d["result"]) != 1:
        raise Fail(f"zona sandbox não resolvida (GET /zones http={code})")
    z = d["result"][0]
    acct = z.get("account", {}).get("id") if isinstance(z.get("account"), dict) else None
    if not isinstance(z, dict) or z.get("name") != ZONE or PRODUCTION_ZONE in str(z.get("name")) \
            or not HEX32.fullmatch(str(z.get("id", ""))) or acct != ACCOUNT:
        raise Fail("zona retornada não é a zona sandbox da conta canônica — recusada")
    if z.get("status") != "active":
        raise Fail("zona sandbox ainda não está ativa (nameservers) — nada foi criado")
    mask(z["id"])
    STATE["zid"] = z["id"]


def inventory(tok):
    ok, code, d = api(tok, "GET", f"{API}/zones/{STATE['zid']}/workers/routes")
    if not ok or not isinstance(d.get("result"), list):
        raise Fail(f"GET routes http={code}")
    routes = {}
    for r in d["result"]:
        if not isinstance(r, dict) or not HEX32.fullmatch(str(r.get("id", ""))) or not isinstance(r.get("pattern"), str):
            raise Fail("rota com formato inesperado")
        routes[r["pattern"]] = {"id": r["id"], "script": r.get("script") or None}
    return routes


def as_set(routes):
    return {(p, r["script"]) for p, r in routes.items()}


def ours(pattern, script):
    host = pattern.split("/", 1)[0].lower()
    return script in SCRIPTS or host in HOSTS


def script_state(tok, name):
    """'present' | 'absent' pelo endpoint de implantações (404 = script inexistente)."""
    ok, code, _ = api(tok, "GET", f"{API}/accounts/{ACCOUNT}/workers/scripts/{name}/deployments")
    if ok:
        return "present"
    if code == "404":
        return "absent"
    raise Fail(f"estado do script {name} indeterminado http={code}")


def active_version(tok):
    ok, code, d = api(tok, "GET", f"{API}/accounts/{ACCOUNT}/workers/scripts/{PROBE}/deployments")
    if not ok:
        return ""
    try:
        vs = ((d.get("result") or {}).get("deployments") or [])[0].get("versions") or []
        vid = str(vs[0].get("version_id", "")) if len(vs) == 1 and float(vs[0].get("percentage", 0)) == 100.0 else ""
    except Exception:
        vid = ""
    return vid if VID.fullmatch(vid) else ""


def wrangler(full, args, label):
    """Só com o token COMPLETO. A saída vai para arquivo; no log só os `[code: N]`."""
    STATE["wrangler_calls"] += 1
    log = tmpfile("wr-")
    env = {k: v for k, v in os.environ.items() if k not in ("CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES")}
    env.update({"CLOUDFLARE_API_TOKEN": full, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "WRANGLER_SEND_METRICS": "false"})
    try:
        with open(log, "w") as f:
            p = subprocess.run(["npx", "--yes", WRANGLER] + args, stdout=f, stderr=subprocess.STDOUT, env=env,
                               stdin=subprocess.DEVNULL, timeout=300)
        text = open(log, errors="replace").read()
    finally:
        os.remove(log)
    codes = ",".join(sorted(set(re.findall(r"\[code: ([0-9]{1,6})\]", text)))) or "none"
    say(f"WRANGLER {label} rc={p.returncode} codes={codes}")
    if p.returncode != 0:
        raise Fail(f"wrangler {label} falhou codes={codes}")


def routes_cmd(tok, sub, path, expect_ok):
    """scripts/ops/router_routes.py em modo sandbox (zona e config fixas). Repassa só as linhas saneadas dele."""
    env = {k: v for k, v in os.environ.items() if k not in ("CF_PROBE_TOKEN", "CF_PROBE_TOKEN_NO_ROUTES")}
    env.update({"CLOUDFLARE_API_TOKEN": tok, "ROUTER_ACCOUNT_ID": ACCOUNT, "ROUTER_SCRIPT": PROBE,
                "ROUTER_SANDBOX_ZONE": ZONE, "ROUTER_CONFIG": PROBE_CFG})
    p = subprocess.run([sys.executable, ROUTES, sub, path], env=env, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, timeout=300)
    out = p.stdout + p.stderr
    for line in out.splitlines():
        if line.startswith("::add-mask::"):
            say(line)
        elif not expect_ok and line.startswith("::error title="):
            # Falha ESPERADA (prova negativa): não vira anotação de erro do run.
            say("EXPECTED " + line[len("::error title="):].replace("::", ": ", 1))
        elif line.startswith(("ROUTES_", "::error title=ROUTES_", "ERROR ROUTES_")):
            say(line)
    http = set()
    for m in re.findall(r"http=([0-9,]+)", out):
        http |= set(m.split(","))
    return p.returncode, out, http


def wait(attempts, pause, check):
    for i in range(attempts):
        res = check()
        if res:
            return res
        if i < attempts - 1:
            time.sleep(pause)
    return None


def public(host, path):
    if (host, path) not in PUBLIC_PATHS:
        raise Fail("URL pública fora do escopo")
    out = tmpfile("pub-")
    try:
        p = subprocess.run(["curl", "-sS", "--max-time", "15", "-o", out, "-w", "%{http_code}",
                            "-H", "Cache-Control: no-cache", "-A", "ZEVANORY-RouteProbe/1.0",
                            f"https://{host}{path}"], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
        code = p.stdout.strip()[-3:] if p.returncode == 0 else "000"
        body = open(out, errors="replace").read(200).strip() if code == "200" else ""
    finally:
        os.remove(out)
    return code, LABELS.get(body, "other" if code == "200" else "none")


def public_wait(attempts, pause, expect, tag):
    last = {}

    def check():
        for (host, path), label in expect.items():
            last[(host, path)] = public(host, path)
        return all(last[k][1] == v for k, v in expect.items())

    ok = wait(attempts, pause, check)
    for (host, path), (code, label) in sorted(last.items()):
        say(f"PUBLIC {tag} {host.split('.')[0]}:{path} http={code} serves={label}")
    return bool(ok)


def snapshot_set(path):
    with open(path) as f:
        snap = json.load(f)
    zones = list(snap["zones"].values())
    if len(zones) != 1 or zones[0]["name"] != ZONE:
        raise Fail("foto com zonas inesperadas")
    return {(r["pattern"], r["script"]) for r in zones[0]["routes"]}


def probe():
    attempts, pause = settings()
    full, noroutes = token("CF_PROBE_TOKEN"), token("CF_PROBE_TOKEN_NO_ROUTES")
    if full == noroutes:
        raise Fail("os dois tokens são iguais — a prova negativa seria vazia")
    stage = "guard"
    try:
        resolve_zone(full)
        inv0 = inventory(full)
        if any(ours(p, r["script"]) for p, r in inv0.items()) or any(script_state(full, s) != "absent" for s in SCRIPTS):
            raise Fail("ambiente não está limpo (rotas ou scripts da prova já existem) — rode só o cleanup")
        say(f"PROBE_GUARD=PASS zone=active foreign_routes_in_zone={len(inv0)}")

        stage = "setup"
        wrangler(full, ["deploy", "--config", NEIGHBOUR_CFG, "--message", "B02 route probe neighbour"], "deploy-neighbour")
        wrangler(full, ["deploy", "--config", PROBE_CFG, "--var", "PROBE_VERSION:v1", "--message", "B02 route probe v1"],
                 "deploy-probe-v1")
        prev = wait(attempts, pause, lambda: active_version(full))
        if not prev:
            raise Fail("versão v1 do probe não resolvida")
        ok = wait(attempts, pause, lambda: BASELINE <= as_set(inventory(full)))
        if not ok or not BASELINE <= as_set(inventory(full)):
            raise Fail("rotas da linha de base não apareceram")
        if not public_wait(attempts, pause, {(HOST_P, "/"): "probe-v1", (HOST_P, "/b"): "probe-v1",
                                             (HOST_N, "/n"): "neighbour", (HOST_N, "/x"): "neighbour"}, "baseline"):
            raise Fail("linha de base pública não confirmada (registros DNS proxied probe/neighbour?)")
        say(f"PROBE_SETUP=PASS routes={len(BASELINE)} rollback_point=recorded")

        stage = "snapshot"
        snap = tmpfile("snap-")
        rc, _, _ = routes_cmd(full, "snapshot", snap, True)
        if rc != 0:
            raise Fail("snapshot com o token completo falhou")
        target = snapshot_set(snap)
        if not BASELINE <= target:
            raise Fail("foto não contém a linha de base")
        rc, _, _ = routes_cmd(full, "preflight", snap, True)
        if rc != 0:
            raise Fail("prova de escrita com o token completo falhou")

        stage = "negative-predeploy"
        calls = STATE["wrangler_calls"]
        neg = tmpfile("snapneg-")
        rc, out, http = routes_cmd(noroutes, "snapshot", neg, False)
        where = "snapshot"
        if rc == 0:
            where = "preflight"
            rc, out, http = routes_cmd(noroutes, "preflight", neg, False)
        os.remove(neg)
        if rc == 0:
            raise Fail("token sem Workers Routes Write passou snapshot+preflight — a guarda não protege o deploy")
        if "403" not in http:
            raise Fail(f"falha sem 403 no estágio {where} (http={','.join(sorted(http)) or 'none'})")
        if STATE["wrangler_calls"] != calls or active_version(full) != prev or as_set(inventory(full)) != target:
            raise Fail("estado mudou durante a prova negativa")
        say(f"NEG_PREDEPLOY=PASS stage={where} http=403 wrangler_calls=0 version=unchanged routes=unchanged")

        stage = "deploy-v2"
        wrangler(full, ["deploy", "--config", PROBE_CFG, "--var", "PROBE_VERSION:v2", "--message", "B02 route probe v2"],
                 "deploy-probe-v2")
        new = wait(attempts, pause, lambda: (lambda v: v if v and v != prev else "")(active_version(full)))
        if not new:
            raise Fail("versão v2 do probe não ficou ativa")

        stage = "mutation"
        live = inventory(full)
        t_mut = time.monotonic()
        base = f"{API}/zones/{STATE['zid']}/workers/routes"
        for method, url, body in (("PUT", f"{base}/{live[CHANGED]['id']}", {"pattern": CHANGED, "script": PROBE}),
                                  ("DELETE", f"{base}/{live[REMOVED]['id']}", None),
                                  ("POST", base, {"pattern": FOREIGN, "script": PROBE})):
            ok, code, _ = api(full, method, url, body)
            if not ok:
                raise Fail(f"mutação {method} http={code}")
        say("MUTATION_TRIPLE=APPLIED changed=1 removed=1 added=1")
        rc, out, _ = routes_cmd(full, "verify", snap, False)
        if rc == 0 or "missing_expected=1 missing_other=0 changed=1 extra=1" not in out:
            raise Fail("verify não acusou exatamente a mutação tripla")
        say("VERIFY_DETECTS_TRIPLE=PASS missing_expected=1 missing_other=0 changed=1 extra=1")
        if not public_wait(attempts, pause, {(HOST_N, "/n"): "probe-v2", (HOST_N, "/x"): "probe-v2"}, "mutated"):
            raise Fail("roteamento errado não observado em público — prova inconclusiva")
        t_obs = time.monotonic()

        stage = "negative-restore"
        rc, out, http = routes_cmd(noroutes, "restore", snap, False)
        if rc == 0 or "403" not in http:
            raise Fail("restore com token sem Routes Write não falhou com 403")
        where = "write" if "write_failed=3" in out else "read"
        cur = as_set(inventory(full))
        divergent = len(target - cur) + len(cur - target) - len({p for p, _ in target - cur} & {p for p, _ in cur - target})
        if divergent != 3:
            raise Fail(f"zona deveria seguir divergente em 3 rotas, está em {divergent}")
        say(f"NEG_RESTORE=PASS stage={where} http=403 divergent=3")

        stage = "rollback"
        t_restore = time.monotonic()
        wrangler(full, ["rollback", prev, "--name", PROBE, "--message", "B02 route probe rollback"], "rollback")
        rc, out, _ = routes_cmd(full, "restore", snap, True)
        if rc != 0 or "ROUTES_RESTORE created=1 updated=1 deleted=1 write_failed=0" not in out \
                or "ROUTES_RESTORE_READBACK=PASS" not in out:
            raise Fail("restore não fez exatamente 1 criação, 1 reversão e 1 remoção certificadas")
        if not wait(attempts, pause, lambda: as_set(inventory(full)) == target):
            raise Fail("releitura do inventário diferente da foto")
        if not wait(attempts, pause, lambda: active_version(full) == prev):
            raise Fail("versão ativa diferente do ponto de retorno")
        t_api = time.monotonic()
        say(f"INVENTORY_EQUALS_SNAPSHOT=PASS routes={len(target)} version=rollback_point")
        if not public_wait(attempts, pause, {(HOST_P, "/"): "probe-v1", (HOST_P, "/b"): "probe-v1",
                                             (HOST_N, "/n"): "neighbour", (HOST_N, "/x"): "neighbour"}, "restored"):
            raise Fail("provas públicas não voltaram à linha de base")
        t_pub = time.monotonic()
        rc, out, _ = routes_cmd(full, "verify", snap, True)
        if rc != 0 or "missing_expected=0 missing_other=0 changed=0 extra=0" not in out:
            raise Fail("verify final não passou")
        say(f"WRONG_ROUTING_WINDOW_SECONDS={t_pub - t_mut:.1f} first_public_observation_s={t_obs - t_mut:.1f} "
            f"restore_to_inventory_s={t_api - t_restore:.1f} restore_to_public_s={t_pub - t_restore:.1f}")
        say("ROUTE_PROBE_RESULT=PASS")
    except Fail:
        say(f"ROUTE_PROBE_RESULT=FAIL stage={stage}")
        raise


def cleanup():
    settings()
    full = token("CF_PROBE_TOKEN")
    resolve_zone(full)
    base = f"{API}/zones/{STATE['zid']}/workers/routes"
    deleted = failed = 0
    for p, r in inventory(full).items():
        if ours(p, r["script"]):
            ok, _, _ = api(full, "DELETE", f"{base}/{r['id']}")
            deleted, failed = deleted + ok, failed + (not ok)
    scripts = 0
    for s in SCRIPTS:
        ok, code, _ = api(full, "DELETE", f"{API}/accounts/{ACCOUNT}/workers/scripts/{s}?force=true")
        if ok:
            scripts += 1
        elif code != "404":
            failed += 1
    left = sum(1 for p, r in inventory(full).items() if ours(p, r["script"]))
    left += sum(1 for s in SCRIPTS if script_state(full, s) != "absent")
    say(f"ROUTE_PROBE_CLEANUP routes_deleted={deleted} scripts_deleted={scripts} failed={failed} leftover={left}")
    if left or failed:
        raise Fail(f"sobras={left} falhas={failed} — ação manual do proprietário no painel")
    say("ROUTE_PROBE_CLEANUP=PASS")


def main(argv):
    if len(argv) != 2 or argv[1] not in ("probe", "cleanup"):
        err("ROUTE_PROBE_USAGE", "uso: run_route_probe.py probe|cleanup")
        return 2
    title = "ROUTE_PROBE_FAIL" if argv[1] == "probe" else "ROUTE_PROBE_CLEANUP_FAIL"
    try:
        {"probe": probe, "cleanup": cleanup}[argv[1]]()
        return 0
    except Fail as e:
        err(title, f"{e} | http={','.join(sorted(set(CODES))) or 'none'}")
    except Exception as e:  # noqa: BLE001 — imprevisto fecha; só o tipo vai para o log
        err(title, f"erro inesperado {type(e).__name__} | http={','.join(sorted(set(CODES))) or 'none'}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
