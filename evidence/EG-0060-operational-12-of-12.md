# EG-0060 — ZEVANORY Operational 12/12

Status: APPROVED WITH TRUTH SEPARATION
Date: 2026-09-05

Goal: cover all 12 commercial fronts without falsely claiming provider API approval.

Operational modes:
- provider_api: provider integration configured and verified.
- operator_assisted: verified social profile usable through an explicit operator publication task.
- founder_led_operator_assisted: verified founder LinkedIn profile usable for B2B distribution while corporate API remains pending.
- verified_storefront: owned public storefront usable independently of partner API automation.

The 12 fronts remain: ZEVANORY, WhatsApp, email, Instagram, Facebook, TikTok, YouTube, LinkedIn, Google, affiliate, Nuvemshop and Mercado Livre.

Safety invariants:
- operational fallback never sets provider_api_claimed=true.
- provider API readiness remains a separate metric.
- global sales gates remain fail-closed.
- external provider approval cannot be fabricated by environment flags alone; fallback flags represent verified owned surfaces and operator workflow only.
- payment and revenue truth still require authenticated provider evidence.
