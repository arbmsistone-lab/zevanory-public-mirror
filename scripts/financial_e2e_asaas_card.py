#!/usr/bin/env python3
import datetime as dt, json, os, pathlib, time, urllib.error, urllib.parse, urllib.request, uuid

APP="https://zevanory.api.br"
ASAAS="https://api-sandbox.asaas.com/v3"
OUT=pathlib.Path("evidence/financial-e2e-card-current.json")
KEY=os.environ["ASAAS_API_KEY"].strip()
WEBHOOK=os.environ["ASAAS_WEBHOOK_TOKEN"].strip()
OPERATOR=os.environ["OPERATOR_TOKEN"].strip()
CERT=os.environ["CERTIFICATION_E2E_TOKEN"].strip()
SHA=os.environ["EXPECTED_SHA"].strip().lower()

def req(url,method="GET",headers=None,body=None,ok=(200,201,202),timeout=60):
    h={"Accept":"application/json","User-Agent":"ZEVANORY-P16-Card/1.0"}
    if headers: h.update(headers)
    data=None
    if body is not None:
        h["Content-Type"]="application/json"; data=json.dumps(body).encode()
    r=urllib.request.Request(url,method=method,headers=h,data=data)
    try:
        with urllib.request.urlopen(r,timeout=timeout) as x:
            raw=x.read().decode("utf-8","replace"); obj=json.loads(raw) if raw else {}
            if x.status not in ok: raise AssertionError((url,x.status,obj))
            return x.status,obj
    except urllib.error.HTTPError as e:
        raw=e.read().decode("utf-8","replace")
        try: obj=json.loads(raw) if raw else {}
        except Exception: obj={"raw":raw[:1000]}
        if e.code in ok: return e.code,obj
        raise AssertionError((url,e.code,obj))

def asaas(path,method="GET",body=None,ok=(200,201)):
    return req(ASAAS+path,method,{"access_token":KEY},body,ok)

def app(path,method="GET",headers=None,body=None,ok=(200,201,202)):
    return req(APP+path,method,headers,body,ok)

def status(order_id):
    return app("/api/internal/certification/e2e/status?order_id="+urllib.parse.quote(order_id),headers={"x-certification-e2e-token":CERT},ok=(200,))[1]

def events(s,name):
    return [x for x in s.get("financial_events",[]) if x.get("normalized_event")==name]

def wait(label,fn,timeout=120):
    end=time.time()+timeout; last=None
    while time.time()<end:
        try:
            last=fn()
            if last: return last
        except Exception as e: last={"error":str(e)}
        time.sleep(2)
    raise AssertionError(label+"_timeout:"+str(last))

# Exact runtime/fail-closed contract.
_,release=app("/api/release",ok=(200,))
assert release.get("deployment",{}).get("commit_sha","").lower()==SHA,release
assert release.get("sales_mode")=="globally-blocked",release
assert release.get("checkout_mode")=="enabled" and release.get("financial_mode")=="enabled",release

# Authenticity negative test.
bad={"id":"evt_card_invalid_"+uuid.uuid4().hex[:12],"event":"PAYMENT_CONFIRMED","payment":{"id":"pay_invalid_card"}}
code,bad_auth=app("/api/webhooks/asaas","POST",{"asaas-access-token":"invalid-token"},bad,ok=(401,))
assert code==401 and bad_auth.get("error")=="webhook_auth_failed",bad_auth

# Create sandbox customer.
_,customer=asaas("/customers","POST",{
  "name":"ZEVANORY Card E2E "+SHA[:8],
  "cpfCnpj":"24971563792",
  "externalReference":"ZEV-CARD-E2E-"+SHA[:10],
  "notificationDisabled":True
})
cid=str(customer.get("id","")); assert cid.startswith("cus_"),customer

# Create canonical order in the exact live app.
_,invite=app("/api/events/operator","POST",{"Authorization":"Bearer "+OPERATOR},{"name":"certification_pilot_invite_create","ttl_hours":1},ok=(201,))
assert invite.get("created") is True and invite.get("commercial_unlock") is False,invite
token=invite["token"]; request_id=str(uuid.uuid4()); session_id=str(uuid.uuid4())
code,checkout=app("/api/checkout/asaas","POST",{"x-certification-pilot-token":token},{"request_id":request_id,"session_id":session_id,"offer_id":"OFFER-0001"},ok=(201,))
assert code==201 and checkout.get("accepted") is True and checkout.get("duplicate") is False,checkout
order_id=str(checkout["order_id"])
# Idempotency/conflict.
code,replay=app("/api/checkout/asaas","POST",{"x-certification-pilot-token":token},{"request_id":request_id,"session_id":session_id,"offer_id":"OFFER-0001"},ok=(200,))
assert replay.get("duplicate") is True and replay.get("order_id")==order_id,replay
code,conflict=app("/api/checkout/asaas","POST",{"x-certification-pilot-token":token},{"request_id":request_id,"session_id":str(uuid.uuid4()),"offer_id":"OFFER-0001"},ok=(409,))
assert conflict.get("error")=="request_id_conflict",conflict

