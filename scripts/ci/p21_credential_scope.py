#!/usr/bin/env python3
"""P21 / R18: escopo EFETIVO de cada token Cloudflare dedicado, lido das POLÍTICAS do próprio token (somente leitura).

Entrada: ops/token-cutover.json e as respostas de GET /accounts/<conta>/tokens (Account API tokens; lidas no job
credential-scope de .github/workflows/t1-publisher-guard.yml com CF_TOKEN_AUDIT, que só tem "Account API Tokens
Read" e nunca escreve). Nenhuma chamada de rede aqui; nenhum valor de token existe nessas respostas.

Regras por serviço:
  cutover=false  -> NOT_PROVEN (o legado da conta inteira ainda está em uso). Nunca reprova: é o estado de transição.
  cutover=true   -> reprova (FAIL) se:
    TOKEN_DEDICADO_AUSENTE          token_id registrado não existe na conta (ou auditoria indisponível);
    TOKEN_INATIVO / TOKEN_VENCIDO   status != active, ou expires_on no passado;
    TOKEN_SEM_VALIDADE              sem expires_on (o roteiro exige TTL);
    TOKEN_ALCANCE_CONTA             política de escrita sobre a conta inteira ou todas as zonas;
    TOKEN_WORKER_NAO_DECLARADO      escrita em Worker fora de edit_workers;
    TOKEN_ALCANCE_MAIS_DE_UM_WORKER escrita em mais Workers que os declarados (1 por serviço; vendas: 2, com o candidato fixo);
    TOKEN_ZONA_NAO_DECLARADA        escrita em zona fora de edit_zones;
    TOKEN_RECURSO_DESCONHECIDO      chave de recurso que este leitor não sabe classificar (fecha em falha);
    TOKEN_SEM_EDITOR_NO_WORKER      Worker declarado sem política de escrita (o deploy falharia).
Veredito: FAIL se qualquer reprovação; NOT_PROVEN se algum serviço com cutover=false; PASS só com todos true e limpos.

Formato das chaves de recurso (developers.cloudflare.com/fundamentals/api/how-to/create-via-api/#resources):
  conta "com.cloudflare.api.account.<ID>": "*"; zona "com.cloudflare.api.account.zone.<ZONE_ID>": "*";
  todas as zonas "com.cloudflare.api.account.<ID>": {"com.cloudflare.api.account.zone.*": "*"}.
  Worker específico (Specified Workers, changelog 2026-09-15): aceito como "com.cloudflare.edge.worker.script.<...><nome>"
  terminando em ".<nome>" ou "_<nome>" (mesmo padrão do recurso de bucket R2). O formato exato ainda não está na
  documentação: chave diferente = TOKEN_RECURSO_DESCONHECIDO (reprova) até o leitor ser ajustado com a leitura real.

Uso: p21_credential_scope.py --cutover ops/token-cutover.json --tokens r1.json [--tokens r2.json] [--now ISO] [--json]
     p21_credential_scope.py --cutover ops/token-cutover.json --audit-unavailable
Exit: 0 PASS ou NOT_PROVEN; 1 FAIL; 2 erro de entrada.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys

WRITE = re.compile(r"edit|write|admin|editor", re.I)
ZONE_KEY = re.compile(r"^com\.cloudflare\.api\.account\.zone\.([0-9a-f]{32})$")
WORKER_KEY = re.compile(r"^com\.cloudflare\.edge\.worker\.script\.(.+)$")


def _flatten(resources, parent=None):
    """[(chave, pai)] de um objeto de recursos (aninhamento de um nível, como na API)."""
    out = []
    if not isinstance(resources, dict):
        return [("<inválido>", parent)]
    for k, v in resources.items():
        if isinstance(v, dict):
            out += _flatten(v, k)
        else:
            out.append((k, parent) if v == "*" else (f"{k}=<{v}>", parent))
    return out


def classify(key, parent, account, edit_workers):
    """('account'|'all-zones'|'zone'|'worker'|'unknown', detalhe)."""
    if parent is None and key == f"com.cloudflare.api.account.{account}":
        return "account", account
    if parent == f"com.cloudflare.api.account.{account}" and key == "com.cloudflare.api.account.zone.*":
        return "all-zones", account
    if parent is None and key in ("com.cloudflare.api.account.*", "com.cloudflare.api.account.zone.*"):
        return "account", "*"
    if parent not in (None, f"com.cloudflare.api.account.{account}"):
        return "unknown", key
    m = ZONE_KEY.match(key)
    if m:
        return "zone", m.group(1)
    m = WORKER_KEY.match(key)
    if m and "*" not in key:
        tail = m.group(1)
        for w in sorted(set(edit_workers) | {tail.rsplit(".", 1)[-1], tail.rsplit("_", 1)[-1]}, key=len, reverse=True):
            if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", w) and (tail == w or tail.endswith("." + w) or tail.endswith("_" + w)):
                return "worker", w
        return "unknown", key
    return "unknown", key


def _parse_time(s):
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def evaluate(cutover: dict, tokens: list | None, now: dt.datetime) -> dict:
    account = cutover.get("account", "")
    by_id = {t.get("id"): t for t in (tokens or []) if isinstance(t, dict)}
    out = {}
    for svc, s in (cutover.get("services") or {}).items():
        r = {"secret": s.get("secret"), "cutover": s.get("cutover") is True, "fails": [], "notes": []}
        out[svc] = r
        if s.get("cutover") is not True:
            r["state"] = "NOT_PROVEN"
            r["notes"].append("cutover=false: token legado (conta inteira) ainda em uso")
            continue
        fail = lambda code, msg: r["fails"].append(f"{code}: {msg}")  # noqa: E731
        tid = s.get("token_id")
        if tokens is None:
            fail("TOKEN_DEDICADO_AUSENTE", "auditoria indisponível (CF_TOKEN_AUDIT ausente ou leitura falhou): escopo não comprovável")
            r["state"] = "FAIL"
            continue
        t = by_id.get(tid)
        if not t:
            fail("TOKEN_DEDICADO_AUSENTE", f"token_id {tid} não existe na conta {account}")
            r["state"] = "FAIL"
            continue
        r["token_name"] = t.get("name")
        if t.get("status") != "active":
            fail("TOKEN_INATIVO", f"status={t.get('status')}")
        exp = _parse_time(t.get("expires_on")) if t.get("expires_on") else None
        if not t.get("expires_on"):
            fail("TOKEN_SEM_VALIDADE", "sem expires_on (TTL obrigatório no roteiro)")
        elif exp is None or exp <= now:
            fail("TOKEN_VENCIDO", f"expires_on={t.get('expires_on')}")
        edit_workers = list(s.get("edit_workers") or [])
        edit_zones = set(s.get("edit_zones") or [])
        written = set()
        for p in t.get("policies") or []:
            if not isinstance(p, dict) or p.get("effect") != "allow":
                continue
            groups = [g.get("name", g.get("id", "?")) for g in p.get("permission_groups") or [] if isinstance(g, dict)]
            is_write = any(WRITE.search(str(g)) for g in groups)
            for key, parent in _flatten(p.get("resources")):
                kind, det = classify(key, parent, account, edit_workers)
                if not is_write:
                    r["notes"].append(f"leitura {groups} em {kind}:{det}")
                    continue
                if kind in ("account", "all-zones"):
                    fail("TOKEN_ALCANCE_CONTA", f"escrita {groups} sobre {kind} {det}")
                elif kind == "zone":
                    if det not in edit_zones:
                        fail("TOKEN_ZONA_NAO_DECLARADA", f"escrita {groups} na zona {det}")
                elif kind == "worker":
                    written.add(det)
                    if det not in edit_workers:
                        fail("TOKEN_WORKER_NAO_DECLARADO", f"escrita {groups} no Worker {det}")
                else:
                    fail("TOKEN_RECURSO_DESCONHECIDO", f"escrita {groups} em recurso {det}")
        limit = max(1, len(edit_workers))
        if len(written) > limit:
            fail("TOKEN_ALCANCE_MAIS_DE_UM_WORKER", f"escrita em {len(written)} Workers {sorted(written)} (máximo {limit})")
        for w in edit_workers:
            if w not in written:
                fail("TOKEN_SEM_EDITOR_NO_WORKER", f"nenhuma política de escrita no Worker declarado {w}")
        r["edit_workers_effective"] = sorted(written)
        r["state"] = "FAIL" if r["fails"] else "PROVEN"
    states = [r["state"] for r in out.values()]
    verdict = "FAIL" if "FAIL" in states else ("NOT_PROVEN" if "NOT_PROVEN" in states or not states else "PASS")
    return {"schema": "p21-credential-scope/v1", "verdict": verdict, "services": out}


def load_tokens(paths):
    toks = []
    for p in paths:
        with open(p, encoding="utf-8") as fh:
            d = json.load(fh)
        if not isinstance(d, dict) or d.get("success") is not True or not isinstance(d.get("result"), list):
            return None
        toks += d["result"]
    return toks


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutover", required=True)
    ap.add_argument("--tokens", action="append", default=[])
    ap.add_argument("--audit-unavailable", action="store_true")
    ap.add_argument("--now")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        with open(a.cutover, encoding="utf-8") as fh:
            cut = json.load(fh)
        toks = None if a.audit_unavailable or not a.tokens else load_tokens(a.tokens)
    except (OSError, ValueError) as e:
        print(f"::error title=P21_CREDENTIAL_SCOPE::entrada ilegível: {type(e).__name__}")
        return 2
    now = _parse_time(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    v = evaluate(cut, toks, now)
    for svc, r in v["services"].items():
        if r["state"] == "FAIL":
            for f in r["fails"]:
                print(f"::error title=CRED_P21_{r['secret']}::{svc} {f}")
        elif r["state"] == "PROVEN":
            print(f"::notice title=CRED_P21_{r['secret']}::{svc} SCOPE_PROVEN edit_workers={r['edit_workers_effective']} token={r.get('token_name')}")
        else:
            print(f"::notice title=CRED_P21_{r['secret']}::{svc} NOT_PROVEN ({'; '.join(r['notes'])})")
    if a.json:
        print(json.dumps(v, ensure_ascii=False, indent=1))
    print(f"P21_CREDENTIAL_SCOPE={v['verdict']}")
    return 1 if v["verdict"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
