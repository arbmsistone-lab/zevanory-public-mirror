#!/usr/bin/env python3
"""One manual sandbox purchase; provider webhook required; no synthesized webhook."""
import datetime as dt
import hashlib
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

OUT=pathlib.Path('evidence/mercadopago-combo-sandbox.json')
report={'gate':'COMBO_SANDBOX_E2E','sha':os.environ.get('EXPECTED_SHA'),'test_source_sha':os.environ.get('TEST_SOURCE_SHA'),'amount_brl':297,'sale_globally_enabled':False,'checks':{},'email_destination':'delivered@resend.dev','email_destination_kind':'resend_test_sink'}

def save():
    OUT.parent.mkdir(exist_ok=True);OUT.write_text(json.dumps(report,indent=2)+'\n')

def require(condition,cause):
    if not condition:raise RuntimeError(cause)

def req(url,method='GET',body=None,headers=None):
    h={'accept':'application/json','user-agent':'ZEVANORY-Combo-Sandbox/1.0',**(headers or {})}
    if body is not None:h['content-type']='application/json'
    data=json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url,method=method,headers=h,data=data),timeout=60) as r:
            raw=r.read();return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw=e.read().decode('utf-8','replace')[:1000]
        for value in [os.environ.get('MERCADOPAGO_TEST_ACCESS_TOKEN'),os.environ.get('CERTIFICATION_E2E_TOKEN'),os.environ.get('MERCADOPAGO_ACCESS_TOKEN')]:
            if value:raw=raw.replace(value,'[redacted]')
        raise RuntimeError(f'http_{e.code}:{urllib.parse.urlparse(url).path}:{raw}') from None

