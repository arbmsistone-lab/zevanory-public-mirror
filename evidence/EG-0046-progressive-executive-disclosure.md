# EG-0046 — Progressive Executive Disclosure

Status: APPROVED.
Scope: public command center presentation only; no backend, schema, payment or gate changes.

## Independent evidence
1. AWS Cloudscape — dashboard content should answer key questions at a glance and be ordered hierarchically. https://cloudscape.design/patterns/general/service-dashboard/static-dashboard/
2. Microsoft Fluent — dense experiences should be re-architected with progressive disclosure so primary tasks retain focus. https://fluent2.microsoft.design/
3. Atlassian Design System — typography and density guidance favors readable body sizes and reduced all-caps in dense product surfaces. https://atlassian.design/foundations/typography/

## Decision
- Main surface shows only executive state, pipeline, readiness, risk and the next safe action.
- Full technical evidence remains accessible through an interactive operational-details dialog.
- No operational truth is deleted; it is progressively disclosed.
- No invented forecast, score, payment or sales result.
- Commercial and financial kill-switches remain fail-closed.

## Acceptance
- 1280x720: no document scroll, no internal clipping, visible main text >= 11 px.
- 1600x900: no document scroll, no internal clipping, visible main text >= 12 px.
- Dialog can scroll internally because it is explicitly user-invoked detail, not the primary single-screen surface.
- Main state must be understandable in approximately 2–3 seconds.
