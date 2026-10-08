#!/usr/bin/env python3
"""Owner rule (2026-10-08): every ARBM One / ZEVANORY system must be 100% free.

Fails CI if a change reintroduces a known paid dependency into runtime defaults,
deploy configuration or availability quorum. Free tiers allowed: Cloudflare Workers
Free, Render free, Netlify free, Gemini without billing, Azure Speech F0 (only with
explicit confirmation), Resend free, GitHub Actions (public repo), Meta service replies.
"""
import json, re, sys
from pathlib import Path

fail = []
def check(cond, msg):
    if not cond: fail.append(msg)

router = Path("worker/voice-provider-router.mjs").read_text(encoding="utf-8")
check('const DEFAULT_CHAIN = Object.freeze(["gemini"]);' in router, "voice default chain must be free (gemini only)")
check('const ZERO_SPEND_PROVIDERS = Object.freeze(["gemini", "azure"]);' in router, "zero-spend provider allowlist changed")
check("167-172-146-60" not in router, "paid DigitalOcean relay default reintroduced in voice router")

deploy_sources = {p: Path(p).read_text(encoding="utf-8") for p in (
    "scripts/deploy/prepare-central-candidate.py",
    ".github/workflows/mercadopago-exact-sha-recovery.yml",
)}
for path, src in deploy_sources.items():
    for chain in re.findall(r'VOICE_TTS_PROVIDER_CHAIN"\]\s*=\s*"([^"]*)"', src):
        bad = {"speechify", "piper-relay"} & set(chain.split(","))
        check(not bad, f"{path}: paid voice provider in chain: {sorted(bad)}")
    check("167-172-146-60" not in src, f"{path}: paid DigitalOcean relay URL reintroduced")
    check('VOICE_TTS_PROVIDER"]="piper-relay"' not in src, f"{path}: paid relay set as primary voice provider")

runtime = Path("worker/cloudflare-worker.recovered.mjs").read_text(encoding="utf-8")
check("167-172-146-60" not in runtime, "paid DigitalOcean relay default reintroduced in runtime")

quorum = json.loads(Path("evidence/three-provider-quorum.json").read_text(encoding="utf-8"))
for p in quorum["providers"]:
    if p.get("enabled", True):
        check(p["provider"] in {"cloudflare", "render", "netlify"}, f"quorum provider without a free tier enabled: {p['provider']}")

# Workers Free: no paid-only Cloudflare products in the sales/router configs.
for cfg in Path(".").glob("wrangler*.toml"):
    txt = cfg.read_text(encoding="utf-8")
    for paid in ("usage_model", "[[durable_objects", "[[queues", "[[hyperdrive", "[[vectorize", "[browser]"):
        check(paid not in txt, f"{cfg}: paid/plan-dependent Cloudflare feature {paid}")

if fail:
    for f in fail: print("::error title=ZERO_SPEND_GUARD::" + f)
    sys.exit(1)
print("ZERO_SPEND_GUARD=PASS")
