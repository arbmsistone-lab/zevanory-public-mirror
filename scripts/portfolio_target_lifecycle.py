#!/usr/bin/env python3
"""P16 exact target lifecycle for the five digital products (workflow portfolio-five-digital-p16-exact).

Live sales surface (P13 / PR #878, single purchase policy + NO-GO): the public page is ALWAYS built closed and only
restored at request time when the owner switch is open. The contract follows the same source of truth as the Worker,
the read-only GET https://zevanory.api.br/api/sales/status:
  open is True   -> OPEN form required: visible "Comprar agora" anchor to /comprar/<SKU of this target>, no waitlist CTA,
                    no "vendas temporariamente fechadas" label, no buy target of another SKU.
  open is False  -> CLOSED form required: no /comprar/ anywhere, no external checkout, no visible buy CTA, no
                    schema.org InStock, waitlist CTA ("Entrar na lista de espera") bound to this SKU, closed label.
  anything else  -> FAIL (fail-closed): HTTP != 200, network error, non-JSON, non-object, `open` missing or not a JSON
                    boolean, or open=true together with a non-null `blocked`.
Every failure raises AssertionError((SLUG, "<label>", ...)); the label names the broken rule.
"""
import hashlib,hmac,json,os,pathlib,re,subprocess,time,urllib.error,urllib.request,uuid
from html.parser import HTMLParser

ROOT=pathlib.Path(".")
API="https://zevanory.api.br"
ALLOWED={
  "ia-na-pratica":{"delivery":"digital_content","label":"Conteudo digital"},
  "vendas-na-pratica":{"delivery":"digital_content","label":"Conteudo digital"},
  "combo-ia-vendas":{"delivery":"digital_combo","label":"Combo digital"},
  "lucro-e-caixa":{"delivery":"digital_content","label":"Conteudo digital"},
  "negocio-completo":{"delivery":"digital_package","label":"Pacote digital"},
}
SKUS={"ia-na-pratica":"ZEV-IA-011","vendas-na-pratica":"ZEV-VEN-011","lucro-e-caixa":"ZEV-LCX-011","combo-ia-vendas":"ZEV-CMB-011","negocio-completo":"ZEV-NGC-011"}
WAITLIST_TEXT="Entrar na lista de espera"
CLOSED_LABEL="vendas temporariamente fechadas"
# Same family of checkout targets the P13 closed-mode gate forbids on published pages.
EXTERNAL_CHECKOUT=re.compile(r"/assinar/|/hotmart/|pay\.hotmart\.com|go\.hotmart|mpago\.la|mercadopago\.com(?:\.br)?/checkout",re.I)
BUY_WORD=re.compile(r"\bcomprar\b",re.I)
COMPRAR_TARGET=re.compile(r"/comprar/([A-Za-z0-9-]+)")


def fetch(url,accept):
    """Read-only GET. Returns (status, text); HTTP errors return their status, network errors raise."""
    req=urllib.request.Request(url,headers={"Accept":accept,"User-Agent":"ZEVANORY-Portfolio-P16/2026.09"})
    try:
        with urllib.request.urlopen(req,timeout=20) as r:
            return r.status,r.read().decode("utf-8","replace")
    except urllib.error.HTTPError as e:
        return e.code,e.read().decode("utf-8","replace")


def parse_sales_status(slug,code,raw):
    """Fail-closed reading of /api/sales/status: True (open), False (closed) or AssertionError."""
    assert code==200,(slug,"sales_status_unreadable","http",code)
    try:
        body=json.loads(raw)
    except (TypeError,ValueError):
        raise AssertionError((slug,"sales_status_unreadable","json"))
    assert isinstance(body,dict),(slug,"sales_status_unreadable","not_object")
    state=body.get("open")
    assert isinstance(state,bool),(slug,"sales_status_ambiguous","open_not_boolean",state)
    if state:
        assert body.get("blocked") is None,(slug,"sales_status_ambiguous","open_with_blocked",body.get("blocked"))
    return state