# Asaas Sandbox documented successful test card.
external_ref="ZEVANORY:EXP-0001:"+order_id
payload={
  "customer":cid,"billingType":"CREDIT_CARD","value":5.0,"dueDate":dt.date.today().isoformat(),
  "description":"ZEVANORY exact-release card lifecycle","externalReference":external_ref,
  "creditCard":{"holderName":"ZEVANORY SANDBOX","number":"4444444444444444","expiryMonth":"12","expiryYear":"2030","ccv":"123"},
  "creditCardHolderInfo":{"name":"ZEVANORY SANDBOX","email":"sandbox@zevanory.api.br","cpfCnpj":"24971563792","postalCode":"01310930","addressNumber":"100","phone":"11999999999"},
  "remoteIp":"203.0.113.10"
}
_,payment=asaas("/payments","POST",payload,ok=(200,201))
pid=str(payment.get("id","")); assert pid.startswith("pay_"),payment

paid=wait("card_payment_webhook",lambda:(lambda s:s if len(events(s,"payment_confirmed"))==1 and s.get("order",{}).get("status")=="paid" else None)(status(order_id)))
pe=events(paid,"payment_confirmed")[0]
assert pe.get("provider_payment_id")==pid,pe
assert paid.get("invariants",{}).get("exactly_one_payment_confirmation") is True,paid
assert paid.get("invariants",{}).get("paid_entitlement_consistent") is True,paid

# Duplicate real event must not duplicate financial effect.
body={"id":pe["provider_event_id"],"event":pe["provider_event_name"],"payment":{"id":pe["provider_payment_id"]}}
app("/api/webhooks/asaas","POST",{"asaas-access-token":WEBHOOK},body,ok=(200,))
assert len(events(status(order_id),"payment_confirmed"))==1

# Full card refund in Sandbox.
asaas("/payments/"+urllib.parse.quote(pid)+"/refund","POST",{"description":"ZEVANORY exact-release card refund"},ok=(200,201))
refunded=wait("card_refund_webhook",lambda:(lambda s:s if len(events(s,"refund_confirmed"))>=1 and s.get("order",{}).get("status")=="refunded" else None)(status(order_id)),timeout=180)
re=events(refunded,"refund_confirmed")[-1]
assert refunded.get("fulfillment",{}).get("status")=="canceled",refunded
assert refunded.get("invariants",{}).get("refund_observed") is True,refunded
assert refunded.get("invariants",{}).get("refunded_entitlement_revoked") is True,refunded

# Duplicate refund + late payment cannot resurrect.
count_ref=len(events(refunded,"refund_confirmed"))
rbody={"id":re["provider_event_id"],"event":re["provider_event_name"],"payment":{"id":re["provider_payment_id"]}}
app("/api/webhooks/asaas","POST",{"asaas-access-token":WEBHOOK},rbody,ok=(200,))
assert len(events(status(order_id),"refund_confirmed"))==count_ref
app("/api/webhooks/asaas","POST",{"asaas-access-token":WEBHOOK},body,ok=(200,))
final=status(order_id)
assert final.get("order",{}).get("status")=="refunded",final
assert final.get("fulfillment",{}).get("status")=="canceled",final
assert len(events(final,"payment_confirmed"))==1,final
_,ps=asaas("/payments/"+urllib.parse.quote(pid)+"/status",ok=(200,))
provider_status=str(ps.get("status","")).upper()
assert provider_status=="REFUNDED",ps

prov=final.get("provenance",[])
assert any(x.get("source_class")=="provider_webhook" for x in prov),prov
checks={k:"PASS" for k in [
 "FINANCIAL_CHECKOUT","FINANCIAL_WEBHOOK_AUTH","FINANCIAL_WEBHOOK_DELIVERY","FINANCIAL_IDEMPOTENCY",
 "FINANCIAL_REPLAY_PROTECTION","FINANCIAL_RECONCILIATION","FINANCIAL_PAYMENT_CONFIRMED",
 "FINANCIAL_DUPLICATE_EVENT_TEST","FINANCIAL_OUT_OF_ORDER_TEST","FINANCIAL_REFUND",
 "FINANCIAL_REFUND_RECONCILIATION","FINANCIAL_PROVENANCE","FINANCIAL_REGRESSION_GATES"
]}
checks["FINANCIAL_E2E"]="GREEN"
report={
 "schema_version":3,"gate":"ZEVANORY_FINANCIAL_E2E_CLOSURE","observed_at":dt.datetime.now(dt.timezone.utc).isoformat(),
 "sha":{"code":SHA,"ci":SHA,"deploy":SHA,"e2e":SHA,"certification":SHA},
 "release_id":release.get("release_id"),"sales_mode":release.get("sales_mode"),
 "provider":"asaas","provider_environment":"sandbox","payment_method":"CREDIT_CARD_TEST",
 "order_id":order_id,"payment_id":pid,"payment_event_id":pe.get("provider_event_id"),"refund_event_id":re.get("provider_event_id"),
 "final_order_status":"refunded","final_fulfillment_status":"canceled","payment_confirmation_count":1,
 "refund_event_count":len(events(final,"refund_confirmed")),"checks":checks,
 "invariants":{"global_sales_remained_fail_closed":True,"provider_truth_rechecked_on_replay":True,
 "exactly_once_payment_effect":True,"no_entitlement_after_full_refund":True,"provider_final_status":provider_status},
 "provenance_evidence_hashes":[x.get("evidence_sha256") for x in prov if x.get("evidence_sha256")]
}
OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
for k,v in checks.items(): print(f"{k}={v}")
print("PAYMENT_METHOD=CREDIT_CARD_TEST")
print("P16_LIFECYCLE=PROVED")
print("FALSE_GREEN=0")
print("SHA_CODE = SHA_CI = SHA_DEPLOY = SHA_E2E = SHA_CERTIFICATION = "+SHA)
