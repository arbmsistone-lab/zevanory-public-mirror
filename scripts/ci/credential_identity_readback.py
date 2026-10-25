#!/usr/bin/env python3
"""R9 (roteiro v4.7; Sol 164 §4.3): readback da identidade das credenciais do Worker de produção, só NOMES e CATEGORIAS.

Chama GET <base>/api/internal/audit/credential-identity (autenticado com a credencial de operador da produção, lida de
ZEVANORY_OPERATOR_TOKEN no runner) e imprime exatamente:
    OPERATOR_TOKEN_SOURCE=primary|legacy_fallback|absent|certification|unverified
    STRIPE_KEY_MODE=live|test|absent|unrecognized|unverified
    CERTIFICATION_PERIMETER=true|false|unverified
Nunca imprime o token, o corpo da resposta, tamanhos ou hashes. A classificação da chave Stripe é feita DENTRO do Worker
pelo prefixo (sk_/rk_ + live_/test_, https://docs.stripe.com/api/authentication); aqui só se valida o enum.

Falha fechada (exit 1) quando: STRIPE_KEY_MODE não é live nem absent (test, unrecognized, unverified); o Worker se
declara perímetro de certificação; a resposta não é 200 ou não é o schema esperado; e, com --require-primary, quando
OPERATOR_TOKEN_SOURCE != primary (pré-condição para retirar a queda para CERTIFICATION_E2E_TOKEN).
Exit 2: uso inválido (token ausente). Sem dependências além da biblioteca padrão.
Uso: credential_identity_readback.py BASE_URL [--require-primary] [--attempts N]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

PATH = "/api/internal/audit/credential-identity"
SCHEMA = "zevanory.audit.credential-identity/v1"
SOURCES = {"primary", "legacy_fallback", "absent", "certification"}
STRIPE_MODES = {"live", "test", "absent", "unrecognized"}
STRIPE_ALLOWED = {"live", "absent"}


def fetch(base, token, timeout=20):
    req = urllib.request.Request(base.rstrip("/") + PATH, method="GET",
                                 headers={"x-certification-e2e-token": token, "accept": "application/json",
                                          "user-agent": "zevanory-r9-credential-readback"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, res.read(65536)
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:  # rede: categoria só
        return 0, b""


def classify(status, raw):
    out = {"OPERATOR_TOKEN_SOURCE": "unverified", "STRIPE_KEY_MODE": "unverified", "CERTIFICATION_PERIMETER": "unverified",
           "HTTP": str(status)}
    if status != 200:
        return out
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception:
        return out
    if not isinstance(body, dict) or body.get("schema") != SCHEMA:
        return out
    src, mode, perim = body.get("operator_token_source"), body.get("stripe_key_mode"), body.get("certification_perimeter")
    out["OPERATOR_TOKEN_SOURCE"] = src if src in SOURCES else "unverified"
    out["STRIPE_KEY_MODE"] = mode if mode in STRIPE_MODES else "unverified"
    out["CERTIFICATION_PERIMETER"] = "true" if perim is True else "false" if perim is False else "unverified"
    return out


def verdict(out, require_primary=False):
    reasons = []
    if out["STRIPE_KEY_MODE"] not in STRIPE_ALLOWED:
        reasons.append("STRIPE_KEY_NOT_LIVE_OR_ABSENT")
    if out["CERTIFICATION_PERIMETER"] != "false":
        reasons.append("PRODUCTION_PERIMETER_UNPROVEN")
    if out["OPERATOR_TOKEN_SOURCE"] == "unverified":
        reasons.append("READBACK_UNVERIFIED")
    if require_primary and out["OPERATOR_TOKEN_SOURCE"] != "primary":
        reasons.append("OPERATOR_TOKEN_NOT_PRIMARY")
    return reasons


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    require_primary = "--require-primary" in args
    attempts = 3
    if "--attempts" in args:
        i = args.index("--attempts")
        attempts = max(1, int(args[i + 1]))
        del args[i:i + 2]
    pos = [a for a in args if not a.startswith("--")]
    if len(pos) != 1:
        print("usage: credential_identity_readback.py BASE_URL [--require-primary] [--attempts N]")
        return 2
    token = os.environ.get("ZEVANORY_OPERATOR_TOKEN", "")
    if not token:
        print("OPERATOR_TOKEN_IN_RUNNER=absent")
        return 2
    out = None
    for n in range(attempts):
        out = classify(*fetch(pos[0], token))
        if out["HTTP"] == "200" or out["HTTP"] in ("401", "403"):
            break
        if n + 1 < attempts:
            time.sleep(min(10, 2 * (n + 1)))
    for key in ("OPERATOR_TOKEN_SOURCE", "STRIPE_KEY_MODE", "CERTIFICATION_PERIMETER"):
        print(f"{key}={out[key]}")
    print(f"READBACK_HTTP={out['HTTP']}")
    reasons = verdict(out, require_primary)
    if reasons:
        for r in reasons:
            print(f"::error title=R9_CREDENTIAL_IDENTITY::{r}")
        print("R9_CREDENTIAL_IDENTITY=FAIL")
        return 1
    print("R9_CREDENTIAL_IDENTITY=PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
