#!/usr/bin/env python3
"""Read-only Mercado Pago production reconciliation. Never print provider response bodies."""
import datetime,json,os,sys,urllib.parse,urllib.request,urllib.error
START="2026-10-02T00:00:00-03:00"
API="https://api.mercadopago.com/v1/payments/search"
APP="https://zevanory.api.br"
token=os.environ.get("MERCADOPAGO_PROD_ACCESS_TOKEN","").strip()
cert=os.environ.get("CERTIFICATION_E2E_TOKEN","").strip()
if not token or not cert:sys.exit("MISSING_REQUIRED_SECRETS")
def fetch_json(url,headers):
    req=urllib.request.Request(url,headers=headers,method="GET")
    try:
        with urllib.request.urlopen(req,timeout=25) as res:return json.loads(res.read())
    except urllib.error.HTTPError as e:raise RuntimeError("HTTP_"+str(e.code)) from None
    except Exception:raise RuntimeError("READ_REQUEST_FAILED") from None
def amount(x):
    try:return round(float(x),2)
    except Exception:return None
now=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))
end=now.isoformat(timespec="seconds")
start=datetime.datetime.fromisoformat(START)
rows=[];offset=0;limit=50;seen=set()
while True:
    params=urllib.parse.urlencode({"range":"date_created","begin_date":START,"end_date":end,"sort":"date_created","criteria":"asc","limit":limit,"offset":offset})
    response=fetch_json(API+"?"+params,{"Authorization":"Bearer "+token,"Accept":"application/json"})
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
        order_id=ref.split(":")[-1] if ref.startswith("ZEVANORY:") else ref
        reconciled=False;reason="ORDER_NOT_VERIFIED"
        if not order_id or not all(c.isalnum() or c in "-_" for c in order_id) or len(order_id)>100:
            reason="NO_VALID_ORDER_REFERENCE"
        else:
            try:
                url=APP+"/api/internal/certification/e2e/status?"+urllib.parse.urlencode({"order_id":order_id})
                state=fetch_json(url,{"x-certification-e2e-token":cert,"Accept":"application/json"})
                order=state.get("order") or {}
                persisted=amount(order.get("amount"))
                if str(order.get("order_id") or order.get("id") or "").lower()==order_id.lower() and persisted is not None and val==persisted:
                    reconciled=True;reason="ORDER_AMOUNT_MATCH"
                else:reason="ORDER_MISSING_OR_AMOUNT_MISMATCH"
            except Exception:reason="ORDER_LOOKUP_FAILED"
        rows.append({"payment_id":pid,"data":date,"valor":val,"status":status,"external_reference":ref,"concilia_mesmo_valor":reconciled,"motivo":reason})
    offset+=len(items)
    if offset>=total:break
    if not items:sys.exit("INCOMPLETE_PAGINATION")
    if offset>100000:sys.exit("PAGINATION_SAFETY_BOUND")
rows.sort(key=lambda x:(x["data"],x["payment_id"]))
report={"begin_date":START,"end_date":end,"total_pagamentos":len(rows),"aprovados_sem_conciliacao":sum(x["status"]=="approved" and not x["concilia_mesmo_valor"] for x in rows),"pagamentos":rows}
with open("mercadopago-readonly-sanitized.json","w",encoding="utf-8") as f:json.dump(report,f,ensure_ascii=False,indent=2)
print("payment_id | data | valor | status | external_reference | concilia_mesmo_valor | motivo")
for x in rows:print(" | ".join(str(x[k]) for k in ("payment_id","data","valor","status","external_reference","concilia_mesmo_valor","motivo")))
print("APPROVED_UNRECONCILED_COUNT="+str(report["aprovados_sem_conciliacao"]))
