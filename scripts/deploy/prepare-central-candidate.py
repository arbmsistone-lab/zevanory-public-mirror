#!/usr/bin/env python3
import json,os,re
from pathlib import Path
p="wrangler.central-fix.jsonc"
c=json.load(open(p))
c["account_id"]=os.environ["PUBLIC_OWNER_ACCOUNT_ID"]
c["main"]="worker/cloudflare-worker.compat.mjs"
# Keep the existing hourly maintenance cron; the financial-only cron runs at
# minute 15 and 45, each in a separate Cloudflare Worker invocation.
triggers=c.setdefault("triggers",{})
crons=triggers.setdefault("crons",[])
if "0 * * * *" not in crons:
    # Minimal test fixtures have no inherited cron; restore canonical hourly
    # task scheduling instead of aborting before launch authorization checks.
    crons.insert(0,"0 * * * *")
if "15,45 * * * *" not in crons:
    crons.append("15,45 * * * *")
if len(crons)>5:
    raise SystemExit("CRON_TRIGGER_FREE_LIMIT_EXCEEDED")
c.pop("secrets",None)
c["services"]=[
    {"binding":"SELF","service":"zevanory"},
]
c["ai"]={"binding":"AI"}
c.pop("routes",None)
c["workers_dev"]=True
kv=c.setdefault("kv_namespaces",[])
found_private=False
for ns in kv:
    if ns.get("binding") in ("ZEVANORY_PRIVATE_ARTIFACTS","ZEVANORY_ARTEFATOS_PRIVADOS"):
        ns["binding"]="ZEVANORY_PRIVATE_ARTIFACTS"
        ns["id"]="728a45738e4047f29bcb89934fd533c1"
        found_private=True
if not found_private:
    kv.append({"binding":"ZEVANORY_PRIVATE_ARTIFACTS","id":"728a45738e4047f29bcb89934fd533c1"})
c.setdefault("vars",{})["ZEVANORY_RELEASE_SHA"]=os.environ["TARGET_RUNTIME_SHA"]
c["vars"]["ZEVANORY_RELEASE_REF"]="gh-pages"
c["vars"]["ZEVANORY_DEPLOYMENT_ENV"]="production"
c["vars"]["CERTIFICATION_PILOT_ENV"]="sandbox"
# Dedicated Asaas financial-certification probes must never default to the live API.
c["vars"]["ASAAS_ENV"]="sandbox"
c["vars"]["CERTIFICATION_PILOT_APPROVER"]="zevanory-certification-e2e"
# The future launch configuration is dormant unless explicitly authorized.
# This PR must not be merged before the owner's AUTORIZO COMPRA REAL instruction.
launch_authorized=os.environ.get("ZEVANORY_LAUNCH_AUTHORIZATION","")=="AUTORIZO COMPRA REAL"
if launch_authorized:
    collector_hash=os.environ.get("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16","").lower()
    if not re.fullmatch(r"[0-9a-f]{16}",collector_hash):
        raise SystemExit("LAUNCH_COLLECTOR_PROOF_MISSING")
    if os.environ.get("MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED")!="true":
        raise SystemExit("LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED")
    c["vars"]["MERCADOPAGO_ENV"]="production"
    # Respect Workers Free binding budget: hash is read through normalizeEnv runtime alias.
    c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{})["MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16"]=collector_hash
    c["vars"].pop("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16",None)
else:
    c["vars"]["MERCADOPAGO_ENV"]="sandbox"
    c["vars"].pop("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16",None)
    c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{}).pop("MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16",None)
c["vars"]["CERTIFICATION_PILOT_PRODUCTION_ALLOWED"]="false"
c["vars"]["ABSOLUTE_RELEASE_APPROVED"]="false"
c["vars"]["PAYMENT_PROVIDER"]="mercadopago"
c["vars"]["CHECKOUT_ENABLED"]="true"
c["vars"]["FINANCIAL_EVENTS_ENABLED"]="true"
c["vars"]["SALE_GLOBALLY_ENABLED"]="false"
c["vars"]["PRE_SALE_GATES_APPROVED"]="false"
# Override only AFTER closed-by-default flags are established.
# This never opens sales: the separate, owner-authorized KV switch is mandatory.
if launch_authorized:
    c["vars"]["ABSOLUTE_RELEASE_APPROVED"]="true"
    c["vars"]["PRE_SALE_GATES_APPROVED"]="true"
