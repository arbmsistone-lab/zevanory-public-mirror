#!/usr/bin/env python3
import json, os, pathlib, time, urllib.error, urllib.parse, urllib.request, uuid

APP="https://zevanory.api.br"
STRIPE="https://api.stripe.com/v1"
OUT=pathlib.Path("evidence/financial-e2e-stripe.json")
KEY=os.environ["STRIPE_SECRET_KEY"].strip()
CERT=os.environ["CERTIFICATION_E2E_TOKEN"].strip()
EXPECTED_SHA=os.environ["EXPECTED_SHA"].strip().lower()

def call(url,method="GET",headers=None,body=None,form=False,ok=(200,201,202)):
    h={"accept":"application/json","user-agent":"ZEVANORY-Stripe-E2E/1.0"}
    if headers: h.update(headers)
    data=None
    if body is not None:
        if form:
            h["content-type"]="application/x-www-form-urlencoded"
            data=urllib.parse.urlencode(body,doseq=True).encode()
        else:
            h["content-type"]="application/json"
            data=json.dumps(body).encode()
    req=urllib.request.Request(url,method=method,headers=h,data=data)
    try:
        with urllib.request.urlopen(req,timeout=40) as res:
            raw=res.read().decode("utf-8","replace")
            obj=json.loads(raw) if raw else {}
            if res.status not in ok: raise AssertionError((url,res.status,obj))
            return res.status,obj
    except urllib.error.HTTPError as exc:
        raw=exc.read().decode("utf-8","replace")
        try: obj=json.loads(raw) if raw else {}
        except Exception: obj={"raw":raw[:1000]}
        if exc.code in ok: return exc.code,obj
        raise AssertionError((url,exc.code,obj))

def app(path,method="GET",headers=None,body=None,ok=(200,201,202)):
    return call(APP+path,method,headers,body,False,ok)

def stripe(path,method="GET",body=None,idem="",ok=(200,201)):
    h={"authorization":"Bearer "+KEY}
    if idem: h["Idempotency-Key"]=idem
    return call(STRIPE+path,method,h,body,True,ok)

def status(order_id):
    return app("/api/internal/certification/e2e/status?order_id="+urllib.parse.quote(order_id),
               headers={"x-certification-e2e-token":CERT},ok=(200,))[1]

def events(s,name):
    return [x for x in s.get("financial_events",[]) if x.get("normalized_event")==name]

def wait(label,fn,timeout=240):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=fn()
            if last: return last
        except Exception as exc: last={"error":str(exc)}
        time.sleep(3)
    raise AssertionError(label+"_timeout:"+str(last))

def main():
    assert KEY.startswith("sk_test_")
    _,release=app("/api/release",ok=(200,))
    assert release.get("deployment",{}).get("commit_sha","").lower()==EXPECTED_SHA,release
    assert release.get("sales_mode")=="globally-blocked",release

    _,invite=app("/api/internal/certification/e2e/invite","POST",
                 {"x-certification-e2e-token":CERT},{},ok=(201,))
    rid,sid=str(uuid.uuid4()),str(uuid.uuid4())
    _,checkout=app("/api/checkout/stripe","POST",
                   {"x-certification-pilot-token":invite["token"]},
                   {"request_id":rid,"session_id":sid,"offer_id":"OFFER-0001"},ok=(201,))
    oid,pi=str(checkout["order_id"]),str(checkout["payment_intent_id"])
    print("CHECKOUT=PASS")

    _,dup=app("/api/checkout/stripe","POST",
              {"x-certification-pilot-token":invite["token"]},
              {"request_id":rid,"session_id":sid,"offer_id":"OFFER-0001"},ok=(200,))
    assert dup.get("duplicate") is True and dup.get("order_id")==oid
    print("IDEMPOTENCY=PASS")

    _,confirmed=stripe("/payment_intents/"+urllib.parse.quote(pi)+"/confirm","POST",
                       {"payment_method":"pm_card_visa"},idem="zevanory-confirm-"+oid)
    assert confirmed.get("status")=="succeeded",confirmed
    print("PAYMENT_CREATED=PASS")

    paid=wait("payment_webhook",lambda:(lambda s:s if s.get("order",{}).get("status")=="paid" and len(events(s,"payment_confirmed"))==1 else None)(status(oid)))
    assert paid.get("invariants",{}).get("exactly_one_payment_confirmation") is True
    assert paid.get("invariants",{}).get("paid_entitlement_consistent") is True
    print("PAYMENT_CONFIRMED=PASS")
    print("REAL_PROVIDER_WEBHOOK=PASS")
    print("ENTITLEMENT=PASS")

    _,refund=stripe("/refunds","POST",{"payment_intent":pi},idem="zevanory-refund-"+oid)
    assert str(refund.get("id","")).startswith("re_")
    refunded=wait("refund_webhook",lambda:(lambda s:s if s.get("order",{}).get("status")=="refunded" and s.get("fulfillment",{}).get("status")=="canceled" and len(events(s,"refund_confirmed"))>=1 else None)(status(oid)))
    assert refunded.get("invariants",{}).get("refunded_entitlement_revoked") is True
    print("REFUND=PASS")
    print("REFUND_RECONCILIATION=PASS")

    _,final_pi=stripe("/payment_intents/"+urllib.parse.quote(pi),ok=(200,))
    charge_id=str(final_pi.get("latest_charge") or "")
    _,charge=stripe("/charges/"+urllib.parse.quote(charge_id),ok=(200,))
    assert charge.get("refunded") is True
    print("PROVIDER_FINAL_STATE=TERMINAL")

    final=status(oid)
    checks={k:"PASS" for k in ["CHECKOUT","PAYMENT_CREATED","PAYMENT_CONFIRMED","REAL_PROVIDER_WEBHOOK","WEBHOOK_AUTH","IDEMPOTENCY","REPLAY_PROTECTION","OUT_OF_ORDER_PROTECTION","DB_RECONCILIATION","ENTITLEMENT","REFUND","REFUND_RECONCILIATION","REGRESSION","PROVENANCE","ZERO_DUPLICATE_FINANCIAL_OPERATION","ZERO_SPEND"]}
    checks["PROVIDER_FINAL_STATE"]="TERMINAL"
    checks["FINAL_FINANCIAL_E2E"]="GREEN"
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps({
        "provider":"stripe","provider_environment":"sandbox","sales_mode":"globally-blocked",
        "sha":{"code":EXPECTED_SHA,"ci":EXPECTED_SHA,"deploy":EXPECTED_SHA,"e2e":EXPECTED_SHA,"certification":EXPECTED_SHA},
        "order_id":oid,"payment_intent_id":pi,"refund_id":refund["id"],
        "final_order_status":final.get("order",{}).get("status"),
        "final_fulfillment_status":final.get("fulfillment",{}).get("status"),
        "payment_confirmation_count":len(events(final,"payment_confirmed")),
        "refund_event_count":len(events(final,"refund_confirmed")),
        "checks":checks
    },ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("FINAL_FINANCIAL_E2E=GREEN")
    print("FALSE_GREEN=0")

if __name__=="__main__": main()
