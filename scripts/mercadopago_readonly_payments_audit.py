#!/usr/bin/env python3
"""Read-only Mercado Pago production reconciliation. Never print provider response bodies."""
import datetime,json,os,re,sys,urllib.parse,urllib.request,urllib.error
_exit=sys.exit
def _fail(code):
    # Only fixed error codes reach the public log/annotations, never provider bodies or data.
    print("::error title=MP_READONLY_AUDIT::"+str(code)[:120],flush=True)
    _exit(1)
sys.exit=_fail
START="2026-10-02T00:00:00-03:00"  # exact window enforced locally; API window is NOW-7DAYS..NOW
API="https://api.mercadopago.com/v1/payments/search"
APP="https://zevanory.api.br"
ORDER_LOOKUP_PATH="/api/internal/audit/order-lookup"
ORDER_LOOKUP_BATCH=40  # = ORDER_LOOKUP_MAX do Worker (worker/internal-financial-audit.mjs)
ORDER_UUID=re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
token=os.environ.get("MERCADOPAGO_PROD_ACCESS_TOKEN","").strip()
cert=os.environ.get("ZEVANORY_OPERATOR_TOKEN","").strip()
if not token:sys.exit("MISSING_MERCADOPAGO_PROD_ACCESS_TOKEN")
if not cert:sys.exit("MISSING_ZEVANORY_OPERATOR_TOKEN")
def fetch_json(url,headers):
    req=urllib.request.Request(url,headers=headers,method="GET")
    try:
        with urllib.request.urlopen(req,timeout=25) as res:return json.loads(res.read())
    except urllib.error.HTTPError as e:raise RuntimeError("HTTP_"+str(e.code)) from None
    except Exception as e:raise RuntimeError("READ_REQUEST_FAILED_"+type(e).__name__) from None
def amount(x):
    try:return round(float(x),2)
    except Exception:return None
now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))
end=now.isoformat(timespec="seconds")
start=datetime.datetime.fromisoformat(START)
rows=[];offset=0;limit=50;seen=set()
while True:
    params=urllib.parse.urlencode({"range":"date_created","begin_date":"NOW-7DAYS","end_date":"NOW","sort":"date_created","criteria":"asc","limit":limit,"offset":offset})
    try:response=fetch_json(API+"?"+params,{"Authorization":"Bearer "+token,"Accept":"application/json"})
    except RuntimeError as e:sys.exit("PAYMENTS_SEARCH_"+str(e))
    items=response.get("results")
    if not isinstance(items,list):sys.exit("INVALID_PAYMENTS_RESPONSE")
    paging=response.get("paging") or {}
    total=paging.get("total")
    if not isinstance(total,int) or total<0:sys.exit("INVALID_PAGINATION_TOTAL")
    for p in items:
        pid=str(p.get("id") or "")
        if not pid or pid in seen:sys.exit("DUPLICATE_OR_MISSING_PAYMENT_ID")
        seen.add(pid)
        date=str(p.get("date_created") or "")
        try:created=datetime.datetime.fromisoformat(date.replace("Z","+00:00"))
        except Exception:sys.exit("INVALID_PAYMENT_DATE")
        if created<start or created>now:continue
        ref=str(p.get("external_reference") or "")[:160]
        val=amount(p.get("transaction_amount"))
        status=str(p.get("status") or "")[:48]
        order_id=(ref.split(":")[-1] if ref.startswith("ZEVANORY:") else ref).strip().lower()
        rows.append({"payment_id":pid,"data":date,"valor":val,"status":status,"external_reference":ref,"concilia_mesmo_valor":False,
                     "motivo":"ORDER_NOT_VERIFIED" if ORDER_UUID.fullmatch(order_id) else "NO_VALID_ORDER_REFERENCE","_order_id":order_id})
    offset+=len(items)
    if offset>=total:break
    if not items:sys.exit("INCOMPLETE_PAGINATION")
    if offset>100000:sys.exit("PAGINATION_SAFETY_BOUND")
