# R143 | NC-R142-01 and NC-R142-02 corrections
Base PR #977, original branch head a2a21e6dc9f4c71fdcbc6aac0b6e19d450df9cce. Single corrective push; Draft only.

## Privacy correction
The matcher in worker/site-chat.mjs now checks a lowercase NFD-normalized copy with combining marks removed, including diagnostico, depressao, evangelico, homossexual and biometria. It replaces the entire original message with "[conteúdo sensível removido]" before zevanory_site_chat_messages.body and sanitizes it again before the official ZEV transcript/outbox. It preserves the sensitive_data category and existing CPF, card and password masking. Privacy notice remains bounded: automatic detection is not exhaustive.

SC19 tests the literal phrases "meu diagnóstico de depressão", "sou evangélico", "sou homossexual", "biometria facial", as well as earlier examples. The real PostgreSQL integration test checks both the exact saved body and the PENDING ZEV outbox payload; every scenario uses a distinct local synthetic IP and mailbox, avoiding rate-limit false failures. No production provider/network is used.

## Activation script removed
scripts/owner/chat-fase-b.ps1 was deleted entirely from this PR by operator decision. It belongs in the owner's local Downloads/ZEVANORY_CHAT_FASE_B folder, outside version control. This PR does not install or execute it. The SG01 no-synthetic/no-auto-enable guard remains unchanged. No workflow or Wrangler deployment settings modified.

## CI / governance
Exact Node manifest remains 1086; chat unit baseline remains 34; two PostgreSQL official tests; all 56 existing site-chat mutants remain unchanged. Governance checks session-guard, verification-with-credentials and merge-impact are not bypassed. CI green must be verified for the exact new SHA, excluding governance explicitly accepted by owner. No merge, deploy, secrets, Cloudflare operation or cost.
