# R142 | NC-R141-PRIV-01 and Fase B preparation (NO-GO until audited)
Base: gh-pages b2a13bc14f5efa3803da8f50f72eea558319ec62; Draft only, no merge, deployment, secrets or costs.

Detected sensitive topics in worker/site-chat.mjs redactSensitive() replace the entire message with "[conteúdo sensível removido]" before insertion in zevanory_site_chat_messages.body. The official ZEV transcript is scrubbed again before registering atendimento and writing the durable outbox payload. Detection is finite and cannot guarantee removing all possible private information. Structured CPF, CNPJ, valid cards, password-like fields, email and telephone retain their existing masking.

PostgreSQL real regression is the second test in tests/integration/r122-official-chat-postgres.test.mjs, using an unreachable fake Resend to keep outbox payload pending and assert that sensitive samples do not survive; never touches production. SC19 in tests/site-chat.test.mjs checks topic detection and preservation of category. Manifest updated, all existing 56 mutants preserved, chat baseline now 34.

The opt-in text now specifies automatic masking for recognized data and entire-message replacement when certain sensitive topics are detected, with limitations.

scripts/owner/chat-fase-b.ps1 is ASCII-only PowerShell 5.1. No parameters: read-only secret names from central and sales Workers. -Preparar: both SITE_CHAT_ENABLED=false, other central flags configured and Turnstile sitekey 0x4AAAAAAF2sozEg8we6MsOP via Workers Secrets; Turnstile private secret typed ONLY in Wrangler prompt by owner. -Ligar: enabled=true both Workers. -Desligar: false both. Each put creates a Worker deployment; script is NOT executed by this PR. List/readback shows NAMES, NOT VALUES. It cannot establish actual secret values or runtime health. Before -Ligar, a separate human-authorized readback of all dependencies, Turnstile and no-cost budget is required. No implicit authorization for any operation.
