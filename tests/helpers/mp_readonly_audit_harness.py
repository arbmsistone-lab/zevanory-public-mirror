#!/usr/bin/env python3
"""Harness R9 B / auditoria Sol 174 (sem rede, sem segredo real): executa scripts/mercadopago_readonly_payments_audit.py
REAL com urllib.request.urlopen substituído por um servidor simulado, e imprime HARNESS_RESULT <json> com cada
requisição feita (método, host, caminho, cabeçalhos relevantes) e o relatório sanitizado gerado.

Cenário fixo: 4 pagamentos aprovados de produção no período (um casa com pedido e valor; um pedido existe com valor
diferente; um pedido não existe; uma referência não é UUID) e uma consulta de pagamento específico.
O "Worker" simulado responde a rota de produção somente leitura /api/internal/audit/order-lookup; qualquer outra rota
do Worker (incluindo a do piloto, /api/internal/certification/e2e/status) responde 409, como a produção sem piloto.
Uso: python3 -I -B tests/helpers/mp_readonly_audit_harness.py <raiz-do-repo>
"""
import datetime, io, json, os, runpy, sys, tempfile, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
OP = "synthetic-production-operator-token-0123456789ab"
O_MATCH = "2a3b4c5d-0000-4000-8000-00000000b001"
O_DIFF = "2a3b4c5d-0000-4000-8000-00000000b002"
O_MISSING = "2a3b4c5d-0000-4000-8000-00000000b0ff"
ORDERS = {O_MATCH: {"order_id": O_MATCH, "amount": 197.0, "currency": "BRL", "status": "paid", "provider": "mercadopago", "certification_pilot": False},
          O_DIFF: {"order_id": O_DIFF, "amount": 97.0, "currency": "BRL", "status": "paid", "provider": "mercadopago", "certification_pilot": False}}
when = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=6)).isoformat(timespec="seconds").replace("+00:00", "Z")
PAYMENTS = [
    {"id": 9001, "date_created": when, "external_reference": "ZEVANORY:" + O_MATCH, "transaction_amount": 197.0, "status": "approved"},
    {"id": 9002, "date_created": when, "external_reference": "ZEVANORY:" + O_DIFF, "transaction_amount": 197.0, "status": "approved"},
    {"id": 9003, "date_created": when, "external_reference": "ZEVANORY:" + O_MISSING, "transaction_amount": 197.0, "status": "approved"},
    {"id": 9004, "date_created": when, "external_reference": "pedido-livre-sem-uuid", "transaction_amount": 50.0, "status": "approved"},
]
calls = []


class Resp(io.BytesIO):
    def __init__(self, data, status=200):
        super().__init__(json.dumps(data).encode())
        self.status = status
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def fake_urlopen(req, timeout=None):
    url = urllib.parse.urlsplit(req.full_url)
    headers = {k.lower(): v for k, v in req.header_items()}
    calls.append({"method": req.get_method(), "host": url.hostname, "path": url.path, "query": urllib.parse.parse_qs(url.query),
                  "operator_header": headers.get("x-certification-e2e-token") == OP, "has_body": req.data is not None})
    if url.hostname == "api.mercadopago.com" and url.path == "/v1/payments/search":
        return Resp({"results": PAYMENTS, "paging": {"total": len(PAYMENTS)}})
    if url.hostname == "api.mercadopago.com" and url.path.startswith("/v1/payments/"):
        raise urllib.error.HTTPError(req.full_url, 404, "nf", {}, None)
    if url.hostname == "zevanory.api.br" and url.path == "/api/internal/audit/order-lookup":
        if req.get_method() != "GET" or headers.get("x-certification-e2e-token") != OP:
            raise urllib.error.HTTPError(req.full_url, 401, "unauthorized", {}, None)
        ids = urllib.parse.parse_qs(url.query).get("order_id", [])
        return Resp({"schema": "zevanory.audit.order-lookup/v1", "read_only": True, "requested": len(ids),
                     "orders": [ORDERS[i] for i in ids if i in ORDERS], "missing": [i for i in ids if i not in ORDERS]})
    # Produção sem piloto: a rota do piloto recusa (certification_e2e_not_fail_closed).
    raise urllib.error.HTTPError(req.full_url, 409, "conflict", {}, None)


def main():
    urllib.request.urlopen = fake_urlopen
    os.environ.update({"MERCADOPAGO_PROD_ACCESS_TOKEN": "APP_USR-synthetic", "ZEVANORY_OPERATOR_TOKEN": OP, "MP_LOOKUP_PAYMENT_IDS": "182085091992"})
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp:
        cwd = os.getcwd()
        os.chdir(tmp)
        real_stdout, real_exit = sys.stdout, sys.exit
        code = 0
        try:
            sys.stdout = out
            runpy.run_path(str(ROOT / "scripts" / "mercadopago_readonly_payments_audit.py"), run_name="__main__")
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
        finally:
            sys.stdout, sys.exit = real_stdout, real_exit
            os.chdir(cwd)
        report_path = Path(tmp, "mercadopago-readonly-sanitized.json")
        report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
    reasons = {str(p["payment_id"]): [p["motivo"], p["concilia_mesmo_valor"]] for p in (report or {}).get("pagamentos", [])}
    print("HARNESS_RESULT " + json.dumps({"exit": code, "calls": calls, "reasons": reasons,
                                          "unreconciled": (report or {}).get("aprovados_sem_conciliacao"),
                                          "row_keys": sorted({k for p in (report or {}).get("pagamentos", []) for k in p}),
                                          "log_tail": out.getvalue()[-1500:]}))


if __name__ == "__main__":
    main()
