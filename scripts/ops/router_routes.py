#!/usr/bin/env python3
"""B02 (PR #866): inventário de rotas de Worker do router público — foto antes do deploy, verificação completa depois
e restauração no retorno automático. Usado por .github/workflows/public-router-deploy.yml.

Por que existe: `wrangler rollback` devolve só a VERSÃO do Worker; rotas não são versionadas. "If you change your routes
in the dashboard, Wrangler will override them in the next deploy with the routes you have set in your Wrangler
configuration file" (https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth). Sem foto e
restauração, uma rota alterada/removida pelo deploy continuaria assim depois do retorno (achado do auditor Sol).

API oficial (https://developers.cloudflare.com/api/resources/workers/subresources/routes/index.md):
  GET    /zones/{zone_id}/workers/routes              -> result[]: id, pattern, script (opcional)
  POST   /zones/{zone_id}/workers/routes              {pattern, script}
  PUT    /zones/{zone_id}/workers/routes/{route_id}   {pattern, script}  ("Replace Worker Route")
  DELETE /zones/{zone_id}/workers/routes/{route_id}
Permissão do token (https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains):
  "API tokens need Zone > Workers Routes > Write, scoped to each affected zone." Zonas: GET /zones?name=&account.id=
  e GET /zones/{zone_id} (result.account.id) — a zona tem de pertencer à conta canônica.

Subcomandos (todos saem != 0 em qualquer dúvida; nunca imprimem resposta bruta, token, id de zona ou padrão — só
contagens e códigos HTTP; sob GITHUB_ACTIONS=true os ids de zona e o token saneado recebem ::add-mask::):
  snapshot SAIDA   só leitura; grava a foto normalizada (todas as rotas de todos os scripts nas zonas envolvidas)
  verify   FOTO    depois do deploy: zona == (rotas de outros scripts da foto, intactas) + (padrões do toml -> router)
  restore  FOTO    no retorno: cria as que faltam, reverte as alteradas, apaga as acrescentadas; relê e exige igualdade
  preflight FOTO   antes do deploy: prova que o token ESCREVE rotas (PUT idempotente de uma rota do próprio script, mesmo
                   padrão e script) e relê a zona igual à foto; sem Workers Routes Write -> 403 e o deploy é recusado
                   antes de qualquer upload (o wrangler subiria o código e só falharia nas rotas)

Modo sandbox (prova real B02 pedida pelo auditor Sol, .github/workflows/sandbox-route-probe.yml): ROUTER_SANDBOX_ZONE e
ROUTER_CONFIG juntos. A zona tem de estar em SANDBOX_ZONES (só a zona descartável girolocal.api.br), a config tem de estar
em sandbox/route-probe/, todo padrão/zona tem de ser da zona sandbox, e zevanory.api.br (ou subdomínio) é RECUSADA em
qualquer ponto (variável, padrão, resposta da API, foto) antes de qualquer chamada de escrita.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib

CANONICAL_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
API = "https://api.cloudflare.com/client/v4"
CONFIG = "wrangler.public-router.toml"
# Modo sandbox: lista fechada de zonas descartáveis; a zona de produção nunca pode ser alvo deste modo.
SANDBOX_ZONES = ("girolocal.api.br",)
PRODUCTION_ZONE = "zevanory.api.br"
SANDBOX_CONFIG_DIR = "sandbox/route-probe/"
SANDBOX = None
HEX32 = re.compile(r"[0-9a-f]{32}")
GHA = os.environ.get("GITHUB_ACTIONS") == "true"
CODES = []


class Fail(Exception):
    pass


def say(line):
    print(line, flush=True)


def err(title, msg):
    say(f"::error title={title}::{msg}" if GHA else f"ERROR {title}: {msg}")


def mask(value):
    # Só sob Actions: o comando de máscara ecoa o valor, e fora do Actions isso seria impressão em claro.
    if GHA and value:
        say(f"::add-mask::{value}")


def in_production_zone(name):
    name = str(name or "").lower().rstrip(".")
    return PRODUCTION_ZONE in name


def sandbox_mode():
    global CONFIG, SANDBOX
    zone, cfg = os.environ.get("ROUTER_SANDBOX_ZONE"), os.environ.get("ROUTER_CONFIG")
    if zone is None and cfg is None:
        return
    if not zone or not cfg:
        raise Fail("ROUTER_SANDBOX_ZONE e ROUTER_CONFIG só valem juntos")
    if in_production_zone(zone):
        raise Fail("zona de produção recusada no modo sandbox")
    if zone not in SANDBOX_ZONES:
        raise Fail("zona fora da lista sandbox")
    if ".." in cfg or not re.fullmatch(re.escape(SANDBOX_CONFIG_DIR) + r"[a-z0-9][a-z0-9.-]*\.toml", cfg):
        raise Fail("config fora de sandbox/route-probe/")
    CONFIG, SANDBOX = cfg, zone


def pattern_host(pattern):
    host = pattern.split("/", 1)[0].split(":", 1)[0].lower()
    return host[2:] if host.startswith("*.") else host.lstrip("*")


def setup():
    sandbox_mode()  # antes de tudo: uma recusa do modo sandbox não faz nenhuma chamada de rede
    tok = re.sub(r"\s", "", os.environ.get("CLOUDFLARE_API_TOKEN", ""))
    if not tok:
        raise Fail("token ausente")
    if os.environ.get("ROUTER_ACCOUNT_ID", "") != CANONICAL_ACCOUNT:
        raise Fail("ROUTER_ACCOUNT_ID diferente da conta canônica")
    script = os.environ.get("ROUTER_SCRIPT", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", script):
        raise Fail("ROUTER_SCRIPT inválido")
    mask(tok)
    return tok, script


def call(tok, method, url, body=None):
    # Só a API da Cloudflare, só caminhos de zona; o host e o prefixo são fixos aqui.
    if not (url.startswith(f"{API}/zones/") or url.startswith(f"{API}/zones?")):
        raise Fail("URL fora do escopo de zonas")
    if SANDBOX and "?" in url and not url.startswith(f"{API}/zones?name={SANDBOX}&"):
        raise Fail("busca de zona fora da zona sandbox — recusada")
    fd, out = tempfile.mkstemp(prefix="cf-", dir=os.environ.get("RUNNER_TEMP") or None)
    os.close(fd)
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


def expected_patterns():
    with open(CONFIG, "rb") as f:
        cfg = tomllib.load(f)
    raw = cfg.get("routes", [])
    if "route" in cfg:
        raw = list(raw) + [cfg["route"]]
    if cfg.get("account_id") != CANONICAL_ACCOUNT:
        raise Fail("account_id do toml diferente da conta canônica")
    pats = []
    for r in raw:
        if isinstance(r, str):
            pats.append((r, None))
        elif isinstance(r, dict) and isinstance(r.get("pattern"), str) and not r.get("custom_domain") \
                and set(r) <= {"pattern", "zone_name"}:
            pats.append((r["pattern"], r.get("zone_name")))
        else:
            raise Fail("forma de rota não suportada no toml (custom_domain/zone_id)")
    if not pats:
        raise Fail("toml sem rotas")
    if len({p for p, _ in pats}) != len(pats):
        raise Fail("padrão duplicado no toml")
    if SANDBOX:
        for p, zn in pats:
            host = pattern_host(p)
            if in_production_zone(p) or in_production_zone(zn) or (zn and zn != SANDBOX) \
                    or not (host == SANDBOX or host.endswith("." + SANDBOX)):
                raise Fail("padrão fora da zona sandbox — recusado")
    return pats


def zone_candidates(pattern, zone_name):
    if SANDBOX:
        return [SANDBOX]
    if zone_name:
        return [zone_name]
    host = pattern.split("/", 1)[0].split(":", 1)[0]
    host = host[2:] if host.startswith("*.") else host.lstrip("*")
    labels = host.split(".")
    return [".".join(labels[i:]) for i in range(len(labels) - 1)]


def check_zone(z, name):
    if not isinstance(z, dict) or not HEX32.fullmatch(str(z.get("id", ""))) or z.get("name") != name:
        raise Fail("zona com formato inesperado")
    if SANDBOX and (name != SANDBOX or in_production_zone(z.get("name"))):
        raise Fail("zona fora do modo sandbox — recusada")
    acct = (z.get("account") or {}).get("id") if isinstance(z.get("account"), dict) else None
    if acct != CANONICAL_ACCOUNT:
        # A conta vem da resposta, não do filtro pedido: uma zona de outra conta nunca entra no inventário.
        raise Fail("zona pertence a outra conta — recusada")
    return z["id"]


def resolve_zones(tok, pats):
    by_zone, cache = {}, {}
    for pattern, zone_name in pats:
        zid = None
        for cand in zone_candidates(pattern, zone_name):
            if cand not in cache:
                ok, code, d = call(tok, "GET", f"{API}/zones?name={cand}&account.id={CANONICAL_ACCOUNT}")
                if not ok or not isinstance(d.get("result"), list):
                    raise Fail(f"GET /zones http={code}")
                hits = d["result"]
                if len(hits) > 1:
                    raise Fail("busca de zona ambígua")
                cache[cand] = (check_zone(hits[0], cand), cand) if hits else None
            if cache[cand]:
                zid = cache[cand]
                break
        if not zid:
            raise Fail("zona do padrão não encontrada na conta canônica")
        mask(zid[0])
        by_zone.setdefault(zid, []).append(pattern)
    return by_zone


def reverify_zone(tok, zid, name):
    if not HEX32.fullmatch(zid):
        raise Fail("id de zona inválido na foto")
    ok, code, d = call(tok, "GET", f"{API}/zones/{zid}")
    if not ok:
        raise Fail(f"GET /zones/{{id}} http={code}")
    check_zone(d.get("result"), name)


def inventory(tok, zid):
    ok, code, d = call(tok, "GET", f"{API}/zones/{zid}/workers/routes")
    if not ok or not isinstance(d.get("result"), list):
        raise Fail(f"GET /zones/{{id}}/workers/routes http={code}")
    routes = {}
    for r in d["result"]:
        if not isinstance(r, dict) or not HEX32.fullmatch(str(r.get("id", ""))) \
                or not isinstance(r.get("pattern"), str) or not r["pattern"]:
            raise Fail("rota com formato inesperado")
        script = r.get("script")
        if script is not None and not isinstance(script, str):
            raise Fail("rota com script de formato inesperado")
        if r["pattern"] in routes:
            raise Fail("padrão duplicado na zona")
        routes[r["pattern"]] = {"id": r["id"], "script": script or None}
    return routes


def load_snapshot(path, script):
    with open(path) as f:
        snap = json.load(f)
    if not isinstance(snap, dict) or snap.get("account") != CANONICAL_ACCOUNT:
        raise Fail("foto de outra conta — recusada")
    if snap.get("script") != script or not isinstance(snap.get("zones"), dict) or not snap["zones"]:
        raise Fail("foto inválida")
    if snap.get("sandbox_zone") != SANDBOX:
        raise Fail("foto de outro modo (sandbox/produção) — recusada")
    if SANDBOX and any(not isinstance(z, dict) or z.get("name") != SANDBOX or in_production_zone(z.get("name"))
                       for z in snap["zones"].values()):
        raise Fail("foto com zona fora do modo sandbox — recusada")
    return snap


def diff(current, target):
    """(faltando, alterada, acrescentada) entre {padrão: script} atual e alvo."""
    missing = [p for p in target if p not in current]
    changed = [p for p in target if p in current and current[p] != target[p]]
    extra = [p for p in current if p not in target]
    return missing, changed, extra


def cmd_snapshot(tok, script, out):
    pats = expected_patterns()
    zones = resolve_zones(tok, pats)
    snap = {"account": CANONICAL_ACCOUNT, "script": script, "zones": {}}
    if SANDBOX:
        snap["sandbox_zone"] = SANDBOX
    conflicts = drift = total = mine = 0
    for (zid, name), expected in zones.items():
        routes = inventory(tok, zid)
        total += len(routes)
        mine += sum(1 for r in routes.values() if r["script"] == script)
        # O deploy tomaria um padrão de outro script (ou de rota sem Worker): recusado antes do deploy.
        conflicts += sum(1 for p in expected if p in routes and routes[p]["script"] != script)
        # O deploy apagaria uma rota do router que não está no toml: recusado (o toml tem de refletir o vivo).
        drift += sum(1 for p, r in routes.items() if r["script"] == script and p not in expected)
        snap["zones"][zid] = {"name": name, "expected": expected,
                              "routes": [{"id": r["id"], "pattern": p, "script": r["script"]} for p, r in sorted(routes.items())]}
    if conflicts or drift:
        raise Fail(f"conflitos={conflicts} rotas_do_router_fora_do_toml={drift} — deploy recusado")
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(snap, f, sort_keys=True)
    digest = hashlib.sha256(open(out, "rb").read()).hexdigest()[:16]
    say(f"ROUTES_SNAPSHOT=PASS zones={len(zones)} routes={total} router_routes={mine} "
        f"expected_patterns={len(pats)} sha256={digest}")


def cmd_verify(tok, script, path):
    snap = load_snapshot(path, script)
    pats = {p for p, _ in expected_patterns()}
    bad = {"missing_expected": 0, "missing_other": 0, "changed": 0, "extra": 0}
    checked = 0
    if sorted(p for z in snap["zones"].values() for p in z["expected"]) != sorted(pats):
        raise Fail("padrões do toml diferem dos da foto")
    for zid, z in snap["zones"].items():
        reverify_zone(tok, zid, z["name"])
        expected = list(z["expected"])
        target = {r["pattern"]: r["script"] for r in z["routes"] if r["script"] != script}
        target.update({p: script for p in expected})
        current = {p: r["script"] for p, r in inventory(tok, zid).items()}
        missing, changed, extra = diff(current, target)
        bad["missing_expected"] += sum(1 for p in missing if p in expected)
        bad["missing_other"] += sum(1 for p in missing if p not in expected)
        bad["changed"] += len(changed)
        bad["extra"] += len(extra)
        checked += len(target)
    summary = " ".join(f"{k}={v}" for k, v in bad.items())
    if any(bad.values()):
        raise Fail(f"inventário pós-deploy diverge: {summary}")
    say(f"ROUTES_VERIFY=PASS checked={checked} expected_patterns={len(pats)} {summary}")


def cmd_restore(tok, script, path):
    snap = load_snapshot(path, script)
    done = {"created": 0, "updated": 0, "deleted": 0, "write_failed": 0}
    for zid, z in snap["zones"].items():
        reverify_zone(tok, zid, z["name"])
        target = {r["pattern"]: r["script"] for r in z["routes"]}
        live = inventory(tok, zid)
        missing, changed, extra = diff({p: r["script"] for p, r in live.items()}, target)
        base = f"{API}/zones/{zid}/workers/routes"
        body = lambda p: {"pattern": p, **({"script": target[p]} if target[p] else {})}
        ops = [("DELETE", f"{base}/{live[p]['id']}", None, "deleted") for p in extra]
        ops += [("PUT", f"{base}/{live[p]['id']}", body(p), "updated") for p in changed]
        ops += [("POST", base, body(p), "created") for p in missing]
        for method, url, payload, kind in ops:
            ok, _, _ = call(tok, method, url, payload)
            done[kind if ok else "write_failed"] += 1
    say("ROUTES_RESTORE " + " ".join(f"{k}={v}" for k, v in done.items()))
    # Certificação por releitura: só passa se cada zona for exatamente igual à foto (padrão e script).
    left = 0
    for zid, z in snap["zones"].items():
        target = {r["pattern"]: r["script"] for r in z["routes"]}
        missing, changed, extra = diff({p: r["script"] for p, r in inventory(tok, zid).items()}, target)
        left += len(missing) + len(changed) + len(extra)
    if left:
        raise Fail(f"releitura diverge da foto em {left} rota(s)")
    say(f"ROUTES_RESTORE_READBACK=PASS routes={sum(len(z['routes']) for z in snap['zones'].values())}")


def cmd_preflight(tok, script, path):
    snap = load_snapshot(path, script)
    probed = 0
    for zid, z in snap["zones"].items():
        reverify_zone(tok, zid, z["name"])
        target = {r["pattern"]: r["script"] for r in z["routes"]}
        live = inventory(tok, zid)
        if any(diff({p: r["script"] for p, r in live.items()}, target)):
            raise Fail("zona diverge da foto antes da prova de escrita")
        own = sorted(p for p in target if target[p] == script)
        if own and not probed:
            pat = own[0]
            ok, code, _ = call(tok, "PUT", f"{API}/zones/{zid}/workers/routes/{live[pat]['id']}",
                               {"pattern": pat, "script": script})
            if not ok:
                raise Fail(f"token sem escrita de rotas (PUT http={code}) — deploy recusado")
            probed = 1
            if any(diff({p: r["script"] for p, r in inventory(tok, zid).items()}, target)):
                raise Fail("zona mudou com a prova de escrita")
    if not probed:
        raise Fail("nenhuma rota do script para a prova de escrita — deploy recusado")
    say(f"ROUTES_PREFLIGHT=PASS write_probe={probed} zones={len(snap['zones'])}")


def main(argv):
    if len(argv) != 3 or argv[1] not in ("snapshot", "verify", "restore", "preflight"):
        err("ROUTES_USAGE", "uso: router_routes.py snapshot|verify|restore|preflight ARQUIVO")
        return 2
    title = {"snapshot": "ROUTES_SNAPSHOT_FAIL", "verify": "ROUTES_VERIFY_FAIL", "restore": "ROUTES_RESTORE_FAIL",
             "preflight": "ROUTES_PREFLIGHT_FAIL"}[argv[1]]
    try:
        tok, script = setup()
        {"snapshot": cmd_snapshot, "verify": cmd_verify, "restore": cmd_restore,
         "preflight": cmd_preflight}[argv[1]](tok, script, argv[2])
        return 0
    except Fail as e:
        err(title, f"{e} | http={','.join(sorted(set(CODES))) or 'none'}")
    except Exception as e:  # noqa: BLE001 — qualquer imprevisto fecha; só o tipo vai para o log.
        err(title, f"erro inesperado {type(e).__name__} | http={','.join(sorted(set(CODES))) or 'none'}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
