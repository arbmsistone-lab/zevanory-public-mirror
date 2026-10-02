#!/usr/bin/env python3
import json
import urllib.request

def get(url, accept="application/json,text/html"):
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PostDeploy-Smoke/1.0","Accept":accept,"Cache-Control":"no-cache"})
    with urllib.request.urlopen(req,timeout=25) as r:
        return r.status,dict(r.headers),r.read().decode("utf-8","replace")

urls=[
    "https://zevanory.api.br/api/status",
    "https://edge.zevanory.api.br/api/status",
    "https://zevanory.api.br/api/health",
    "https://zevanory.api.br/api/release",
    "https://zevanory.api.br/api/control-plane",
]
p={}
for u in urls:
    code,_,body=get(u)
    assert code==200,(u,code)
    p[u]=json.loads(body)

main=p[urls[0]]
edge=p[urls[1]]
for key in ("project","gate","experiment","engine","sales_machine","runtime","metrics","channel_readiness"):
    assert main.get(key)==edge.get(key),("main_edge_parity",key,main.get(key),edge.get(key))

assert main["runtime"]["sales"]=="globally-blocked",("main_sales",main["runtime"])
assert edge["runtime"]["sales"]=="globally-blocked",("edge_sales",edge["runtime"])
health=p[urls[2]]
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
