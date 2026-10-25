#!/usr/bin/env python3
"""ZEVANORY | Certificação da chave de leitura do Resend Receiving ANTES de gravar no KV do Worker.

Causa-raiz (incidente suporte@): o workflow aceitava qualquer chave que respondesse 200 em
GET /emails/receiving?limit=1. Uma chave de OUTRA conta Resend também responde 200 (lista vazia ou de outra
caixa), e o Worker passou a receber 404 em GET /emails/receiving/{email_id} para e-mails reais.

Prova exigida (auditor Sol, vinculante), fail-closed:
  1. pré-condição: GET /emails/receiving?limit=1 == 200 (lista);
  2. GET /emails/receiving/{reference_email_id} == 200 com a chave candidata, onde reference_email_id é um
     e-mail recebido CONHECIDO da conta esperada (informado pelo proprietário a partir do painel Resend);
  3. o campo `to` da resposta contém um endereço cujo domínio é EXATAMENTE zevanory.api.br.
Qualquer outra coisa => NAO_COMPROVADO, código 2, e o KV NÃO é tocado (nunca troca chave boa por não certificada).

Docs oficiais: https://resend.com/docs/api-reference/emails/retrieve-received-email
                https://resend.com/docs/api-reference/emails/list-received-emails
Log só categórico: status HTTP, domain_match, veredito. Nunca corpo, remetente, assunto, id ou a chave.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.resend.com"
EXPECTED_DOMAIN = "zevanory.api.br"
KV_KEY = "sandbox-config:resend-receiving-key"
KV_NAMESPACE_ID = "728a45738e4047f29bcb89934fd533c1"
WRANGLER = "wrangler@4.143.0"
# Mesmo formato aceito pelo Worker (worker/support-email-forward.mjs, ID_RE).
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
EMAIL_RE = re.compile(r"[^\s@<>]+@([^\s@<>]+)")

COMPROVADO = "COMPROVADO"
NAO_COMPROVADO = "NAO_COMPROVADO"


def http_get(path, key, timeout=20):
    """Devolve (status, json|None). Nunca levanta por HTTP; erro de rede => status 0."""
    req = urllib.request.Request(API + path, headers={
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
        "User-Agent": "zevanory-receiving-key-certify/1",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read(2 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, None


def _domains(value):
    items = value if isinstance(value, list) else ([value] if value else [])
    out = []
    for it in items:
        if isinstance(it, dict):
            it = it.get("email") or it.get("address") or ""
        s = str(it or "").strip().lower()
        m = re.search(r"<([^<>]+)>", s)
        addr = (m.group(1) if m else s).strip()
        mm = EMAIL_RE.fullmatch(addr)
        if mm:
            out.append(mm.group(1))
    return out


def domain_match(detail):
    if not isinstance(detail, dict):
        return False
    return EXPECTED_DOMAIN in _domains(detail.get("to"))


def certify(key, reference_email_id, get=http_get):
    """Devolve (veredito, motivo, fatos categóricos). Não grava nada."""
    facts = {"list_status": None, "item_status": None, "domain_match": False}
    if not key:
        return NAO_COMPROVADO, "key_missing", facts
    ref = (reference_email_id or "").strip()
    if not ref:
        return NAO_COMPROVADO, "reference_missing", facts
    if not ID_RE.fullmatch(ref):
        return NAO_COMPROVADO, "reference_invalid", facts
    status, _ = get("/emails/receiving?limit=1", key)
    facts["list_status"] = status
    if status != 200:
        return NAO_COMPROVADO, "list_not_200", facts
    status, body = get("/emails/receiving/" + urllib.parse.quote(ref, safe=""), key)
    facts["item_status"] = status
    if status == 404:
        return NAO_COMPROVADO, "reference_not_found_other_account_or_expired", facts
    if status != 200:
        return NAO_COMPROVADO, "item_not_200", facts
    facts["domain_match"] = domain_match(body)
    if not facts["domain_match"]:
        return NAO_COMPROVADO, "domain_mismatch", facts
    return COMPROVADO, "ok", facts


def wrangler_put(key):
    """Grava a chave no KV privado via arquivo temporário 0600 (mkstemp; nunca argv nem stdout)."""
    fd, path = tempfile.mkstemp()
    try:
        with os.fdopen(fd, "w") as f:
            f.write(key)
        r = subprocess.run(["npx", "--yes", WRANGLER, "kv", "key", "put", KV_KEY,
                            "--namespace-id", KV_NAMESPACE_ID, "--path", path, "--remote"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return r.returncode == 0
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def run(key, reference_email_id, get=http_get, writer=wrangler_put, out=print):
    verdict, reason, facts = certify(key, reference_email_id, get)
    out("RESEND_RECEIVING_LIST_STATUS=%s" % facts["list_status"])
    out("RESEND_RECEIVING_REFERENCE_STATUS=%s" % facts["item_status"])
    out("RESEND_RECEIVING_DOMAIN_MATCH=%s" % ("true" if facts["domain_match"] else "false"))
    out("RESEND_RECEIVING_KEY_CERT=%s reason=%s" % (verdict, reason))
    if verdict != COMPROVADO:
        out("WORKER_KV_RESEND_RECEIVING_KEY=UNCHANGED")
        return 2
    if not writer(key):
        out("WORKER_KV_RESEND_RECEIVING_KEY=WRITE_FAILED")
        return 3
    out("WORKER_KV_RESEND_RECEIVING_KEY=SET")
    return 0


def main():
    return run(os.environ.get("RESEND_RECEIVING_KEY", ""), os.environ.get("REFERENCE_EMAIL_ID", ""))


if __name__ == "__main__":
    sys.exit(main())
