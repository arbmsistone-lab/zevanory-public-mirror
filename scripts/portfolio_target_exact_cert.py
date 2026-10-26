#!/usr/bin/env python3
import hashlib, json, os, pathlib, re, sys, time, urllib.request, subprocess
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import portfolio_cert_contract as contract
# Contrato v3: pull_request = pré-merge (produção == fonte no SHA PUBLICADO de cada superfície; deriva publicada x base
# e mudanças candidato x base registradas); workflow_run dos deploys / push / dispatch = pós-publicação, só depois da
# promoção efetiva observada (produção == fonte, exata). Ver portfolio_cert_contract.py.
EVENT=os.environ.get("GITHUB_EVENT_NAME")
CONTEXT=contract.resolve_context(EVENT,os.environ.get("CERT_CONTEXT"))
TRIGGER=contract.resolve_trigger(EVENT,os.environ.get("TRIGGER_SURFACE"))
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
assert declared_blob==blob,(SLUG,"source_blob_drift",declared_blob,blob)

def get(url, headers=None):
    hdr={"User-Agent":"ZEVANORY-PORTFOLIO-CERT/2.0","Accept":"text/html,application/json"}
    if headers: hdr.update(headers)
    req=urllib.request.Request(url,headers=hdr)
    t=time.perf_counter()
    with urllib.request.urlopen(req,timeout=25) as r:
        body=r.read(); rh={k.lower():v for k,v in r.headers.items()}; code=r.status
    return code,body,rh,round((time.perf_counter()-t)*1000,2)

def get_final(url):
    req=urllib.request.Request(url,headers={"User-Agent":"ZEVANORY-PORTFOLIO-CERT/3.0","Accept":"text/html","Cache-Control":"no-cache"})
    with urllib.request.urlopen(req,timeout=25) as r:
        return r.status,r.read().decode("utf-8","replace"),r.geturl()

def read_release(surface):
    try:
        c,b,_,_=get(contract.SURFACES[surface]["release_url"]+("?t=%d"%time.time()))
        return contract.release_sha(surface,json.loads(b.decode())) if c==200 else None
    except Exception:
        return None

def contract_fail(e):
    print(f"::error title=PORTFOLIO_CERT_CONTRACT::{SLUG} {CONTEXT} {e.code} {json.dumps(e.detail,ensure_ascii=False)[:1500]}")
    raise AssertionError((SLUG,e.code,e.detail)) from None

head_fields=contract.extract_fields(html)
_,_,final_url=get_final(f"{BASE}/{SLUG}")
try:
    serving=contract.surface_for_url(final_url)
    if CONTEXT==contract.PRE_MERGE:
        deployed_shas={s:read_release(s) for s in contract.SURFACES}
        premerge=contract.premerge_inputs(f"{SLUG}/index.html",SHA,os.environ.get("BASE_SHA","").lower(),deployed_shas,serving)
        code,live,headers,ms=get(f"{BASE}/{SLUG}")
        live_fields=contract.extract_fields(live.decode("utf-8","replace"))
        live_contract=contract.evaluate_premerge(head_fields,live_fields,premerge["deployed"],premerge["base"],premerge["merge_base"],
            head_html=html,diff_text=premerge["diff_text"],surfaces=premerge["surfaces"],serving=serving)
        live_contract.update(base_sha=premerge["base_sha"],merge_base_sha=premerge["merge_base_sha"])
    else:
        promotion=contract.await_promotion(SHA,head_fields,serving,read_release,
            lambda sha: contract.fields_at_sha(sha,f"{SLUG}/index.html"),trigger=TRIGGER,
            wait_seconds=int(os.environ.get("CERT_PROMOTION_WAIT_SECONDS","900")))
        code,live,headers,ms=get(f"{BASE}/{SLUG}")
        live_fields=contract.extract_fields(live.decode("utf-8","replace"))
        live_contract=contract.evaluate_post_deploy(head_fields,live_fields,promotion)
except contract.ContractError as e:
    contract_fail(e)
assert code==200
live_text=live.decode("utf-8","replace")
# Owner-approved canonical is the domain that serves the page (zevanory.api.br/<slug> 308-redirects there).
assert f'href="https://vendas.zevanory.api.br/{SLUG}"' in live_text,(SLUG,"canonical_live_mismatch")
for s_name,s_rel in (live_contract.get("surfaces") or {}).items():
    print(f"::notice title=SURFACE {SLUG} {s_name}::published={s_rel['deployed_sha']} base={s_rel['base_sha']} relation={s_rel['relation']}")
for ch in live_contract.get("pending_undeployed",[]):
    print(f"::warning title=PENDING_UNDEPLOYED {SLUG} {ch['surface']}::{ch['field']}: publicado {ch['deployed']!r} x base {ch['base']!r} ({ch['relation']})")
for ch in live_contract["expected_changes"]:
    print(f"::notice title=EXPECTED_CHANGE {SLUG}::{ch['field']}: {ch['base']!r} -> {ch['candidate']!r} (diff linhas {ch['candidate_lines']})")
if live_contract.get("promotion"):
    print(f"::notice title=PROMOTION_OBSERVED {SLUG}::{json.dumps(live_contract['promotion'])}")