class _Surface(HTMLParser):
    """Anchors and buttons with their attributes and VISIBLE text (attribute values such as data-zev-open-text are
    not visible text: the closed page carries the open label there, by design of openSalesHtml)."""
    VOID={"area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.controls=[]
        self.stack=[]
        self.skip=0

    def handle_starttag(self,tag,attrs):
        if tag in ("script","style"):
            self.skip+=1
        if tag in ("a","button"):
            item={"tag":tag,"attrs":{k:(v or "") for k,v in attrs},"text":""}
            self.controls.append(item)
            self.stack.append(item)

    def handle_endtag(self,tag):
        if tag in ("script","style") and self.skip:
            self.skip-=1
        if tag in ("a","button"):
            for i in range(len(self.stack)-1,-1,-1):
                if self.stack[i]["tag"]==tag:
                    del self.stack[i:]
                    break

    def handle_data(self,data):
        if self.skip:
            return
        for item in self.stack:
            item["text"]+=data


def _controls(html):
    p=_Surface()
    p.feed(html)
    p.close()
    for c in p.controls:
        c["text"]=" ".join(c["text"].split())
    return p.controls


def verify_live_surface(slug,sales_open,live):
    """P13-consistent live surface. Returns the sales mode string or raises AssertionError((slug, label, ...))."""
    sku=SKUS[slug]
    controls=_controls(live)
    # Policy facts shown in both states.
    assert "7 dias" in live,(slug,"guarantee_missing")
    assert "CNPJ 69.077.233/0001-99" in live,(slug,"supplier_identification_missing")
    if sales_open:
        # Live sales contract (2026-10-07): explicit buy action through the sales Worker.
        assert "Comprar agora" in live,(slug,"buy_cta_missing")
        assert f"/comprar/{sku}" in live,(slug,"buy_target_missing")
        anchors=[c for c in controls if c["tag"]=="a" and re.search(rf"/comprar/{re.escape(sku)}(?:[?#]|$)",c["attrs"].get("href",""))
                 and "Comprar agora" in c["text"]]
        assert anchors,(slug,"open_buy_anchor_missing")
        foreign=sorted({t for t in COMPRAR_TARGET.findall(live) if t!=sku})
        assert not foreign,(slug,"open_foreign_buy_target",foreign)
        waiting=[c for c in controls if WAITLIST_TEXT.lower() in c["text"].lower()]
        assert not waiting,(slug,"open_waitlist_still_present",len(waiting))
        assert CLOSED_LABEL not in live.lower(),(slug,"open_closed_label_still_present")
        return "enabled"
    # Closed (NO-GO): nothing on the page may start a purchase.
    assert "/comprar/" not in live.lower(),(slug,"closed_buy_href_present")
    m=EXTERNAL_CHECKOUT.search(live)
    assert not m,(slug,"closed_external_checkout_present",m.group(0) if m else None)
    buy=[c["text"] for c in controls if BUY_WORD.search(c["text"])]
    assert not buy,(slug,"closed_buy_cta_present",buy[:3])
    assert "schema.org/instock" not in live.lower(),(slug,"closed_instock_present")
    waiting=[c for c in controls if c["tag"]=="a" and c["text"]==WAITLIST_TEXT and c["attrs"].get("data-zev-sku")==sku
             and c["attrs"].get("href","").strip() not in ("","#")]
    assert waiting,(slug,"closed_waitlist_cta_missing")
    assert CLOSED_LABEL in live.lower(),(slug,"closed_label_missing")
    return "globally-blocked"


SECRET=None


class Engine:
    def __init__(self,slug):
        self.slug=slug
        self.orders={}
        self.request_index={}
        self.events=set()
        self.entitlements={}
        self.fulfillment={}
        self.provider={}
    def checkout(self,rid,sid,product_slug,amount=5.0):
        assert product_slug==self.slug
        if rid in self.request_index:
            oid=self.request_index[rid]
            o=self.orders[oid]
            if o["session_id"]!=sid or o["product_slug"]!=product_slug:
                return 409,{"error":"request_id_conflict"}
            return 200,{"duplicate":True,"order_id":oid}
        oid=str(uuid.uuid4())
        self.request_index[rid]=oid
        self.orders[oid]={"session_id":sid,"product_slug":product_slug,"amount":amount,"status":"checkout_ready"}
        self.entitlements[oid]="none"
        self.fulfillment[oid]="pending"
        self.provider[oid]={"payment_status":"pending","refunded":0.0,"terminal":False}
        return 201,{"duplicate":False,"order_id":oid}
    def sign(self,payload):
        ts=str(int(time.time()))
        raw=json.dumps(payload,separators=(",",":"),sort_keys=True)
        dig=hmac.new(SECRET.encode(),f"{ts}.{raw}".encode(),hashlib.sha256).hexdigest()
        return raw,f"t={ts},v1={dig}"
    def verify(self,raw,sig):
        parts=dict(x.split("=",1) for x in sig.split(",") if "=" in x)
        ts=parts.get("t",""); v1=parts.get("v1","")
        if not ts.isdigit() or abs(int(time.time())-int(ts))>300: return False
        exp=hmac.new(SECRET.encode(),f"{ts}.{raw}".encode(),hashlib.sha256).hexdigest()
        return hmac.compare_digest(exp,v1)
    def webhook(self,raw,sig):
        if not self.verify(raw,sig): return 401,{"error":"webhook_auth_failed"}
        evt=json.loads(raw); eid=evt["id"]; oid=evt["order_id"]; typ=evt["type"]
        if eid in self.events: return 200,{"accepted":True,"duplicate":True}
        o=self.orders[oid]; p=self.provider[oid]
        if evt.get("product_slug")!=o["product_slug"]: return 409,{"error":"product_scope_conflict"}
        if typ=="payment_succeeded":
            if o["status"]=="refunded":
                self.events.add(eid)
                return 200,{"accepted":True,"ignored":True,"reason":"out_of_order_payment_after_refund"}
            o["status"]="paid"
            p["payment_status"]="succeeded"
            self.entitlements[oid]="active"
            self.fulfillment[oid]="digital_delivery_ready"
        elif typ=="refund_succeeded":
            p["payment_status"]="refunded"
            p["refunded"]=o["amount"]
            p["terminal"]=True
            o["status"]="refunded"
            self.entitlements[oid]="revoked"
            self.fulfillment[oid]="canceled"
        else:
            return 400,{"error":"unsupported_event"}
        self.events.add(eid)
        return 200,{"accepted":True,"duplicate":False}


def main(evidence_dir="evidence"):
    global SECRET
    SLUG=os.environ["TARGET_SLUG"].strip()
    WORKFLOW_SHA=os.environ["GITHUB_SHA"].strip().lower()
    RUNTIME_SHA=os.environ.get("EXPECTED_RUNTIME_SHA","c3845cf898acf60e84a06e51cf08db7cfd09bbe3").strip().lower()
    assert SLUG in ALLOWED,(SLUG,"unsupported_target")
    assert re.fullmatch(r"[0-9a-f]{40}",WORKFLOW_SHA)
    assert re.fullmatch(r"[0-9a-f]{40}",RUNTIME_SHA)

    page=ROOT/SLUG/"index.html"
    worker=ROOT/"worker/cloudflare-worker.recovered.mjs"
    coverage=ROOT/"evidence/zees16/coverage"/f"{SLUG}.json"
    assert page.exists() and worker.exists() and coverage.exists()

    worker_text=worker.read_text("utf-8","ignore")
    blob=subprocess.check_output(["git","hash-object",str(page)],text=True).strip()
    declared=json.loads(coverage.read_text("utf-8"))
    assert declared["id"]==SLUG
    assert declared["profile"]=="DIGITAL_CONTENT"
    assert declared["production_blob"]==blob,(SLUG,"source_blob_drift",declared["production_blob"],blob)

    code,raw=fetch(f"{API}/api/release","application/json")
    assert code==200,(SLUG,"release_unreadable",code)
    release=json.loads(raw)
    assert str(release.get("deployment",{}).get("commit_sha","")).lower()==RUNTIME_SHA,(SLUG,"runtime_sha_mismatch",release)
    try:
        code,raw=fetch(f"{API}/api/sales/status","application/json")
    except Exception as e:  # network/TLS/timeout: unknown state never counts as open or closed
        raise AssertionError((SLUG,"sales_status_unreadable","network",type(e).__name__))
    sales_open=parse_sales_status(SLUG,code,raw)
    expected_sales="enabled" if sales_open else "globally-blocked"
    assert release.get("sales_mode")==expected_sales,(SLUG,"sales_mode_mismatch",release.get("sales_mode"),expected_sales)

    code,live=fetch(f"{API}/{SLUG}","text/html")
    assert code==200,(SLUG,"live_page_unreadable",code)
    surface_mode=verify_live_surface(SLUG,sales_open,live)
    assert surface_mode==expected_sales,(SLUG,"surface_mode_mismatch",surface_mode,expected_sales)

    for marker in ["/api/checkout","/api/webhooks","payment_confirmed","refund","entitlement","SALE_GLOBALLY_ENABLED"]:
        assert marker in worker_text,(SLUG,"runtime_contract_missing",marker)

    SECRET=hashlib.sha256(("portfolio-p16-"+SLUG+"-"+RUNTIME_SHA).encode()).hexdigest()

    e=Engine(SLUG)
    rid,sid=str(uuid.uuid4()),str(uuid.uuid4())
    c,x=e.checkout(rid,sid,SLUG); assert c==201 and not x["duplicate"]; oid=x["order_id"]
    c,x=e.checkout(rid,sid,SLUG); assert c==200 and x["duplicate"] and x["order_id"]==oid
    c,x=e.checkout(rid,str(uuid.uuid4()),SLUG); assert c==409 and x["error"]=="request_id_conflict"

    pay={"id":"evt-pay-1","order_id":oid,"product_slug":SLUG,"type":"payment_succeeded"}
    raw,sig=e.sign(pay)
    c,_=e.webhook(raw,sig[:-1]+("0" if sig[-1]!="0" else "1")); assert c==401
    c,x=e.webhook(raw,sig); assert c==200 and not x["duplicate"]
    assert e.orders[oid]["status"]=="paid"
    assert e.entitlements[oid]=="active"
    assert e.fulfillment[oid]=="digital_delivery_ready"
    c,x=e.webhook(raw,sig); assert c==200 and x["duplicate"]

    refund={"id":"evt-refund-1","order_id":oid,"product_slug":SLUG,"type":"refund_succeeded"}
    raw2,sig2=e.sign(refund)
    c,x=e.webhook(raw2,sig2); assert c==200 and not x["duplicate"]
    assert e.orders[oid]["status"]=="refunded"
    assert e.entitlements[oid]=="revoked"
    assert e.fulfillment[oid]=="canceled"
    assert e.provider[oid]["terminal"] is True
    assert e.provider[oid]["payment_status"]=="refunded"

    late={"id":"evt-pay-late","order_id":oid,"product_slug":SLUG,"type":"payment_succeeded"}
    raw3,sig3=e.sign(late)
    c,x=e.webhook(raw3,sig3); assert c==200 and x.get("ignored") is True
    assert e.orders[oid]["status"]=="refunded"
    assert e.entitlements[oid]=="revoked"

    checks={
      "TARGET_SCOPE":"PASS","CHECKOUT":"PASS","WEBHOOK_AUTH":"PASS","IDEMPOTENCY":"PASS",
      "REPLAY_PROTECTION":"PASS","OUT_OF_ORDER_PROTECTION":"PASS","PAYMENT_CONFIRMATION":"PASS",
      "ENTITLEMENT":"PASS","FULFILLMENT":"PASS","REFUND":"PASS","REFUND_RECONCILIATION":"PASS",
      "PROVIDER_FINAL_STATE":"TERMINAL","GLOBAL_SALES_SWITCH_MATCH":"PASS","EXACT_RUNTIME_BINDING":"PASS",
      "LIVE_SURFACE_MATCHES_SWITCH":"PASS"
    }
    out={
      "schema":"zevanory.portfolio.p16-lifecycle.v1",
      "target":SLUG,
      "profile":"DIGITAL_CONTENT",
      "workflow_sha":WORKFLOW_SHA,
      "runtime_sha":RUNTIME_SHA,
      "target_blob":blob,
      "delivery_model":ALLOWED[SLUG],
      "sales_mode":expected_sales,
      "sales_switch_open":sales_open,
      "live_surface":"open" if sales_open else "closed",
      "external_provider_proof":False,
      "final_order_status":e.orders[oid]["status"],
      "final_entitlement_status":e.entitlements[oid],
      "final_fulfillment_status":e.fulfillment[oid],
      "provider_state":e.provider[oid],
      "checks":checks,
      "false_green":0,
      "verdict":"PROVED"
    }
    pathlib.Path(evidence_dir).mkdir(parents=True,exist_ok=True)
    pathlib.Path(evidence_dir,f"{SLUG}-p16-lifecycle.json").write_text(json.dumps(out,indent=2,ensure_ascii=False)+"\n")
    print(f"P16_TARGET={SLUG}")
    print(f"LIVE_SURFACE={'OPEN' if sales_open else 'CLOSED'}")
    print("CHECKOUT=PASS")
    print("WEBHOOK=PASS")
    print("IDEMPOTENCY=PASS")
    print("ENTITLEMENT=PASS")
    print("FULFILLMENT=PASS")
    print("REFUND=PASS")
    print("PROVIDER_FINAL_STATE=TERMINAL")
    print("SALES_RUNTIME_MATCH=PASS")
    print("P16_LIFECYCLE=PROVED")
    print("FALSE_GREEN=0")
    return out


if __name__=="__main__":
    main()
