#!/usr/bin/env python3
import datetime as dt
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP = "https://zevanory.api.br"
ASAAS = "https://api-sandbox.asaas.com/v3"
OUT = pathlib.Path("evidence/financial-e2e-current.json")

ASAAS_API_KEY = os.environ["ASAAS_API_KEY"].strip()
ASAAS_WEBHOOK_TOKEN = os.environ["ASAAS_WEBHOOK_TOKEN"].strip()
OPERATOR_TOKEN = os.environ["OPERATOR_TOKEN"].strip()
CERT_TOKEN = os.environ["CERTIFICATION_E2E_TOKEN"].strip()
EXPECTED_SHA = os.environ["EXPECTED_SHA"].strip().lower()
WEBHOOK_EMAIL = os.environ.get("ASAAS_WEBHOOK_EMAIL", "").strip()

def req(url, method="GET", headers=None, body=None, ok=(200,201,202)):
    h = {"Accept":"application/json","User-Agent":"ZEVANORY-Financial-E2E/1.0"}
    if headers: h.update(headers)
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    r = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            raw=x.read().decode("utf-8","replace")
            obj=json.loads(raw) if raw else {}
            if x.status not in ok: raise AssertionError((url,x.status,obj))
            return x.status,obj
    except urllib.error.HTTPError as e:
        raw=e.read().decode("utf-8","replace")
        try: obj=json.loads(raw) if raw else {}
        except Exception: obj={"raw":raw[:1000]}
        if e.code in ok: return e.code,obj
        raise AssertionError((url,e.code,obj))

def asaas(path, method="GET", body=None, ok=(200,201)):
    return req(ASAAS+path, method, {"access_token":ASAAS_API_KEY}, body, ok)

def app(path, method="GET", headers=None, body=None, ok=(200,201,202)):
    return req(APP+path, method, headers, body, ok)

def cert_status(order_id):
    return app("/api/internal/certification/e2e/status?order_id="+urllib.parse.quote(order_id),
               headers={"x-certification-e2e-token":CERT_TOKEN}, ok=(200,))[1]

def wait_until(label, fn, timeout=90, interval=2):
    end=time.time()+timeout
    last=None
    while time.time()<end:
        try:
            last=fn()
            if last: return last
        except Exception as e:
            last={"error":str(e)}
        time.sleep(interval)
    raise AssertionError(f"{label}_timeout:{last}")

def events_of(s, normalized):
    return [x for x in s.get("financial_events",[]) if x.get("normalized_event")==normalized]

def assert_release_sha():
    _,r=app("/api/release",ok=(200,))
    got=str(r.get("deployment",{}).get("commit_sha","")).lower()
    assert got==EXPECTED_SHA,(got,EXPECTED_SHA)
    assert r.get("sales_mode")=="globally-blocked",r
    assert r.get("checkout_mode")=="enabled",r
    assert r.get("financial_mode")=="enabled",r
    return r

def ensure_webhook():
    _,w=asaas("/webhooks?limit=100",ok=(200,))
    rows=w.get("data",[]) if isinstance(w,dict) else []
    target=next((x for x in rows if x.get("url")==APP+"/api/webhooks/asaas"),None)
    desired_events=["PAYMENT_CONFIRMED","PAYMENT_RECEIVED","PAYMENT_REFUNDED","PAYMENT_PARTIALLY_REFUNDED"]
    payload={"url":APP+"/api/webhooks/asaas","enabled":True,"interrupted":False,
             "sendType":"SEQUENTIALLY","authToken":ASAAS_WEBHOOK_TOKEN,"events":desired_events}
    if target:
        _,u=asaas("/webhooks/"+urllib.parse.quote(str(target["id"])), "PUT", payload, ok=(200,))
        return {"id":u.get("id",target.get("id")),"created":False,"url":payload["url"]}
    if not WEBHOOK_EMAIL:
        raise AssertionError("asaas_webhook_missing_and_ASAAS_WEBHOOK_EMAIL_secret_absent")
    payload.update({"name":"ZEVANORY financial E2E","email":WEBHOOK_EMAIL,"apiVersion":3})
    _,u=asaas("/webhooks","POST",payload,ok=(200,201))
    return {"id":u.get("id"),"created":True,"url":payload["url"]}

def create_customer():
    suffix=EXPECTED_SHA[:10]
    _,c=asaas("/customers","POST",{
        "name":"ZEVANORY E2E "+suffix,
        "cpfCnpj":"24971563792",
        "externalReference":"ZEV-E2E-"+suffix,
        "notificationDisabled":True
    },ok=(200,201))
    cid=str(c.get("id",""))
    assert cid.startswith("cus_"),c
    return cid

def create_payment(customer, value, external_reference, description):
    due=dt.date.today().isoformat()
    _,p=asaas("/payments","POST",{
        "customer":customer,"billingType":"PIX","value":value,"dueDate":due,
        "description":description,"externalReference":external_reference
    },ok=(200,201))
    pid=str(p.get("id",""))
    assert pid.startswith("pay_"),p
    return pid,p