c["vars"]["WHATSAPP_SALES_ENABLED"]="true"  # Inbound-only owner-authorized support and catalog sales; KV controls checkout
c["vars"]["ZEVANORY_WHATSAPP_DISPLAY"]="+55 88 99254-5413"
c["vars"]["SUPPORT_CHANNEL"]="WhatsApp +55 88 99254-5413"
runtime=c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{})
if not isinstance(runtime,dict):
    runtime={}
    c["vars"]["ZEVANORY_RUNTIME_CONFIG"]=runtime
for key in (
    "ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED",
    "ARBM_SIST_SECURE_ARTIFACT_READY",
    "CLOUDFLARE_AI_FREE_ONLY",
    "CLOUDFLARE_AI_DAILY_CALL_LIMIT",
    "VOICE_TTS_PROVIDER",
    "VOICE_TTS_PROVIDER_CHAIN",
    "VOICE_TTS_FAILOVER_ENABLED",
    "GEMINI_FREE_TIER_CONFIRMED",
):
    if key in c["vars"]:
        runtime[key]=c["vars"].pop(key)
c["vars"].pop("ZEVANORY_WHATSAPP_E164",None)
c["vars"].pop("ZEVANORY_WHATSAPP_COUNTRY",None)
# SUPPORT_CHANNEL duplicates the canonical ZEVANORY_WHATSAPP_DISPLAY fallback.
c["vars"].pop("SUPPORT_CHANNEL",None)

# Preserve compacted values through normalizeEnv.
aliases=Path("worker/binding-aliases.mjs")
alias_src=aliases.read_text(encoding="utf-8")
alias_src=alias_src.replace(
    '      return Reflect.get(target, prop, receiver);',
    '      const direct = Reflect.get(target, prop, receiver);\n'
    '      if (direct !== undefined) return direct;\n'
    '      const runtime = Reflect.get(target, "ZEVANORY_RUNTIME_CONFIG", receiver);\n'
    '      if (runtime && typeof runtime === "object" && prop in runtime) return runtime[prop];\n'
    '      return undefined;'
)
alias_src=alias_src.replace(
    '      return Reflect.has(target, prop);',
    '      if (Reflect.has(target, prop)) return true;\n'
    '      const runtime = Reflect.get(target, "ZEVANORY_RUNTIME_CONFIG");\n'
    '      return Boolean(runtime && typeof runtime === "object" && prop in runtime);'
)
aliases.write_text(alias_src,encoding="utf-8")

# Preserve dedicated sandbox credentials; never replace them with production credentials.
recovered=Path("worker/cloudflare-worker.recovered.mjs")
recovered_src=recovered.read_text(encoding="utf-8")
recovered_src=recovered_src.replace(
    '    }\n    if (provider === "stripe") {\n',
    '    } else if (provider === "stripe") {\n',
    1
)
recovered_src=recovered_src.replace(
    'const pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_PAYMENT_MODE || "").toLowerCase() === "sandbox";',
    'const pilotSandbox = Boolean(pilot?.authorized) && String(process.env.CERTIFICATION_PILOT_ENV || "").toLowerCase() === "sandbox";'
)
# Repair the legacy health state machine, not the health gates: an authorized
# production checkout can be staged while owner sales and WhatsApp remain closed.
# Fail if the immutable snapshot no longer matches this narrowly reviewed source.
health_anchor = "const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;"
assert recovered_src.count(health_anchor) == 1, "HEALTH_SAFETY_ANCHOR_CHANGED"
recovered_src = (
    'import { safeClosedCommercialStaging } from "./production-health-safety.mjs";\n'
    + recovered_src.replace(
        health_anchor,
        "const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern || safeClosedCommercialStaging(env, ownerSalesOpen, switches);"
    )
)
recovered.write_text(recovered_src,encoding="utf-8")
# Replace every legacy public contact reference in the reconstructed production snapshot.
replacements = {
    "+55 88 9234-0423": "+55 88 99254-5413",
    "558892340423": "5588992545413",
}
changed = []
for asset in Path("public").rglob("*"):
    if not asset.is_file():
        continue
    try:
        raw = asset.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    new = raw
    for old, value in replacements.items():
        new = new.replace(old, value)
    if new != raw:
        asset.write_text(new, encoding="utf-8")
        changed.append(str(asset))
