# EG-0064 - Meta Graph API v26.0 reconciliation

Date: 2026-09-01
Decision: pin new Meta channel integrations to `v26.0`.

## Independent evidence
1. Meta for Developers, Developer News: "Introducing Graph API v26.0 and Marketing API v26.0", released 2026-07-29. The official developer index states v26.0 is available and links to the v26 changelog.
   Source: https://developers.meta.com/resources/blog/
2. PostGate, "Social media API changes in 2026: a living reference", checked 2026-08-26. It records Graph API v26.0 released 2026-07-29 and points back to the official Meta changelog.
   Source: https://postgate.studio/blog/social-media-api-changes-2026
3. Bundle Social, "Facebook Graph API: A Developer's Guide (2026)", published 2026-08-04. It identifies v26.0 as the current Graph API version and recommends explicit version pinning.
   Source: https://bundle.social/blog/facebook-graph-api

## Reconciliation
- Previous `.env.example`: `META_GRAPH_VERSION=v23.0`.
- Required current default: `META_GRAPH_VERSION=v26.0`.
- Runtime still requires an explicit environment value and remains fail-closed when missing.
- No access token, App Secret, Page ID, Instagram ID or WhatsApp Phone Number ID is invented or embedded.
- Commercial gates remain OFF; version reconciliation does not authorize posting, messaging or sales.

Verdict: APPROVED for configuration reconciliation only.
