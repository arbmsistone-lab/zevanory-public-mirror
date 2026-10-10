#!/usr/bin/env python3
"""Generate an isolated Worker config from the same prepared source, not production settings."""
import json,os,re,sys
from pathlib import Path
BASE=Path("wrangler.central-fix.jsonc")
def valid_id(v):return bool(re.fullmatch(r"[0-9a-f]{32}",v or ""))
def generate(source,env):
    kv_id=env.get("CERTIFICATION_KV_ID","").lower()
    d1_id=env.get("CERTIFICATION_D1_ID","").lower()
    account=env.get("CLOUDFLARE_ACCOUNT_ID","")
    if not valid_id(kv_id) or not valid_id(d1_id) or not valid_id(account):
        raise ValueError("CERTIFICATION_RESOURCE_IDS_REQUIRED")
    old_kv={x.get("id") for x in source.get("kv_namespaces",[])}
    old_d1={x.get("database_id") for x in source.get("d1_databases",[])}
    if kv_id in old_kv or d1_id in old_d1 or kv_id=="728a45738e4047f29bcb89934fd533c1":
        raise ValueError("PRODUCTION_STORAGE_REUSE_DENIED")
    source_sha=env.get("TARGET_RUNTIME_SHA","")
    if not re.fullmatch(r"[0-9a-f]{40}",source_sha):
        raise ValueError("CERTIFICATION_SOURCE_SHA_REQUIRED")
    if account!="1b26415802588185a86c1d4d3ebf5bdb":
        raise ValueError("CLOUDFLARE_ACCOUNT_MISMATCH")
    config={
      "name":"zevanory-certification",
      "main":"certification-worker.mjs",
      "account_id":account,
      "compatibility_date":source.get("compatibility_date","2026-09-19"),
      "compatibility_flags":source.get("compatibility_flags",[]),
      "workers_dev":True,
      "routes":[],
      "triggers":{"crons":[]},
      "kv_namespaces":[{"binding":"ZEVANORY_PRIVATE_ARTIFACTS","id":kv_id}],
      "d1_databases":[{"binding":"CERTIFICATION_D1","database_name":"zevanory-certification-only","database_id":d1_id}],
      "vars":{
       "CERTIFICATION_WORKER_NAME":"zevanory-certification",
       "CERTIFICATION_SOURCE_SHA":source_sha,
       "ZEVANORY_DEPLOYMENT_ENV":"certification",
       "CERTIFICATION_PILOT_ENV":"sandbox",
       "MERCADOPAGO_ENV":"sandbox",
       "SALE_GLOBALLY_ENABLED":"false",
       "CERTIFICATION_PILOT_PRODUCTION_ALLOWED":"false",
       "PRE_SALE_GATES_APPROVED":"false",
       "ABSOLUTE_RELEASE_APPROVED":"false",
       "CHECKOUT_ENABLED":"false",
       "FINANCIAL_EVENTS_ENABLED":"false"
      }
    }
    for key in ("assets","services","ai","queues","r2_buckets"):
        if config.get(key):raise ValueError("NON_CERTIFICATION_BINDING_DENIED")
    return config
if __name__=="__main__":
    try: config=generate(json.loads(BASE.read_text()),os.environ)
    except (ValueError,KeyError,FileNotFoundError) as e:sys.exit("CERTIFICATION_CONFIG_FAIL_CLOSED: "+str(e))
    Path("wrangler.certification.generated.jsonc").write_text(json.dumps(config,indent=2)+"\n")
    print("ISOLATED_WORKER_CONFIG=PASS no production storage, service, route or secrets")
