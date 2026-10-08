#!/usr/bin/env python3
"""Owner rule (2026-10-08): every ZEVANORY / ARBM One system must run at zero cost.
Fails CI if a change reintroduces a known paid dependency. Free tiers in use:
Cloudflare Workers Free, Render free, Netlify free, Gemini free tier (no Cloud billing),
Resend free, Neon/Supabase free, GitHub Actions (public repo), Meta WhatsApp service window."""
import json, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
fail = []
def text(p): return (ROOT / p).read_text(encoding="utf-8", errors="replace")
RUNTIME = [p for p in (ROOT / "worker").glob("*.mjs")] + [ROOT / "sales-worker.mjs"]
DEPLOY = [ROOT / "scripts/deploy/prepare-central-candidate.py", *(ROOT / ".github/workflows").glob("*.yml")]

# 1. Paid DigitalOcean relay (droplet 602725296) must not be referenced by runtime or deploy code.
for p in RUNTIME + DEPLOY:
    if p.exists() and "167-172-146-60" in p.read_text(encoding="utf-8", errors="replace"):
        fail.append(f"paid_digitalocean_relay_referenced:{p.relative_to(ROOT)}")
q = json.loads(text("evidence/three-provider-quorum.json"))
for prov in q["providers"]:
    if prov["provider"] == "digitalocean" and prov.get("enabled", True):
        fail.append("paid_digitalocean_quorum_node_enabled")
if sum(1 for p in q["providers"] if p.get("enabled", True)) < q.get("min_quorum", 3):
    fail.append("free_quorum_below_minimum")

# 2. Paid TTS providers may never be marked as enabled in production config.
deploy = text("scripts/deploy/prepare-central-candidate.py")
for flag in ("SPEECHIFY_FREE_TIER_CONFIRMED", "AZURE_SPEECH_FREE_TIER_CONFIRMED"):
    if re.search(rf'{flag}"\]\s*=\s*"true"', deploy):
        fail.append(f"paid_tts_enabled:{flag}")
chain = re.search(r'c\["vars"\]\["VOICE_TTS_PROVIDER_CHAIN"\]="([^"]*)"', deploy)
if not chain or set(chain.group(1).split(",")) - {"gemini"}:
    fail.append("voice_chain_must_be_free_gemini_only")
if 'VOICE_TTS_FREE_ONLY' in deploy and re.search(r'VOICE_TTS_FREE_ONLY"\]\s*=\s*"false"', deploy):
    fail.append("zero_spend_voice_guard_disabled")

# 3. Cloudflare must stay on Workers Free features.
for w in ROOT.glob("wrangler*.toml"):
    s = w.read_text(encoding="utf-8")
    if re.search(r'usage_model\s*=\s*"(standard|unbound)"', s) or re.search(r"\[\[(durable_objects|queues)", s) or "[limits]" in s:
        fail.append(f"cloudflare_paid_feature:{w.name}")

# 4. WhatsApp: only free service-window replies; billed template messages are forbidden.
for p in RUNTIME:
    if re.search(r'type\s*:\s*"template"', p.read_text(encoding="utf-8", errors="replace")):
        fail.append(f"whatsapp_paid_template:{p.relative_to(ROOT)}")

# 5. No live payment-provider subscription keys or paid SaaS tiers committed.
for p in RUNTIME:
    if re.search(r"sk_live_[0-9A-Za-z]{8,}", p.read_text(encoding="utf-8", errors="replace")):
        fail.append(f"stripe_live_key:{p.relative_to(ROOT)}")

if fail:
    print("ZERO_COST_GUARD=FAIL"); [print(" -", f) for f in fail]; sys.exit(1)
print("ZERO_COST_GUARD=PASS")
