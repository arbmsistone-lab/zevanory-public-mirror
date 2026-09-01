# EG-0066 — Channel identity preflight

Date: 2026-09-01
Decision: credentials alone must never mark an external commercial channel ready. Provider identity must be read back and reconciled to the canonical ZEVANORY asset first.

## Independent evidence
1. Meta official WhatsApp Business Platform collection: the phone-number endpoint returns `id`, `display_phone_number`, `verified_name` and `quality_rating`, allowing deterministic reconciliation of a Cloud API token/phone ID to the intended business number.
   https://www.postman.com/meta/whatsapp-business-platform/request/xrj32er/get-business-phone-number
2. Google YouTube Data API `channels.list`: an OAuth-authorized request with `mine=true` returns channels owned by the authenticated user, including the canonical channel ID.
   https://developers.google.com/youtube/v3/docs/channels/list
3. TikTok Content Posting API `creator_info/query`: the authorized user token returns `creator_username`, nickname and current privacy options and must be queried before posting.
   https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info

## Local truth boundary
- Canonical WhatsApp: `558892340423`.
- Canonical Instagram handle: `zevanory`.
- Canonical YouTube channel ID already evidenced through Metricool: `UCMl8-SxMVv77S2tz2H63P3A`.
- Facebook must resolve to a Page whose name normalizes to `ZEVANORY`; the old Central Giro page must never qualify.
- TikTok has no confirmed ZEVANORY account yet, so an expected username remains mandatory before identity verification can pass.

## Webhook token reconciliation
Production was populated earlier with `META_VERIFY_TOKEN`, while the handler and `.env.example` expected `META_WEBHOOK_VERIFY_TOKEN`. Invalid-token 403 behavior proved fail-closed operation but did not prove a successful provider challenge. V1 therefore makes `META_VERIFY_TOKEN` canonical and retains `META_WEBHOOK_VERIFY_TOKEN` only as a backward-compatible fallback.

## Safety rule
- Preflight calls are identity/read-only calls; they do not publish content, send messages, create checkout sessions or open gates.
- Tokens and secrets are never returned in preflight results.
- Identity verification flags default to false and must be set only after provider evidence passes.
- Global commercial gates remain independent and closed.

Verdict: APPROVED for fail-closed provider-identity reconciliation.