# R9 B (auditoria Sol 174): pedidos lidos pela rota de PRODUÇÃO somente leitura /api/internal/audit/order-lookup
# (credencial de operador, só GET, transação READ ONLY no Worker). Não usa mais /api/internal/certification/e2e/status,
# que pertence ao piloto sandbox de certificação e recusa (409) quando o piloto não existe na produção.
pending=sorted({x["_order_id"] for x in rows if x["motivo"]=="ORDER_NOT_VERIFIED"})
found={};failed=set()
for i in range(0,len(pending),ORDER_LOOKUP_BATCH):
    batch=pending[i:i+ORDER_LOOKUP_BATCH]
    try:
        state=fetch_json(APP+ORDER_LOOKUP_PATH+"?"+urllib.parse.urlencode([("order_id",x) for x in batch]),{"x-certification-e2e-token":cert,"Accept":"application/json"})
        if state.get("schema")!="zevanory.audit.order-lookup/v1" or state.get("read_only") is not True or not isinstance(state.get("orders"),list):raise RuntimeError("INVALID_ORDER_LOOKUP")
        for o in state["orders"]:
            oid=str((o or {}).get("order_id") or "").lower()
            if oid in batch:found[oid]=o
    except Exception:failed.update(batch)
for x in rows:
    oid=x.pop("_order_id")
    if x["motivo"]!="ORDER_NOT_VERIFIED":continue
    if oid in failed:x["motivo"]="ORDER_LOOKUP_FAILED";continue
    persisted=amount((found.get(oid) or {}).get("amount"))
    if oid in found and persisted is not None and x["valor"]==persisted:x["concilia_mesmo_valor"]=True;x["motivo"]="ORDER_AMOUNT_MATCH"
    else:x["motivo"]="ORDER_MISSING_OR_AMOUNT_MISMATCH"
rows.sort(key=lambda x:(x["data"],x["payment_id"]))
report={"begin_date":START,"end_date":end,"total_pagamentos":len(rows),"aprovados_sem_conciliacao":sum(x["status"]=="approved" and not x["concilia_mesmo_valor"] for x in rows),"pagamentos":rows}
with open("mercadopago-readonly-sanitized.json","w",encoding="utf-8") as f:json.dump(report,f,ensure_ascii=False,indent=2)
# Public repository: Actions logs are world-readable. Never print per-payment rows,
# amounts or references to the log; the table lives only in the short-lived artifact.
print("TOTAL_PAYMENTS="+str(report["total_pagamentos"]))
print("APPROVED_COUNT="+str(sum(x["status"]=="approved" for x in rows)))
print("APPROVED_UNRECONCILED_COUNT="+str(report["aprovados_sem_conciliacao"]))
statuses={}
for x in rows:statuses[x["status"]]=statuses.get(x["status"],0)+1
print("::notice title=MP_READONLY_SUMMARY::total="+str(len(rows))+" por_status="+json.dumps(statuses,sort_keys=True)+" aprovados_sem_conciliacao="+str(report["aprovados_sem_conciliacao"]))
# Only exceptions are surfaced (payment id, date, amount, reason); full table stays in the 1-day artifact.
for x in rows:
    if x["status"]=="approved" and not x["concilia_mesmo_valor"]:
        print("::warning title=MP_APPROVED_UNRECONCILED::payment_id="+x["payment_id"]+" data="+x["data"][:19]+" valor="+str(x["valor"])+" motivo="+x["motivo"])

# Read-only lookup of specific payment ids (e.g. issue #307) in the PRODUCTION account.
# 404 means the payment does not exist in production (e.g. it was made with test credentials).
for lookup_id in [x for x in os.environ.get("MP_LOOKUP_PAYMENT_IDS","").split(",") if x.strip().isdigit()][:5]:
    lookup_id=lookup_id.strip()
    try:
        p=fetch_json("https://api.mercadopago.com/v1/payments/"+lookup_id,{"Authorization":"Bearer "+token,"Accept":"application/json"})
        print("::notice title=MP_PAYMENT_LOOKUP::payment_id="+lookup_id+" producao=encontrado status="+str(p.get("status") or "")[:32]+" valor="+str(amount(p.get("transaction_amount")))+" live_mode="+str(p.get("live_mode")).lower())
    except RuntimeError as e:
        print("::notice title=MP_PAYMENT_LOOKUP::payment_id="+lookup_id+" producao="+("nao_existe" if str(e)=="HTTP_404" else str(e)))