APP='https://zevanory.api.br'
TOKEN=os.environ.get('MERCADOPAGO_TEST_ACCESS_TOKEN','')
CERT=os.environ.get('CERTIFICATION_E2E_TOKEN','')
mp=lambda path,method='GET',body=None,extra=None:req('https://api.mercadopago.com'+path,method,body,{'authorization':'Bearer '+TOKEN,**(extra or {})})
app=lambda path,method='GET',body=None,headers=None:req(APP+path,method,body,headers)
status=lambda oid:app('/api/internal/certification/e2e/status?order_id='+urllib.parse.quote(oid),headers={'x-certification-e2e-token':CERT})
try:
    require(TOKEN and CERT,'required_sandbox_secrets_missing')
    release=app('/api/release')
    require(release.get('sales_mode')=='globally-blocked','sales_must_remain_blocked')
    require(release.get('deployment',{}).get('commit_sha')==os.environ['EXPECTED_SHA'],'exact_live_sha_required')
    seller=mp('/users/me')
    require(TOKEN.startswith('TEST-') or 'test_user' in seller.get('tags',[]),'sandbox_seller_required')
    report['seller_id']=seller.get('id');save()
    try:
        buyer=mp('/users/test','POST',{'site_id':'MLB','description':'ZEVANORY Combo sandbox buyer'})
        report['buyer_creation']='created'
    except RuntimeError as error:
        if '40311' not in str(error):raise
        creator=os.environ.get('MERCADOPAGO_ACCESS_TOKEN','').strip()
        if creator and creator!=TOKEN:
            account=req('https://api.mercadopago.com/users/me',headers={'authorization':'Bearer '+creator})
            if 'test_user' not in account.get('tags',[]):
                buyer=req('https://api.mercadopago.com/users/test','POST',{'site_id':'MLB','description':'ZEVANORY sandbox buyer'}, {'authorization':'Bearer '+creator})
                report['buyer_creation']='created_with_existing_productive_credential_no_payment'
            else:buyer=None
        else:buyer=None
        email=(buyer or {}).get('email') or os.environ.get('MERCADOPAGO_TEST_BUYER_EMAIL','').strip()
        if not (email.lower().endswith('@testuser.com') and email.lower()!=str(seller.get('email','')).lower()):
            # Official Checkout API sandbox payer; not a newly created account.
            email='test@testuser.com'
            report['buyer_creation']='blocked_40311_official_api_sandbox_payer'
            report['buyer_account_created']=False
        require(email.lower().endswith('@testuser.com') and email.lower()!=str(seller.get('email','')).lower(),'distinct_test_payer_required')
        buyer=buyer or {'id':None,'email':email}
        if not buyer.get('id') and report.get('buyer_creation')!='blocked_40311_official_api_sandbox_payer':report['buyer_creation']='blocked_40311_existing_test_buyer_reused'
        print('::warning title=MP_TEST_BUYER::'+report['buyer_creation'])
    require(str(buyer.get('email','')).endswith('@testuser.com'),'test_buyer_required')
    print('::add-mask::'+str(buyer.get('password','')))
    report['buyer_id']=buyer['id'];report['checks']['TEST_PAYER']='PASS';save()
    oid=os.environ.get('RESUME_ORDER_ID','').strip()
    if oid:
        report['resumed_order']=True
    else:
        invite=app('/api/internal/certification/e2e/invite','POST',{}, {'x-certification-e2e-token':CERT})
        require(invite.get('commercial_unlock') is False and invite.get('token'),'isolated_certification_invite_required')
        checkout=app('/api/checkout/mercadopago','POST',{'request_id':str(uuid.uuid4()),'session_id':str(uuid.uuid4()),'offer_id':'ZEV-CMB-011'}, {'x-certification-pilot-token':invite['token']})
        oid=checkout.get('order_id');require(oid and checkout.get('accepted'),'checkout_required')
    report['order_id']=oid;save()
    initial=status(oid);order=initial.get('order',{})
    require(float(order.get('amount',0))==297 and order.get('certification_pilot') is True,'combo_297_sandbox_order_required')
    pref=mp('/checkout/preferences/'+str(order.get('provider_checkout_id')))
    require(float(pref.get('items',[{}])[0].get('unit_price',0))==297,'checkout_preference_297_required')
    require(pref.get('external_reference')==oid,'checkout_preference_order_binding_required')
    report['preference_id']=pref.get('id');report['checks']['CHECKOUT']='PASS';save()
    card=mp('/v1/card_tokens','POST',{'card_number':'4235647728025682','security_code':'123','expiration_month':11,'expiration_year':2030,'cardholder':{'name':'APRO','identification':{'type':'CPF','number':'12345678909'}}})
    require(card.get('id') and card.get('status')=='active','official_test_card_token_required')
    payment=mp('/v1/payments','POST',{'transaction_amount':297,'token':card['id'],'description':'ZEVANORY Combo IA + Vendas sandbox','installments':1,'payment_method_id':'visa','binary_mode':True,'external_reference':oid,'notification_url':APP+'/api/webhooks?provider=mercadopago_test','payer':{'email':buyer['email'],'identification':{'type':'CPF','number':'12345678909'}},'metadata':{'zevanory_order_id':oid,'certification':True}}, {'x-idempotency-key':str(uuid.uuid4()),'x-test-token':'true'})
    report['payment_id']=str(payment.get('id',''));report['payment_status']=payment.get('status');save()
    require(payment.get('live_mode') is False and payment.get('status')=='approved','approved_test_payment_required')
    report['checks']['PAYMENT_APPROVED']='PASS';save()
    deadline=time.time()+240;state={}
    while time.time()<deadline:
        state=status(oid)
        if state.get('order',{}).get('status')=='paid' and state.get('delivery_evidence',{}).get('email_status')=='sent':break
        time.sleep(5)
    delivery=state.get('delivery_evidence') or {}
    ev=[x for x in state.get('financial_events',[]) if str(x.get('provider_payment_id'))==report['payment_id'] and x.get('normalized_event')=='payment_confirmed']
    require(ev and any(x.get('source_class')=='provider_webhook' for x in state.get('provenance',[])),'real_provider_webhook_required_no_local_replay')
    require(state.get('order',{}).get('status')=='paid','internal_order_paid_required')
    require(state.get('fulfillment',{}).get('status')=='delivered' and delivery.get('email_status')=='sent' and delivery.get('email_provider_id'),'resend_delivery_email_required')
    require(delivery.get('email_recipient')=='delivered@resend.dev','controlled_resend_test_sink_required')
    report['order_status']='paid';report['email_id']=delivery['email_provider_id'];report['webhook_events']=ev
    report['checks'].update({'PROVIDER_WEBHOOK':'PASS','ORDER_PAID':'PASS','EMAIL_SENT':'PASS'});save()
    expires=dt.datetime.fromisoformat(str(delivery.get('expires_at','')).replace('Z','+00:00'))
    remaining=(expires-dt.datetime.now(dt.timezone.utc)).total_seconds()
    require(0<remaining<=3600,'temporary_download_max_60_minutes_required')
    probe=str(delivery.get('verification_url',''))
    require(probe.startswith(APP+'/private/artifacts/download?token='),'trusted_download_probe_required')
    with urllib.request.urlopen(probe,timeout=60) as response:
        data=response.read();require(response.status==200 and data,'download_200_required')
        require(hashlib.sha256(data).hexdigest().lower()==str(delivery.get('artifact_sha256','')).lower(),'download_sha256_required')
    report['download_expires_at']=delivery['expires_at'];report['artifact_sha256']=delivery.get('artifact_sha256')
    report['checks']['TEMPORARY_DOWNLOAD']='PASS'
    require(app('/api/release').get('sales_mode')=='globally-blocked','sales_must_remain_blocked_after_purchase')
    report['checks']['FINAL']='GREEN';save();print(json.dumps(report))
except Exception as e:
    report['checks']['FINAL']='FAIL';report['cause']=str(e);save()
    print('::error title=COMBO_SANDBOX::'+str(e).replace('\n',' '));raise SystemExit(1)
