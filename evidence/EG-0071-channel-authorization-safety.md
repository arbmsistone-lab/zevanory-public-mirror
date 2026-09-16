# EG-0071 — Channel authorization and failover safety

Date: 2026-09-11. Evidence gate: APPROVED WITH RESTRICTIONS for implementation and isolated tests only. No production certification or commercial authorization.

## Independent primary evidence

1. IETF RFC 9700, https://www.rfc-editor.org/rfc/rfc9700.html — OAuth authorization, CSRF protection and token security remain mandatory across routing alternatives.
2. Microsoft LinkedIn OAuth and token introspection, https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection — a real active token and granted scopes must be verified; configuration is not authorization.
3. Nuvemshop authentication, https://tiendanube.github.io/api-documentation/authentication — store authorization returns a store ID and scopes; write scope implies read scope; the token has no synthetic expiration.
4. Buffer authentication, https://developers.buffer.com/guides/authentication.html — server-side API authentication is required; channel configuration alone proves neither connection nor delivery.

## Observed defects and permitted repairs

- The global commercial gate was checked inside direct adapters, while the universal router could then try Buffer or another adapter after that rejection. Check the global gate before selecting any provider.
- Buffer responses lacking a provider ID or explicit status must not invent a scheduled state or allow blind rerouting after a potentially accepted mutation. Bound network time, redact provider error text and require reconciliation after ambiguity.
- Nuvemshop product creation must not assume idempotency support merely because a request sends an idempotency header. Until a provider contract proves deduplication, uncertain product creation cannot be replayed automatically.
- Read-only provider probes must report token, identity, scope and API findings separately from execution proof. Sandbox, manual assistance, CSV and missing credentials never count as automatic execution.

## Current live findings, not a certification

Public closure status: technical_ready=true, operational_ready=true, configured_fronts=12, automation_ready_fronts=9; commercial_enabled=false. Canonical credential query: only tiktok_sandbox exists for these fronts, with user.info.basic and expiry 2026-09-09T20:37:59.859Z.

TikTok production authorization returned unauthorized_client / client_key. Nuvemshop reached the provider login but Google SSO returned HTTP 401. LinkedIn production app credentials are absent. No provider publication or sale was performed.

GitHub CI for 41d98e39d01a54d6fb31cd4059bdd7f7689fbfbc never started due to account billing restrictions. Vercel Hobby is an alternative remote verification route, subject to actual run success. Production alias was dpl_Ad7LnH8zAAiWPKhKEFj6FRBTxRKP, reporting source SHA 4e46dffdb5b6d5681d26438822236a063454a582. Parity with origin/main is not certified.

## Promotion and rollback

Require relevant tests, remote regression, provider probes and runtime parity before promotion. Preserve all sales switches. Rollback by a normal revert of the isolated repair commit, never by rewriting published history. Any failing or unexecuted gate keeps closeout BLOCKED.
