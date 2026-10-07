#!/usr/bin/env python3
import json
import time
import urllib.request

def get(url, accept="application/json,text/html"):
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PostDeploy-Smoke/1.0","Accept":accept,"Cache-Control":"no-cache"})
    with urllib.request.urlopen(req,timeout=25) as r:
        return r.status,dict(r.headers),r.read().decode("utf-8","replace")

urls=[
    "https://zevanory.api.br/api/status",
    "https://edge.zevanory.api.br/api/status",
    "https://zevanory.api.br/api/sales/status",
    "https://zevanory.api.br/api/health",
    "https://zevanory.api.br/api/release",
    "https://zevanory.api.br/api/control-plane",
]
p={}
for u in urls:
    code,_,body=get(u)
    assert code==200,(u,code)
    p[u]=json.loads(body)

shared=("project","gate","experiment","engine","sales_machine","runtime","metrics","channel_readiness")
main=p[urls[0]]
edge=p[urls[1]]
for attempt in range(31):
    mismatches=[key for key in shared if main.get(key)!=edge.get(key)]
    if not mismatches:
        break
    if attempt==30:
        raise AssertionError(("main_edge_parity_after_150s",mismatches))
    time.sleep(5)
    _,_,main_body=get(urls[0])
    _,_,edge_body=get(urls[1])
    main=json.loads(main_body)
    edge=json.loads(edge_body)

sales=p[urls[2]]
expected_sales="enabled" if sales.get("open") is True else "globally-blocked"
assert main["runtime"]["sales"]==expected_sales,("main_sales",main["runtime"],sales)
assert edge["runtime"]["sales"]==expected_sales,("edge_sales",edge["runtime"],sales)
health=p[urls[3]]
assert health["live"] is True,("health_live",health)
assert health["ready"] is True,("health_ready",health)
assert health["schema"]["missing_tables_count"]==0,("missing_tables",health["schema"])
assert health["schema"]["missing_migrations_count"]==0,("missing_migrations",health["schema"])

for slug in ("solucoes","termos","privacidade","reembolso","afiliados"):
    u=f"https://zevanory.api.br/{slug}"
    code,headers,body=get(u,"text/html")
    assert code==200,(u,code)
    assert len(body)>300,(u,len(body))
    if slug=="solucoes":
        low={k.lower():v for k,v in headers.items()}
        assert low.get("x-content-type-options","").lower()=="nosniff",low
        assert "IA na Prática" in body

print("POSTDEPLOY_PRODUCTION_API_LEGAL_PARITY=PASS")
