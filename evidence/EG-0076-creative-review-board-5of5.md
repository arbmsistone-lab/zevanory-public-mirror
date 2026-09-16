# EG-0076 — Creative Review Board 5/5

Status: APPROVED WITH COMMERCIAL FAIL-CLOSED
Date: 2026-09-12
Scope: Central de Criativos; creation, evaluation and preparation remain active while sales stay blocked.

## Evidence set
1. Google Ads Policy Help — ad review checks headline, description, keywords, destination, images and video; disapproved assets do not serve. Primary policy documentation: https://support.google.com/adspolicy/answer/1722120
2. TikTok for Business — every ad is reviewed before going live; rejected creative can be corrected and resubmitted. Primary platform documentation: https://ads.tiktok.com/business/en/blog/guide-ad-policy-for-tiktok-creative
3. Meta for Business — official training requires choosing appropriate formats/placements and applying mobile creative best practices; Meta policy guidance also requires review of ad quality/compliance. Primary platform documentation: https://www.facebook.com/business/learn/certification/exams/100-101-exam

## Decision
- Introduce a ZEVANORY internal five-lens senior review board for every evaluated creative.
- Technical approval is unanimous only: 5/5. A 4/5 result is `revision_required`, never approved by average compensation.
- Board lenses: strategy/message, visual quality, truth/compliance, channel fit, conversion clarity.
- This board is an internal deterministic/AI quality gate, not a claim of five external human employees.
- A technical 5/5 does not unlock commercial publication, checkout, outbound sales, paid media or revenue claims.
- `salesGate` remains the sole commercial authority and remains fail-closed.
- Creation, research, preparation and evaluation are non-commercial work and remain active.
- The Central must display all currently operational fronts from runtime truth instead of hard-coding two channels.
- Front readiness comes from `/api/config?view=closure_status`; the UI may not fabricate a ready front.
- Existing concrete preview artifacts remain limited to fronts returned by `creative_sample`; other fronts are shown as preparation/evaluation scope, not as fabricated assets.

Result: APPROVED for implementation under existing commercial kill-switches.