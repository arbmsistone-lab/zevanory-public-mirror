#!/usr/bin/env python3
"""P20 diário D1: certificação fail-closed do primeiro deploy central com o binding DIARIO (NO-GO do GPT-6,
NC-P2b-DEP-01/02). Usado SÓ pelos passos D1 de .github/workflows/central-production-deploy.yml.

Subcomandos (nenhum deles grava nada em lugar nenhum):
  sql                       imprime a ÚNICA consulta de certificação: um SELECT só de leitura, de uma linha, que
                            devolve diario_head, a lista de d1_migrations, os objetos do esquema e as contagens
                            abandono_*. O passo do workflow a executa com o token D1 do próprio passo.
  check --fase antes|depois ARQ [--antes RESUMO]
                            confere a saída JSON de `wrangler d1 execute --json` contra o esperado DERIVADO das
                            migrações em migrations/d1 (fixadas em MIGRACOES_ESPERADAS). Em `depois` exige igualdade
                            com o resumo de `antes`. Imprime RESUMO=<json>. Saída 0 = PASS, 1 = FAIL.
  binding --expect presente|ausente [--candidate SHA]
                            lê na API da Cloudflare a configuração EFETIVA do Worker publicado: deployment ativo
                            (uma versão a 100%), a tag dessa versão (= SHA do candidato) e os bindings da versão e
                            de /settings. Usa o token do DEPLOY (CLOUDFLARE_API_TOKEN, o mesmo que já lê /settings e
                            /deployments no guard): o token CF_TOKEN_D1_DIARIO_READ é só D1 Read e não lê Worker.
                            Saída 0 = PASS, 1 = FAIL (evidência positiva), 3 = NAO_COMPROVADO (API inalcançável).

Doc: docs/p20/diario-d1.md, seção "Primeiro deploy com D1: modos off, certificar e rollback".
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIG_DIR = ROOT / "migrations" / "d1"
DB_NAME = "zevanory-diario-p20"
DB_ID = "1b1bfa19-ccc5-423a-bc1f-62d89020c8e2"
BINDING = "DIARIO"
SCRIPT = "zevanory"
# Fixadas de propósito: uma migração nova exige revisar esta certificação (e o GPT-6) antes de chegar à produção.
MIGRACOES_ESPERADAS = ("0001_diario_v1.sql", "0002_diario_v1_ts.sql", "0003_abandono_v1.sql")
CREATE = re.compile(r"\bCREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)", re.I)
PASS, FAIL, NAO_COMPROVADO = 0, 1, 3


class Falha(Exception):
    pass


def migracoes_no_repositorio(mig_dir=MIG_DIR):
    return tuple(sorted(p.name for p in pathlib.Path(mig_dir).glob("*.sql")))


def objetos_esperados(mig_dir=MIG_DIR):
    """(tipo, nome) de cada CREATE ... IF NOT EXISTS das migrações fixadas, mais a tabela d1_migrations do wrangler."""
    achadas = migracoes_no_repositorio(mig_dir)
    if achadas != MIGRACOES_ESPERADAS:
        raise Falha(f"DIARIO_D1_MIGRACOES_NAO_REVISADAS: migrations/d1 tem {list(achadas)}, a certificação revisou {list(MIGRACOES_ESPERADAS)}")
    objs = {("table", "d1_migrations")}
    for nome in MIGRACOES_ESPERADAS:
        sql = re.sub(r"--[^\n]*", "", (pathlib.Path(mig_dir) / nome).read_text(encoding="utf-8"))
        objs |= {(t.lower(), n) for t, n in CREATE.findall(sql)}
    return objs


def tabelas_abandono(mig_dir=MIG_DIR):
    return sorted(n for t, n in objetos_esperados(mig_dir) if t == "table" and n.startswith("abandono_"))


def sql_certificacao(mig_dir=MIG_DIR):
    cont = "".join(f", (select count(*) from {t}) as {t}" for t in tabelas_abandono(mig_dir))
    return ("select (select count(*) from diario_head) as diario_head"
            ", (select group_concat(name, ',') from (select name from d1_migrations order by id)) as migracoes"
            ", (select group_concat(type || ':' || name, ',') from (select type, name from sqlite_master"
            " where type in ('table', 'index', 'trigger') and substr(name, 1, 7) <> 'sqlite_'"
            " and substr(name, 1, 4) <> '_cf_' order by type, name)) as objetos" + cont)


def _linha(saida):
    d = saida
    if isinstance(d, list):
        if len(d) != 1:
            raise Falha(f"saída do wrangler com {len(d)} resultados (esperado 1)")
        d = d[0]
    if not isinstance(d, dict) or d.get("success") is False:
        raise Falha("saída do wrangler sem sucesso")
    rows = d.get("results")
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise Falha("saída do wrangler sem exatamente uma linha")
    return rows[0]


def resumo(saida, mig_dir=MIG_DIR):
    row = _linha(saida)
    abandono = tabelas_abandono(mig_dir)
    falta = [k for k in ["diario_head", "migracoes", "objetos", *abandono] if k not in row]
    if falta:
        raise Falha("colunas ausentes na consulta: " + ",".join(falta))
    return {
        "diario_head": row["diario_head"],
        "migracoes": [m for m in str(row["migracoes"] or "").split(",") if m],
        "objetos": sorted(o for o in str(row["objetos"] or "").split(",") if o),
        "abandono": {t: row[t] for t in abandono},
    }


def verifica(r, antes=None, mig_dir=MIG_DIR):
    """Lista de falhas (vazia = PASS). Nenhum aviso vira PASS: tudo que não confere é falha."""
    erros = []
    if r["diario_head"] != 1:
        erros.append(f"DIARIO_D1_HEAD: diario_head com {r['diario_head']!r} linha(s), esperado 1")
    if r["migracoes"] != list(MIGRACOES_ESPERADAS):
        erros.append(f"DIARIO_D1_MIGRACOES: d1_migrations={r['migracoes']}, esperado {list(MIGRACOES_ESPERADAS)}")
    esperado = sorted(f"{t}:{n}" for t, n in objetos_esperados(mig_dir))
    if r["objetos"] != esperado:
        falta, sobra = sorted(set(esperado) - set(r["objetos"])), sorted(set(r["objetos"]) - set(esperado))
        erros.append(f"DIARIO_D1_OBJETOS: faltam {falta}, sobram {sobra}")
    for t, n in sorted(r["abandono"].items()):
        if n != 0:
            erros.append(f"DIARIO_D1_ABANDONO: {t} com {n!r} linha(s); o abandono está no estágio desligado (esperado 0)")
    if antes is not None:
        for k in ("diario_head", "migracoes", "objetos", "abandono"):
            if antes.get(k) != r[k]:
                erros.append(f"DIARIO_D1_ANTES_DEPOIS: {k} antes={antes.get(k)!r} depois={r[k]!r}")
    return erros


def cmd_check(args):
    try:
        r = resumo(json.loads(pathlib.Path(args.arquivo).read_text(encoding="utf-8")))
        antes = None
        if args.fase == "depois":
            if not args.antes:
                raise Falha("fase depois exige --antes (resumo da fase antes)")
            antes = json.loads(pathlib.Path(args.antes).read_text(encoding="utf-8") or "null")
            if not isinstance(antes, dict):
                raise Falha("resumo da fase antes ausente ou ilegível")
        erros = verifica(r, antes)
    except (Falha, ValueError, OSError, KeyError, TypeError) as e:
        print(f"DIARIO_D1_CHECK_{args.fase.upper()}=FAIL {e}")
        return FAIL
    for e in erros:
        print(f"DIARIO_D1_CHECK_{args.fase.upper()}=FAIL {e}")
    print("RESUMO=" + json.dumps(r, sort_keys=True, separators=(",", ":")))
    if erros:
        return FAIL
    print(f"DIARIO_D1_CHECK_{args.fase.upper()}=PASS head=1 migracoes={len(r['migracoes'])} objetos={len(r['objetos'])} abandono=0")
    return PASS


# ---------------------------------------------------------------------------------------------------------------
# Binding efetivo no Worker publicado. HTTP pelo curl (o mesmo cliente dos outros passos), token no cabeçalho.
class Inalcancavel(Exception):
    pass


def curl_get(url, token):
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d, "body.json")
        p = subprocess.run(["curl", "-sS", "--max-time", "20", "-o", str(out), "-w", "%{http_code}",
                            "-H", f"Authorization: Bearer {token}", url], capture_output=True, text=True)
        code = (p.stdout or "").strip()
        if p.returncode != 0 or code != "200":
            raise Inalcancavel(f"HTTP {code or 'sem resposta'} em {url.rsplit('/' + SCRIPT, 1)[-1] or '/'}")
        try:
            body = json.loads(out.read_text(encoding="utf-8"))
        except ValueError:
            raise Inalcancavel("resposta não é JSON")
        if not isinstance(body, dict) or body.get("success") is not True:
            raise Inalcancavel("API respondeu success!=true")
        return body.get("result")


def _diario(bindings):
    return [b for b in bindings if isinstance(b, dict) and b.get("name") == BINDING]


def avalia_binding(fetch, expect, candidate=None):
    """(código, motivo, registro). fetch(caminho_relativo_ao_script) -> result (ou levanta Inalcancavel)."""
    reg = {"expect": expect, "candidate": candidate}
    try:
        dep = fetch("/deployments") or {}
        deployments = dep.get("deployments") or []
        if not deployments:
            return FAIL, "sem deployment ativo", reg
        full = [v for v in deployments[0].get("versions") or [] if int(v.get("percentage") or 0) == 100]
        if len(full) != 1:
            return FAIL, "deployment ativo sem exatamente uma versão a 100%", reg
        vid = full[0].get("version_id")
        reg["version_id"] = vid
        ver = fetch(f"/versions/{vid}") or {}
        settings = fetch("/settings") or {}
    except Inalcancavel as e:
        return NAO_COMPROVADO, f"API inalcançável: {e}", reg
    ann = (ver.get("metadata") or {}).get("annotations") or ver.get("annotations") or {}
    tag = str(ann.get("workers/tag") or "").strip().lower()
    reg["tag"] = tag
    if candidate and tag != candidate.lower():
        return FAIL, f"versão ativa com tag {tag[:12] or 'nenhuma'}, não o candidato {candidate[:12]}", reg
    fontes = {}
    if isinstance(settings.get("bindings"), list):
        fontes["settings"] = settings["bindings"]
    vb = (ver.get("resources") or {}).get("bindings")
    if isinstance(vb, list):
        fontes["versao"] = vb
    if "settings" not in fontes:
        return NAO_COMPROVADO, "settings sem lista de bindings", reg
    for nome, bindings in fontes.items():
        d = _diario(bindings)
        reg[nome] = [{k: b.get(k) for k in ("name", "type", "id", "database_id")} for b in d]
        if expect == "ausente":
            if d:
                return FAIL, f"binding {BINDING} PRESENTE em {nome} (esperado ausente)", reg
        else:
            if len(d) != 1:
                return FAIL, f"{len(d)} binding(s) {BINDING} em {nome} (esperado 1)", reg
            b = d[0]
            bid = str(b.get("id") or b.get("database_id") or "").lower()
            if b.get("type") != "d1" or bid != DB_ID:
                return FAIL, f"binding {BINDING} em {nome} com tipo {b.get('type')!r} e banco {bid[:8] or '?'} (esperado d1 {DB_ID[:8]})", reg
    reg["fontes"] = sorted(fontes)
    return PASS, f"binding {BINDING} {expect} na versão ativa ({', '.join(sorted(fontes))})", reg


def cmd_binding(args):
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not token or not account:
        code, motivo, reg = NAO_COMPROVADO, "token do deploy ou conta ausente", {"expect": args.expect}
    else:
        base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{SCRIPT}"
        code, motivo, reg = avalia_binding(lambda path: curl_get(base + path, token), args.expect, args.candidate)
    estado = {PASS: "PASS", FAIL: "FAIL", NAO_COMPROVADO: "NAO_COMPROVADO"}[code]
    reg.update(estado=estado, motivo=motivo)
    print("DIARIO_D1_BINDING_EFETIVO=" + json.dumps(reg, sort_keys=True, ensure_ascii=False))
    return code


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sql")
    c = sub.add_parser("check")
    c.add_argument("--fase", choices=("antes", "depois"), required=True)
    c.add_argument("--antes")
    c.add_argument("arquivo")
    b = sub.add_parser("binding")
    b.add_argument("--expect", choices=("presente", "ausente"), required=True)
    b.add_argument("--candidate")
    args = ap.parse_args(argv)
    if args.cmd == "sql":
        try:
            print(sql_certificacao())
        except Falha as e:
            print(str(e), file=sys.stderr)
            return FAIL
        return PASS
    return cmd_check(args) if args.cmd == "check" else cmd_binding(args)


if __name__ == "__main__":
    sys.exit(main())
