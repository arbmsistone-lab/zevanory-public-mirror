#!/usr/bin/env python3
import json,os,re,sys
from pathlib import Path
sys.dont_write_bytecode = True  # never leave __pycache__/*.pyc in the checkout
sys.path.insert(0, str(Path(__file__).resolve().parent))
from public_whatsapp_scan import public_whatsapp_hits  # noqa: E402  (fail-closed public asset scan)
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
# Fase 0 is read-only producer, separate from both financial proof crons.
if "5,35 * * * *" not in crons:
    crons.append("5,35 * * * *")
# Workers Free: 5 cron triggers per ACCOUNT (shared with other Workers). Never add
# a trigger here; acquisition shares the isolated "5,35" invocation (:35 tick).
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
c["vars"]["WHATSAPP_SALES_ENABLED"]="false"  # WhatsApp retired (PR #896): channel closed for good, never "true"
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
# WhatsApp is retired (Meta disabled the WABA on 2026-10-10; docs/WHATSAPP_APOSENTADO.md). The
# generator never assigns a WhatsApp contact alias, and it strips the legacy ones the base config
# (83620c6 wrangler.jsonc: SUPPORT_CHANNEL with the old number) still carries. Support channel is
# the constant suporte@zevanory.api.br in the worker. Guard: tests/whatsapp-config-absence.test.mjs.
# The same base also ships three WhatsApp Cloud API settings inside ZEVANORY_RUNTIME_CONFIG (83620c6 wrangler.jsonc
# lines 54/67/69). With the retirement a hard-coded constant (worker/whatsapp-retirement.mjs) nothing reads them for
# a live path, so they are dropped from `vars` and from the runtime config. Exact names only: META_VERIFY_TOKEN (the
# shared Instagram/Facebook webhook verify token), META_APP_SECRET01, META_GRAPH_VERSION, FACEBOOK_* and INSTAGRAM_*
# are NOT WhatsApp settings and must survive (guard test "no over-stripping" in the same file).
RETIRED_WHATSAPP_META_KEYS = (
    "WHATSAPP_PHONE_NUMBER_ID",
    "META_WHATSAPP_IDENTITY_VERIFIED",
    "WHATSAPP_BRAND_IDENTITY_VERIFIED",
)
def _retired_whatsapp_alias(key):
    return key == "SUPPORT_CHANNEL" or key.startswith("ZEVANORY_WHATSAPP_") or key in RETIRED_WHATSAPP_META_KEYS
for _bag in (c["vars"], runtime):
    for _key in [k for k in _bag if _retired_whatsapp_alias(k)]:
        _bag.pop(_key)

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
# WhatsApp retired (PR #896): the banned account's number must not appear on any public page, in any
# format. The apex public/ tree is the FROZEN 83620c6 snapshot (not the page sources in this repo), so the
# generator neutralizes its two known WhatsApp surfaces here and then fails closed on anything left
# (scripts/deploy/public_whatsapp_scan.py, after the overlay below; scanned again after the full build in central-candidate-dryrun).
#  * whatsapp-contact.js (wa.me CTA injector, loaded by 19 snapshot pages) -> RETIRED: the file is no
#    longer published and every reference is stripped from the pages, because browsers kept OLD copies
#    of it (cached with a long lifetime) and a cached page that still references it would run them.
#    The central Worker answers the old path with an inert no-store tombstone
#    (worker/retired-public-assets.mjs); docs/evidence/sales-ux/legacy-cache.md has the measurement.
#  * index.html JSON-LD Organization telephone/ContactPoint -> e-mail only.
RETIRED_CONTACT_SCRIPT = "whatsapp-contact.js"
RETIRED_CONTACT_TAG = re.compile(r'[ \t]*<script\b[^>]*\bsrc="/whatsapp-contact\.js"[^>]*>\s*</script>[ \t]*\n?')
# Build-time parity with what the e-mail-only copy did at runtime on those pages: every
# a[href^="mailto:contato@zevanory.api.br"] became href="mailto:suporte@zevanory.api.br".
LEGACY_CONTACT_MAILTO = re.compile(r'href="mailto:contato@zevanory\.api\.br[^"]*"')
Path("public", RETIRED_CONTACT_SCRIPT).unlink(missing_ok=True)
for page in sorted(Path("public").rglob("*.html")):
    raw = page.read_bytes().decode("utf-8")
    stripped = RETIRED_CONTACT_TAG.sub("", raw)
    if stripped != raw:
        stripped = LEGACY_CONTACT_MAILTO.sub('href="mailto:suporte@zevanory.api.br"', stripped)
        page.write_bytes(stripped.encode("utf-8"))
home = Path("public/index.html")
if home.exists():
    raw = home.read_bytes().decode("utf-8")
    new_home = re.sub(r'"@type":"ContactPoint","telephone":"[^"]*"', '"@type":"ContactPoint","email":"suporte@zevanory.api.br"', raw)
    new_home = re.sub(r',"telephone":"[^"]*"', "", new_home)
    if new_home != raw:
        home.write_bytes(new_home.encode("utf-8"))

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
_wa_hits = public_whatsapp_hits("public")
if _wa_hits:
    raise SystemExit("PUBLIC_WHATSAPP_CONTACT_PRESENT " + " ".join(_wa_hits))
print("PUBLIC_WHATSAPP_FREE=PASS")
# Fail closed: no published text asset may name the retired script (a tag the regex above did not
# match, a preload, a JS loader...). Runs after the WhatsApp scan so a leftover injector is reported there.
_retired_refs = sorted(
    p.as_posix() for p in Path("public").rglob("*")
    if p.is_file() and (p.name == RETIRED_CONTACT_SCRIPT or RETIRED_CONTACT_SCRIPT.encode() in p.read_bytes())
)
if _retired_refs:
    raise SystemExit("PUBLIC_RETIRED_CONTACT_SCRIPT_REFERENCED " + " ".join(_retired_refs))
print("PUBLIC_RETIRED_CONTACT_SCRIPT=ABSENT")

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
# Preserve both preexisting public values without spending standalone Worker
# variable slots. normalizeEnv reads ZEVANORY_RUNTIME_CONFIG for their old names.
# Do not compact secret bindings or change any sales/financial safety gates.
# AGENT_AUTONOMY_MODE (12/10): frees the slot for the owner-authorized GEMINI_API_KEY secret.
# Its code default is "guarded" (the safest mode) if the runtime config were ever unreadable.
# AGENT_AI_MAX_RUNS_PER_HOUR (13/10, T3): frees the slot taken by the owner-authorized
# LEAD_PRIVACY_SECRET (budget 61/60 blocked run 38459418578). Single reader, runAgentOnce:
# Number(env.AGENT_AI_MAX_RUNS_PER_HOUR) || 100, where env is options.env || process.env (raw
# bindings, which do NOT see ZEVANORY_RUNTIME_CONFIG). The compacted name is then absent and the
# default 100 applies, equal to the configured "100": the cap is unchanged either way.
for key in ("ZEVANORY_RELEASE_REF", "AGENT_AUTONOMY_MODE", "AGENT_AI_MAX_RUNS_PER_HOUR"):
    if key in c["vars"]:
        runtime_config[key] = c["vars"].pop(key)

open(p,"w").write(json.dumps(c,indent=2)+"\n")
