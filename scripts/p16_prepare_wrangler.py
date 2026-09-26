#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

mode, src, dst = sys.argv[1:4]
assert mode in ("asaas","mercadopago")
sha=os.environ["EXPECTED_SHA"].lower()
assert len(sha)==40
c=json.load(open(src,encoding="utf-8"))
c["main"]="worker/cloudflare-worker.compat.mjs"
c.pop("secrets",None)
c["services"]=[{"binding":"WHATSAPP_BROKER","service":"giro-whatsapp-bridge"}]
c.pop("ai",None)
c.pop("routes",None)
c["workers_dev"]=True
for ns in c.get("kv_namespaces",[]):
    if ns.get("binding")=="ZEVANORY_PRIVATE_ARTIFACTS":
        ns["id"]="9eca336262b44186ab3dbec82fc35ab4"
v=c.setdefault("vars",{})
v["ZEVANORY_RELEASE_SHA"]=sha
v["ZEVANORY_RELEASE_REF"]="gh-pages"
v["ZEVANORY_DEPLOYMENT_ENV"]="production"
v["CERTIFICATION_PILOT_ENABLED"]="true"
v["CERTIFICATION_PILOT_ENV"]="sandbox"
v["CERTIFICATION_PILOT_APPROVER"]="zevanory-certification-e2e"
v["CERTIFICATION_PILOT_AMOUNT_BRL"]="5"
v["CERTIFICATION_PILOT_PAYMENT_MODE"]="sandbox"
v["MERCADOPAGO_ENV"]="sandbox"
v["STRIPE_ENV"]="sandbox"
v["PAYMENT_PROVIDER"]=mode
v["PAYMENT_PROVIDER_POOL"]=mode
if mode=="asaas":
    v["ASAAS_ENV"]="sandbox"
else:
    v.pop("ASAAS_ENV",None)
v["PUBLIC_BASE_URL"]="https://zevanory.api.br"
v["CHECKOUT_ENABLED"]="true"
v["FINANCIAL_EVENTS_ENABLED"]="true"
v["SALE_GLOBALLY_ENABLED"]="false"
v["PRE_SALE_GATES_APPROVED"]="false"
v["WHATSAPP_SALES_ENABLED"]="false"
v["ZEVANORY_WHATSAPP_E164"]="+5588992545413"
v["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"
v["ZEVANORY_WHATSAPP_COUNTRY"]="BR"
v.pop("SUPPORT_CHANNEL",None)
v["VOICE_TTS_PROVIDER"]="piper-relay"
v["VOICE_TTS_PROVIDER_CHAIN"]="speechify,azure,piper-relay,gemini"
v["VOICE_TTS_FAILOVER_ENABLED"]="true"
v["GEMINI_FREE_TIER_CONFIRMED"]="false"
v["VOICE_TTS_MODEL"]="pt_BR-jeff-medium"
v["VOICE_TTS_PIPER_MODEL"]="pt_BR-jeff-medium"
v["VOICE_TTS_VOICE"]="jeff"
v["VOICE_TTS_PIPER_VOICE"]="jeff"
v["VOICE_TTS_RELAY_URL"]="https://tts.167-172-146-60.sslip.io"
for unused in ("KNOWLEDGE_SEED_ALLOWED","SPEECHIFY_FREE_TIER_CONFIRMED","AZURE_SPEECH_FREE_TIER_CONFIRMED"):
    v.pop(unused,None)
Path(dst).write_text(json.dumps(c,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
print("P16_RUNTIME_CONFIG_MODE="+mode)
print("P16_RUNTIME_CONFIG_SHA="+sha)
