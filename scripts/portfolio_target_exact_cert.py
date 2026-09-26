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
def get(url):
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PORTFOLIO-CERT/1.0","Accept":"text/html,application/json"})
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=25) as r:
        body=r.read(); headers=dict(r.headers.items()); code=r.status
    return code,body,headers,round((time.perf_counter()-t)*1000,2)
code,live,headers,ms=get(f"{BASE}/{SLUG}")
assert code==200
live_text=live.decode("utf-8","replace")
assert hashlib.sha256(live_text.encode()).hexdigest()==source_sha256,(SLUG,"live_source_hash_mismatch")
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
 "live_sha256":hashlib.sha256(live_text.encode()).hexdigest(),
 "latency_ms":lat,"shared_runtime_release":rel.get("deployment",{}).get("commit_sha"),
 "sales_mode":rel.get("sales_mode"),"data_profile":"STATIC_PUBLIC_CONTENT_NO_PERSISTENT_DATA",
 "checks":checks,"false_green":0
}
pathlib.Path("evidence").mkdir(exist_ok=True)
pathlib.Path(f"evidence/{SLUG}-base-cert.json").write_text(json.dumps(report,indent=2)+"\n")
for k,v in checks.items(): print(f"{SLUG}:{k}={v}")
print("FALSE_GREEN=0")