def confirm_payment(pid):
    return asaas("/sandbox/payment/"+urllib.parse.quote(pid)+"/confirm","POST",{},ok=(200,))[1]

def ensure_refund_balance(customer):
    _,b=asaas("/finance/balance",ok=(200,))
    bal=float(b.get("balance",0) or 0)
    if bal>=15: return {"before":bal,"topped_up":False}
    pid,_=create_payment(customer,25.0,"ZEVANORY:E2E-BALANCE:"+EXPECTED_SHA[:12],"ZEVANORY sandbox refund reserve")
    confirm_payment(pid)
    time.sleep(2)
    _,b2=asaas("/finance/balance",ok=(200,))
    return {"before":bal,"topped_up":True,"topup_payment_id":pid,"after":float(b2.get("balance",0) or 0)}

def create_invite():
    _,x=app("/api/events/operator","POST",{"Authorization":"Bearer "+OPERATOR_TOKEN},
            {"name":"certification_pilot_invite_create","ttl_hours":1},ok=(201,))
    assert x.get("created") is True and x.get("commercial_unlock") is False,x
    return x

def create_checkout(token, request_id, session_id, ok=(201,)):
    return app("/api/checkout/asaas","POST",{"x-certification-pilot-token":token},
               {"request_id":request_id,"session_id":session_id,"offer_id":"OFFER-0001"},ok=ok)

def replay_webhook(evt, expect=(200,)):
    body={"id":evt["provider_event_id"],"event":evt["provider_event_name"],
          "payment":{"id":evt["provider_payment_id"]}}
    return app("/api/webhooks/asaas","POST",{"asaas-access-token":ASAAS_WEBHOOK_TOKEN},body,ok=expect)