# P07: target-source SAST + live DAST/header boundary.
secret_patterns=[
  r"sk_live_[A-Za-z0-9]+", r"ghp_[A-Za-z0-9]{20,}", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
  r"SUPABASE_SERVICE_ROLE_KEY\s*=", r"CLOUDFLARE_API_TOKEN\s*="
]
assert not any(re.search(p,html,re.I) for p in secret_patterns),(SLUG,"secret_pattern")
assert not re.search(r'on(?:click|load|error)\s*=',html,re.I),(SLUG,"inline_event_handler")
assert not re.search(r'<form\b',html,re.I),(SLUG,"unexpected_form_surface")
required_headers={
  "strict-transport-security":headers.get("strict-transport-security",""),
  "content-security-policy":headers.get("content-security-policy",""),
  "x-content-type-options":headers.get("x-content-type-options",""),
}
assert all(required_headers.values()),(SLUG,"missing_security_headers",required_headers)
assert "nosniff" in required_headers["x-content-type-options"].lower()

# P08: target-specific static SBOM/SCA applicability/provenance.
same_origin_assets=sorted(set(re.findall(r'(?:src|href)=["\'](/[^"\']+)["\']',html,re.I)))
external_assets=sorted(set(re.findall(r'(?:src|href)=["\'](https?://[^"\']+)["\']',html,re.I)))
external_noncanonical=[u for u in external_assets if not u.startswith(BASE+"/")]
assert not external_noncanonical,(SLUG,"unexpected_external_asset",external_noncanonical)
sbom={
  "bomFormat":"CycloneDX","specVersion":"1.5","version":1,
  "metadata":{"component":{"type":"file","name":SLUG,"version":blob}},
  "components":[
    {"type":"file","name":f"{SLUG}/index.html","hashes":[{"alg":"SHA-256","content":source_sha256}]},
    {"type":"file","name":"product.css","hashes":[{"alg":"SHA-256","content":hashlib.sha256(css_text.encode()).hexdigest()}]},
  ],
  "properties":[
    {"name":"zevanory.sca","value":"NOT_APPLICABLE_STATIC_NO_PACKAGE_ECOSYSTEM"},
    {"name":"zevanory.same_origin_assets","value":str(len(same_origin_assets))},
    {"name":"zevanory.git_blob","value":blob},
    {"name":"zevanory.workflow_sha","value":SHA},
  ]
}

# P09: public legal surfaces + links from the target.
for legal_path,needle in [("privacidade","lgpd"),("termos","consum"),("reembolso","reembolso")]:
    assert f'href="/{legal_path}"' in live_text,(SLUG,"missing_legal_link",legal_path)
    c,b,h,x=get(f"{BASE}/{legal_path}"); assert c==200
    assert needle in b.decode("utf-8","replace").lower(),(legal_path,needle)

# P11: repeated live latency and fail-closed first-render posture.
lat=[ms]
for _ in range(2):
    c,b,h,x=get(f"{BASE}/{SLUG}"); assert c==200; lat.append(x)
p95=sorted(lat)[-1]
assert p95 < 5000,(SLUG,"latency_budget",lat)

# Shared exact runtime identity used only for shared-layer controls.
c,release,_,_=get(f"{BASE}/api/release"); assert c==200
rel=json.loads(release.decode())
runtime_sha=str(rel.get("deployment",{}).get("commit_sha","")).lower()
assert re.fullmatch(r"[0-9a-f]{40}",runtime_sha),rel
c,sales_body,_,_=get(f"{BASE}/api/sales/status"); assert c==200
sales=json.loads(sales_body.decode())
expected_sales="enabled" if sales.get("open") is True else "globally-blocked"
assert rel.get("sales_mode")==expected_sales,(rel,sales)
c,health,_,_=get(f"{BASE}/api/health"); assert c==200
healthj=json.loads(health.decode())
assert healthj.get("live") is True and healthj.get("ready") is True,healthj

# P13 DIGITAL_CONTENT profile: no product data collection or persistent input surface.
assert not re.search(r'<(form|input|textarea|select)\b',html,re.I)
assert "localStorage" not in html and "sessionStorage" not in html
data_profile={
  "classification":"STATIC_PUBLIC_CONTENT_NO_PERSISTENT_PRODUCT_DATA",
  "collection_surface":"NONE",
  "browser_storage":"NONE_IN_SOURCE",
  "legal_privacy_surface":f"{BASE}/privacidade",
  "retention":"NOT_APPLICABLE_NO_PRODUCT_DATA_COLLECTED",
  "lineage":{"source":f"{SLUG}/index.html","git_blob":blob,"workflow_sha":SHA},
}

pathlib.Path("evidence").mkdir(exist_ok=True)
pathlib.Path(f"evidence/{SLUG}-sbom.cdx.json").write_text(json.dumps(sbom,indent=2)+"\n")
report={
  "schema":"zevanory.portfolio.target-base-cert.v2","target":SLUG,"workflow_sha":SHA,
  "url":f"{BASE}/{SLUG}","source_blob":blob,"source_sha256":source_sha256,
  "live_binding":live_contract["live_binding"],"certification_context":CONTEXT,
  "contract_version":live_contract["contract_version"],"live_contract":live_contract,"latency_ms":lat,"p95_latency_ms":p95,
  "shared_runtime_release":runtime_sha,"sales_mode":rel.get("sales_mode"),
  "security_headers":required_headers,"data_governance":data_profile,
  "checks":{"P01":"PASS","P05":"PASS","P07":"PASS","P08":"PASS","P09":"PASS","P11":"PASS","P13":"PASS"},
  "false_green":0
}
pathlib.Path(f"evidence/{SLUG}-base-cert.json").write_text(json.dumps(report,indent=2)+"\n")
for k,v in report["checks"].items(): print(f"{SLUG}:{k}={v}")
print("FALSE_GREEN=0")