if not changed:
    print("WHATSAPP_NUMBER_CUTOVER_FILES none_needed")
else:
    print("WHATSAPP_NUMBER_CUTOVER_FILES", *changed)

retired_slugs=("zevanory-one","arbm-sist")
for retired_asset in ("public/zevanory-one.html","public/arbm-one.html","public/arbm-sist.html"):
    Path(retired_asset).unlink(missing_ok=True)

solutions_path=Path("public/solucoes.html")
solutions=solutions_path.read_text(encoding="utf-8")
solutions=re.sub(r'<a class="legacy-contract" href="/zevanory-one">ZEVANORY ONE</a>\s*',"",solutions)
for slug in retired_slugs:
    solutions=re.sub(rf'<a class="catalog-card" href="/{re.escape(slug)}">.*?</a>\s*',"",solutions,flags=re.S)
solutions=solutions.replace("ZEVANORY ONE, ARBM SIST, ","")
solutions_path.write_text(solutions,encoding="utf-8")

sitemap_path=Path("public/sitemap.xml")
sitemap=sitemap_path.read_text(encoding="utf-8")
for slug in retired_slugs:
    sitemap=re.sub(rf'\s*<url><loc>https://zevanory\.api\.br/{re.escape(slug)}</loc>.*?</url>',"",sitemap,flags=re.S)
sitemap_path.write_text(sitemap,encoding="utf-8")

assert "ZEVANORY ONE" not in solutions
assert "ARBM SIST" not in solutions
for slug in retired_slugs:
    assert f"https://zevanory.api.br/{slug}" not in sitemap
for retired_asset in ("public/zevanory-one.html","public/arbm-one.html","public/arbm-sist.html"):
    assert not Path(retired_asset).exists()
print("COMMERCIAL_RETIREMENT_OVERLAY=PASS")

c["vars"]["VOICE_TTS_PROVIDER"]="gemini"
c["vars"]["VOICE_TTS_PROVIDER_CHAIN"]="gemini"
runtime_config=c["vars"].setdefault("ZEVANORY_RUNTIME_CONFIG",{})
runtime_config["VOICE_TTS_FAILOVER_ENABLED"]="true"
# Workers Free caps a Worker at 64 variables (secrets + text) and buying the paid plan
# breaks the owner's zero-spend rule, so the voice support switch rides in the compact
# runtime config (resolved by binding-aliases) instead of taking a new variable slot.
if isinstance(runtime_config,dict):
    runtime_config["ZEVANORY_VOICE_SUPPORT_ENABLED"]="true"
# All Google Cloud projects have billing disabled (2026-10-08): the Gemini key can only use the free tier.
runtime_config["GEMINI_FREE_TIER_CONFIRMED"]="true"
c["vars"]["SPEECHIFY_FREE_TIER_CONFIRMED"]="false"
c["vars"]["AZURE_SPEECH_FREE_TIER_CONFIRMED"]="false"
c["vars"].pop("VOICE_TTS_RELAY_URL",None)  # paid DigitalOcean relay retired (zero-cost rule)
for unused in ("KNOWLEDGE_SEED_ALLOWED","SPEECHIFY_FREE_TIER_CONFIRMED","AZURE_SPEECH_FREE_TIER_CONFIRMED"):
    c["vars"].pop(unused,None)
for key in ("VOICE_TTS_PROVIDER", "VOICE_TTS_PROVIDER_CHAIN"):
    runtime_config[key]=c["vars"].pop(key)
open(p,"w").write(json.dumps(c,indent=2)+"\n")
