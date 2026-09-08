# ZEVANORY — Absolute Closure Evidence Pack

Status: IN PROGRESS / FAIL-CLOSED. No sales release authorization.
Baseline SHA: e9351f9adcf6d105b2af941b7a995810f9f24980.
Workspace: C:\Users\airto\AppData\Local\Temp\zev-close-20260908b.
This replaces historical claims; only observations below are current.

## Baseline observations — 2026-09-08, 18:00–18:35 UTC

| Gate | Source / environment | Evidence type | Result | Limitation |
|---|---|---|---|---|
| Git | git status and ls-remote / baseline | CODE | Clean worktree; HEAD and both main branches at baseline SHA | Prior to current edits |
| GitLab CI | pipeline 2830240201, iid 82 / baseline | TEST | success | Baseline only |
| GitHub CI | run 34247455976, job 102132993667 / baseline | PROVIDER | failure; runner_id=0, steps=[] | Provider execution unavailable; not a test failure |
| Vercel | CLI authenticated inspection / production | PRODUCTION | dpl_5nyRAqazUGs4TaDBk2ekB4DuX8Vg READY; githubCommitSha equals baseline; repo ZEVANORY | Baseline only |
| Domain | zevanory.api.br / production | PRODUCTION | Alias points to that deployment; health database/schema true; CSP present | HTTP success is not commercial proof |
| Sales | /api/config / production | PRODUCTION | commercial_enabled=false; global_sale_disabled, pre_sale_gates_open, absolute_release_not_approved | Checkout/financial subsystems enabled under global lock |
| Legal routes | /termos, /privacidade, /reembolso / production | PRODUCTION | HTTP 200, CSP present | Availability only, no legal certification |
| Database | Neon host verified from this worktree; BEGIN READ ONLY | PRODUCTION | orders=2, financial_events=0, service_fulfillment=0, lifecycle_evidence_events=1, customer_lifecycle_events=0, attribution_touchpoints=0, unit_economics_snapshots=0 | No observed payment or fulfillment |
| OAuth | provider_oauth_credentials / production | PRODUCTION | Only mercado_livre and tiktok_sandbox rows; sandbox expired | No production TikTok, LinkedIn or Nuvemshop credential |
| Mercado Livre | local diagnostic | TEST | BLOCKED by redacted encryption key | Not evidence of invalid production key; existing operator token also redacted locally |
| Resend key | local export + Vercel env metadata | PROVIDER | Local value is redaction marker; API rejected marker; real key is Vercel sensitive type | DO NOT rotate on this evidence; production key validity unknown |
| DNS | public DNS lookup | PROVIDER | MX inbound-smtp.sa-east-1.amazonaws.com priority 10; DKIM TXT exists; DMARC p=none | Provider-side match not established |
| Resend account | authenticated browser / arbmsistone team | PROVIDER | No domains yet; only one team visible | Correct existing domain account still required |
| Resend E2E | Gmail subject search, sent tests | PROVIDER | Sent copies found; no destination proof | Does not establish Resend receipt or failure |
| LinkedIn / Nuvemshop | callback GET / production | PRODUCTION | authorization_enabled=false | Callback presence is not completed OAuth |

## Corrections and focal checks

- Email readiness now requires literal EMAIL_INBOUND_ENABLED=true, current authenticated provider domain/capabilities/records and configured receiving webhook, along with public DNS comparison. No fixed region or DKIM prefix. DMARC none/quarantine/reject accepted. Activation is explicitly preflight; delivery_proven=false.
- Diagnostic reads current domain and webhook metadata from Resend, never logs credentials or message content.
- Resend forwarding rejects unrelated recipient domains, logical API errors with HTTP 200, and send responses without IDs. Response carries source/forward IDs for correlation, never claims delivery. Existing stable idempotency key preserved.
- LinkedIn identity uses OIDC openid/profile and /v2/userinfo sub; no unnecessary email scope. Existing member publishing remains distinct from corporate organization publishing; corporate approval is NOT established. Missing expiry is rejected and returned scopes are not fabricated.
- Nuvemshop stores NULL for non-time-expiring tokens. Migration 022 permits NULL only for Nuvemshop; other providers still require expiry. Migration not yet applied.
- Focal tests: email readiness 7/7; commercial OAuth 9/9; Resend before 5/5, after 9/9. Syntax and identity guard passed. These are TEST/CODE evidence, not provider E2E.

## Independent technical references

Evidence gate for corrections: approved with restrictions for technical changes; production/provider/commercial approval withheld.
- Resend domain API and receiving configuration: https://resend.com/docs/api-reference/domains/get-domain and https://resend.com/docs/dashboard/receiving/custom-domains — current records and enabled receiving required.
- AWS SES receiving: https://docs.aws.amazon.com/ses/latest/dg/receiving-email-setting-up.html — regional MX is configuration dependent.
- IETF DMARC: https://www.rfc-editor.org/rfc/rfc9989.html — valid policy values include none, quarantine and reject.
- LinkedIn OIDC: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 — userinfo/sub and OIDC scopes.
- LinkedIn Posts: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-04 — member and organization permissions differ; organization role/URN/version required.
- Nuvemshop authentication: https://dev.tiendanube.com/en/docs/applications/authentication — tokens have no time expiry; replacement/uninstall invalidate; authorization code valid five minutes.
- Vercel sensitive variables: https://vercel.com/docs/environment-variables/sensitive-environment-variables — values not readable after storage; local placeholder is not the production credential.

## Rollback / pending

Rollback branch codex/zevanory-rollback-e9351f9 preserves baseline. Existing Vercel deployment above preserved. No production settings, credentials or sales gates changed.
HUMAN_ACTION_REQUIRED: RESEND_ACCOUNT — authenticate the account administering the existing zevanory.api.br domain.
TikTok, LinkedIn and Nuvemshop external access/consent/review remain unproven. No public posts or payments executed.
INTERNAL_ENGINEERING: FAIL (validation and remaining technical work incomplete).
EXTERNAL_PROVIDER_GATES: PENDING.
COMMERCIAL_EVIDENCE: NOT_YET_OBSERVED.
SALES_RELEASE: BLOCKED.
OVERALL: FAIL-CLOSED.
