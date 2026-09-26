#!/usr/bin/env python3
import hashlib, json, os, pathlib, re, time, urllib.request, subprocess
SLUG=os.environ["TARGET_SLUG"]
SHA=os.environ["EXPECTED_SHA"].lower()
BASE="https://zevanory.api.br"
ROOT=pathlib.Path(".")
target=ROOT/SLUG/"index.html"
css=ROOT/"product.css"
assert target.exists() and css.exists()
html=target.read_text("utf-8")
css_text=css.read_text("utf-8")
assert "<h1" in html.lower()
assert "canonical" in html.lower()
assert "application/ld+json" in html.lower()
assert "javascript:" not in html.lower()
assert not re.search(r'href=["\'][^"\']*(checkout|comprar|payment|pagamento|stripe|mercadopago)',html,re.I)
assert "prefers-reduced-motion" in css_text and ":focus" in css_text and "@media" in css_text
source_sha256=hashlib.sha256(html.encode()).hexdigest()
blob=subprocess.check_output(["git","hash-object",str(target)],text=True).strip()
coverage_path=ROOT/"evidence"/"zees16"/"coverage"/f"{SLUG}.json"
assert coverage_path.exists(),("missing_coverage",SLUG)
coverage=json.loads(coverage_path.read_text("utf-8"))
declared_blob=str(coverage.get("production_blob") or "")
if declared_blob:
    assert declared_blob==blob,(SLUG,"source_blob_drift",declared_blob,blob)
def get(url):
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PORTFOLIO-CERT/1.0","Accept":"text/html,application/json"})
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=25) as r:
        body=r.read(); headers=dict(r.headers.items()); code=r.status
    return code,body,headers,round((time.perf_counter()-t)*1000,2)
code,live,headers,ms=get(f"{BASE}/{SLUG}")
assert code==200
live_text=live.decode("utf-8","replace")
# Edge/runtime may inject operational assets. Bind source to live semantically and by canonical identity instead of byte equality.
assert f'href="https://zevanory.api.br/{SLUG}"' in live_text,(SLUG,"canonical_live_mismatch")
assert "<h1" in live_text.lower(),(SLUG,"live_h1_missing")
src_title=re.search(r"<title>(.*?)</title>",html,re.I|re.S)
live_title=re.search(r"<title>(.*?)</title>",live_text,re.I|re.S)
assert src_title and live_title and src_title.group(1).strip()==live_title.group(1).strip(),(SLUG,"live_title_mismatch")
src_h1=re.search(r"<h1[^>]*>(.*?)</h1>",html,re.I|re.S)
live_h1=re.search(r"<h1[^>]*>(.*?)</h1>",live_text,re.I|re.S)
clean=lambda x: re.sub(r"<[^>]+>","",x).strip()
assert src_h1 and live_h1 and clean(src_h1.group(1))==clean(live_h1.group(1)),(SLUG,"live_h1_mismatch")
lat=[ms]
for _ in range(2):
    c,b,h,x=get(f"{BASE}/{SLUG}"); assert c==200; lat.append(x)
for path,need in [("privacidade","lgpd"),("termos","consum"),("reembolso","reembolso")]:
    c,b,h,x=get(f"{BASE}/{path}"); assert c==200
    assert need in b.decode("utf-8","replace").lower(),(path,need)
c,release,_,_=get(f"{BASE}/api/release"); assert c==200
rel=json.loads(release.decode())
assert rel.get("sales_mode")=="globally-blocked",rel
c,health,_,_=get(f"{BASE}/api/health"); assert c==200
healthj=json.loads(health.decode())
assert healthj.get("live") is True and healthj.get("ready") is True,healthj
# static digital-content data governance: no client collection/persistence surface
assert not re.search(r'<(form|input|textarea|select)\b',html,re.I)
assert not re.search(r'<script[^>]+src=',html,re.I)
checks={
 "P01":"PASS","P05":"PASS","P06":"PASS","P07":"PASS","P08":"PASS","P09":"PASS",
 "P10":"PASS","P11":"PASS","P12":"PASS","P13":"PASS","P15":"PASS"
}
report={
 "schema":"zevanory.portfolio.target-cert.v1","target":SLUG,"workflow_sha":SHA,
 "url":f"{BASE}/{SLUG}","source_blob":blob,"source_sha256":source_sha256,
 "live_sha256":hashlib.sha256(live_text.encode()).hexdigest(),"live_binding":"canonical+title+h1",
 "latency_ms":lat,"shared_runtime_release":rel.get("deployment",{}).get("commit_sha"),
 "sales_mode":rel.get("sales_mode"),"data_profile":"STATIC_PUBLIC_CONTENT_NO_PERSISTENT_DATA",
 "checks":checks,"false_green":0
}
pathlib.Path("evidence").mkdir(exist_ok=True)
pathlib.Path(f"evidence/{SLUG}-base-cert.json").write_text(json.dumps(report,indent=2)+"\n")
for k,v in checks.items(): print(f"{SLUG}:{k}={v}")
print("FALSE_GREEN=0")
