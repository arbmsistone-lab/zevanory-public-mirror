#!/usr/bin/env python3
# Smoke pós-deploy das superfícies da API e páginas legais (central-production-deploy.yml).
# P19 fase 1 (medição): cada leitura registra o NOME público (host + caminho, sem query) ANTES da chamada e, depois,
# o resultado, a duração e a classe do erro. Em timeout, a linha ::error identifica a sonda e a falha ORIGINAL é
# relançada (o passo reprova como antes e o rollback automático segue igual). O limite por leitura continua 25 s.
# Nunca registra query string, cabeçalhos, corpo, credenciais ou dados de clientes.
import datetime
import json
import secrets
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_S=25
_seq=[0]

def log(line):
    print(line, flush=True)

def probe_name(url):
    u=urllib.parse.urlsplit(url)
    return (u.netloc+u.path)[:200]

def error_class(e):
    if isinstance(e, urllib.error.HTTPError):
        return f"http_{e.code}"
    reason=getattr(e,"reason",None)
    if isinstance(e,(TimeoutError,socket.timeout)) or isinstance(reason,(TimeoutError,socket.timeout)):
        return "timeout"
    return type(e).__name__[:40]

def get(url, accept="application/json,text/html"):
    _seq[0]+=1
    seq,name=_seq[0],probe_name(url)
    # rid de correlação gerado AQUI e enviado no cabeçalho x-zevanory-diag: o Worker o usa nas linhas de entrada das
    # etapas, então mesmo uma chamada SEM resposta é identificável nos logs por este valor (não por horário).
    rid=secrets.token_hex(6)
    log(f"SURFACE_PROBE_START seq={seq} name={name} rid={rid} at={datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')}")
    t0=time.monotonic()
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PostDeploy-Smoke/1.0","Accept":accept,"Cache-Control":"no-cache","x-zevanory-diag":rid})
    # phase: headers = até os cabeçalhos; body = cabeçalhos recebidos, lendo o corpo. Com os cabeçalhos, a linha
    # SURFACE_PROBE_HEADERS já traz o rid (x-zevanory-diag) mesmo que o corpo depois trave.
    phase="headers"
    diag="-"
    try:
        with urllib.request.urlopen(req,timeout=TIMEOUT_S) as r:
            low={k.lower():v for k,v in dict(r.headers).items()}
            d=low.get("x-zevanory-diag","")
            diag=d if len(d)==12 and all(c in "0123456789abcdef" for c in d) else "-"
            log(f"SURFACE_PROBE_HEADERS seq={seq} name={name} status={r.status} ms={int((time.monotonic()-t0)*1000)} diag={diag}")
            phase="body"
            out=(r.status,dict(r.headers),r.read().decode("utf-8","replace"))
    except Exception as e:
        ms=int((time.monotonic()-t0)*1000)
        cls=error_class(e)
        log(f"SURFACE_PROBE_FAIL seq={seq} name={name} ms={ms} phase={phase} error_class={cls} diag={diag}")
        title="SURFACE_PROBE_TIMEOUT" if cls=="timeout" else "SURFACE_PROBE_ERROR"
        log(f"::error title={title}::{name} falhou em {ms} ms ({cls}, fase {phase}; limite {TIMEOUT_S} s por leitura)")
        raise
    ms=int((time.monotonic()-t0)*1000)
    log(f"SURFACE_PROBE_END seq={seq} name={name} status={out[0]} ms={ms} diag={diag}")
    return out

def run():
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

if __name__=="__main__":
    run()
