# EG-0077 — Nuvemshop Cloudflare OAuth and privacy closure

Status: APPROVED WITH RESTRICTIONS for corrective implementation only. Production authorization and completion remain UNPROVEN.
Date: 2026-09-12.

## Independent evidence
1. Nuvemshop primary OAuth and webhook contracts: https://nuvemshop.dev/api/authentication and https://nuvemshop.dev/api/resources/2025-03/webhook. Authorization codes expire in five minutes; state protects CSRF; privacy notifications may omit event; duplicate deliveries must be unique.
2. IETF primary OAuth security contract: https://www.rfc-editor.org/rfc/rfc6749, sections 10.5 and 10.12. Authorization codes and CSRF sessions require single use, authenticated binding, and expiry.
3. Cloudflare primary runtime/secrets contract: https://developers.cloudflare.com/workers/configuration/secrets/ and https://developers.cloudflare.com/workers/best-practices/workers-best-practices/. Secrets belong in bindings, and redirects must not hide runtime failures.
4. Vercel primary custody contract: https://vercel.com/docs/environment-variables/sensitive-environment-variables. Sensitive values cannot be exported through the management API; an authorized isolated build can consume the existing values without changing them.

## Reproduced observations
GitHub and GitLab main: 3a60e56067d652e513d654cac6762a274ad1ee3a. Canonical worktree is clean. Previous Nuvemshop worktree has an uncommitted Vercel delegation and is preserved.
Production OAuth start/callback return 308 to themselves. Cloudflare version 36e24782-44e0-4620-b821-7891342b7326 lacks all three required OAuth secrets. Vercel zevanory-site has them as sensitive variables.
Canonical DB has zero Nuvemshop/LinkedIn credentials. Existing encryption key will nevertheless be transferred unchanged; no key regeneration or token fabrication is permitted.
Focused baseline: 24 tests PASS. Existing main CI fails before executing steps; cause still under investigation.

## Authorized corrections
Native Cloudflare routing; exact existing secret transfer over TLS from an unpromoted complete-source maintenance build; durable single-use OAuth session claims; bounded sanitized provider errors; store identity/read-only API validation; privacy-specific authenticated URLs; durable deduplication and audit without storing customer payloads.
No live authorization or webhook delivery may be inferred from configuration or synthetic tests. All commercial switches remain false. Nuvemshop remains backlog_excluded until every required production proof passes.

## Corrective implementation and verified limits

- API resource version: 2025-03, from official Nuvemshop resources. Store owner email is obtained only after numeric store and canonical domain validation, encrypted in the merchant connection and removed on store redaction. Customer payloads, identifiers, emails, phone numbers and orders are never persisted by these handlers.
- Resend official primary reference: https://resend.com/docs/api-reference/emails/send-email . A customers/data_request produces an empty customer-content report directly to the verified merchant. Missing recipient, missing configuration, transport error or logical success without a message ID returns failure; no privacy-delivery proof is inferred from a webhook 200.
- Cloudflare rejected the secret write with code 10055: 64 variables already in use. Three public Nuvemshop fields were grouped into the existing JSON binding; all 20 existing secrets were inherited and verified preserved; app ID 41672 was established. Original encryption key remains mandatory and was not regenerated.
- Vercel maintenance attempts dpl_2q65z7ux3yF6EUVy16byVpGwi5sA and dpl_7oNS5m8QYLbDqoN1RRgvMQY6rV7u failed at the Cloudflare write, with no token output. Further creation was rejected with api-deployments-free-per-day (402). No quota circumvention or alternate credential was used.
- GitHub quality run 34719004748 did not start: account billing/spending restriction. GitLab pipeline 2843681894 jobs did not start: ci_quota_exceeded. These are failures, not passed validation.
- Initial baseline 3a60e56067d652e513d654cac6762a274ad1ee3a was advanced without rewriting history to 19299f7db1042aec53e1616e48490d7d632a5179 and 78972099a934120fa95abc69faa98909af23ac32, preserving concurrent API/config changes and remote parity.
- Backlog exclusion remains in effect; SALE_GLOBALLY_ENABLED, CHECKOUT_ENABLED and FINANCIAL_EVENTS_ENABLED remain false. Production OAuth, API, provider-origin webhooks and portal consent remain UNPROVEN until live evidence is captured.
