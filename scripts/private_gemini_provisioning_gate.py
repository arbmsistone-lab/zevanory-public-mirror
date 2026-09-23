#!/usr/bin/env python3
from pathlib import Path
w=Path("worker/cloudflare-worker.recovered.mjs").read_text(encoding="utf-8")
p=Path("voice-provision.html").read_text(encoding="utf-8")
checks={
 "owner_proxy_post": 'x-zevanory-owner-authenticated' in w and 'return true;' in w,
 "private_page": '"/voice-provision"' in w,
 "private_alias": '["/voice-provision", "/voice-provision.html"]' in w,
 "vault_endpoint": "/private-api/internal/ai-vault" in p,
 "password_input": 'type="password"' in p,
 "no_secret_echo": "textContent=secret" not in p and "innerHTML=secret" not in p,
 "provider_gemini": "provider:'gemini'" in p,
 "noindex": 'noindex,nofollow' in p
}
bad=[k for k,v in checks.items() if not v]
assert not bad, bad
print("PRIVATE_GEMINI_PROVISIONING_GATE=PASS")