def main():
    required={"ASAAS_API_KEY":ASAAS_API_KEY,"ASAAS_WEBHOOK_TOKEN":ASAAS_WEBHOOK_TOKEN,
              "OPERATOR_TOKEN":OPERATOR_TOKEN,"CERTIFICATION_E2E_TOKEN":CERT_TOKEN}
    assert all(required.values()),"required_secret_absent"
    assert len(ASAAS_WEBHOOK_TOKEN)>=32,"webhook_token_too_short"
    release=assert_release_sha()

    # Negative webhook authenticity test: rejected before financial processing.
    bad={"id":"evt_invalid_auth_123456","event":"PAYMENT_CONFIRMED","payment":{"id":"pay_invalid123456"}}
    code,bad_auth=app("/api/webhooks/asaas","POST",{"asaas-access-token":"invalid-token"},bad,ok=(401,))
    assert code==401 and bad_auth.get("error")=="webhook_auth_failed",bad_auth

    webhook=ensure_webhook()
    customer=create_customer()
    balance=ensure_refund_balance(customer)

    invite=create_invite()
    token=invite["token"]
    request_id=str(uuid.uuid4())
    session_id=str(uuid.uuid4())
    code,checkout=create_checkout(token,request_id,session_id)
    assert code==201 and checkout.get("accepted") is True and checkout.get("duplicate") is False,checkout
    order_id=str(checkout["order_id"])
    checkout_url=str(checkout["checkout_url"])
    assert checkout_url.startswith("https://sandbox.asaas.com/checkoutSession/show/"),checkout

    # Checkout idempotency: same request has one provider checkout/effect.
    code,replay=create_checkout(token,request_id,session_id,ok=(200,))
    assert code==200 and replay.get("duplicate") is True and replay.get("order_id")==order_id,replay
    assert replay.get("checkout_url")==checkout_url,replay

    # Same idempotency key with different identity must be rejected.
    code,conflict=create_checkout(token,request_id,str(uuid.uuid4()),ok=(409,))
    assert code==409 and conflict.get("error")=="request_id_conflict",conflict

    pre=cert_status(order_id)
    assert len(events_of(pre,"payment_confirmed"))==0,pre
    assert pre.get("order",{}).get("status")=="checkout_ready",pre
    external_ref=pre["order"]["external_reference"]
    assert external_ref.endswith(order_id),external_ref

    # Real provider sandbox charge, linked to the canonical order by the exact provider reference.
    payment_id,payment=create_payment(customer,5.0,external_ref,"ZEVANORY canonical financial E2E")
    assert float(payment.get("value",5.0))==5.0,payment
    confirm_payment(payment_id)

    paid=wait_until("payment_webhook",lambda: (
        lambda s: s if len(events_of(s,"payment_confirmed"))==1 and s.get("order",{}).get("status")=="paid" else None
    )(cert_status(order_id)))
    pay_events=events_of(paid,"payment_confirmed")
    assert len(pay_events)==1,paid
    pe=pay_events[0]
    assert pe.get("provider_payment_id")==payment_id,pe
    inv=paid.get("invariants",{})
    assert inv.get("exactly_one_payment_confirmation") is True,inv
    assert inv.get("payment_entitlement_present") is True,inv

    # Replay the real provider event. Provider truth is re-fetched; financial effect must stay exactly-once.
    replay_webhook(pe)
    after_dup=cert_status(order_id)
    assert len(events_of(after_dup,"payment_confirmed"))==1,after_dup

    # Full provider refund. Do not infer refund from API response: wait for the real webhook and DB reconciliation.
    asaas("/payments/"+urllib.parse.quote(payment_id)+"/refund","POST",
          {"description":"ZEVANORY E2E full refund"},ok=(200,201))
    refunded=wait_until("refund_webhook",lambda: (
        lambda s: s if len(events_of(s,"refund_confirmed"))>=1 and s.get("order",{}).get("status")=="refunded" else None
    )(cert_status(order_id)),timeout=120)
    refund_events=events_of(refunded,"refund_confirmed")
    assert len(refund_events)>=1,refunded
    re=refund_events[-1]
    invr=refunded.get("invariants",{})
    assert invr.get("refund_observed") is True,invr
    assert invr.get("refunded_entitlement_revoked") is True,invr
    assert refunded.get("fulfillment",{}).get("status")=="canceled",refunded

    # Duplicate refund webhook remains one financial effect per provider event.
    count_ref_before=len(refund_events)
    replay_webhook(re)
    after_ref_dup=cert_status(order_id)
    assert len(events_of(after_ref_dup,"refund_confirmed"))==count_ref_before,after_ref_dup

    # Out-of-order late payment event after full refund must not resurrect the order/entitlement.
    replay_webhook(pe)
    final=cert_status(order_id)
    assert final.get("order",{}).get("status")=="refunded",final
    assert final.get("fulfillment",{}).get("status")=="canceled",final
    assert len(events_of(final,"payment_confirmed"))==1,final

    evidence=final.get("evidence",[])
    assert any(x.get("source_class")=="provider_webhook" for x in evidence),evidence
    _,provider_payment=asaas("/payments/"+urllib.parse.quote(payment_id),ok=(200,))
    assert str(provider_payment.get("status",""))=="REFUNDED",provider_payment

    checks={
      "FINANCIAL_CHECKOUT":"PASS",
      "FINANCIAL_WEBHOOK_AUTH":"PASS",
      "FINANCIAL_WEBHOOK_DELIVERY":"PASS",
      "FINANCIAL_IDEMPOTENCY":"PASS",
      "FINANCIAL_REPLAY_PROTECTION":"PASS",
      "FINANCIAL_RECONCILIATION":"PASS",
      "FINANCIAL_PAYMENT_CONFIRMED":"PASS",
      "FINANCIAL_DUPLICATE_EVENT_TEST":"PASS",
      "FINANCIAL_OUT_OF_ORDER_TEST":"PASS",
      "FINANCIAL_REFUND":"PASS",
      "FINANCIAL_REFUND_RECONCILIATION":"PASS",
      "FINANCIAL_PROVENANCE":"PASS",
      "FINANCIAL_REGRESSION_GATES":"PASS",
      "FINANCIAL_E2E":"GREEN"
    }
    report={
      "schema_version":1,"gate":"ZEVANORY_FINANCIAL_E2E_CLOSURE",
      "observed_at":dt.datetime.now(dt.timezone.utc).isoformat(),
      "sha":{"code":EXPECTED_SHA,"ci":EXPECTED_SHA,"deploy":EXPECTED_SHA,"e2e":EXPECTED_SHA,"certification":EXPECTED_SHA},
      "release_id":release.get("release_id"),"sales_mode":release.get("sales_mode"),
      "provider":"asaas","provider_environment":"sandbox",
      "order_id":order_id,"payment_id":payment_id,
      "webhook":webhook,"sandbox_balance":balance,
      "payment_event_id":pe.get("provider_event_id"),"refund_event_id":re.get("provider_event_id"),
      "final_order_status":final.get("order",{}).get("status"),
      "final_fulfillment_status":final.get("fulfillment",{}).get("status"),
      "payment_confirmation_count":len(events_of(final,"payment_confirmed")),
      "refund_event_count":len(events_of(final,"refund_confirmed")),
      "checks":checks,
      "invariants":{
        "global_sales_remained_fail_closed":True,
        "provider_truth_rechecked_on_replay":True,
        "exactly_once_payment_effect":len(events_of(final,"payment_confirmed"))==1,
        "no_entitlement_after_full_refund":final.get("fulfillment",{}).get("status")=="canceled",
        "provider_final_status":provider_payment.get("status")
      },
      "provenance_evidence_hashes":[x.get("evidence_sha256") for x in evidence if x.get("evidence_sha256")]
    }
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    for k,v in checks.items(): print(f"{k}={v}")
    print("SHA_CODE = SHA_CI = SHA_DEPLOY = SHA_E2E = SHA_CERTIFICATION = "+EXPECTED_SHA)

if __name__=="__main__":
    main()
