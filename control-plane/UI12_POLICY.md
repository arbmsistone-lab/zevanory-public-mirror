# ZEVANORY UI-12 Engineering Assurance

Version: 1.0

UI-12 is the internal visual engineering assurance contract for the ZEVANORY Control Plane. It is evidence-based, fail-closed, and bound to an exact source SHA.

## Decision states
- PASS — reproducible evidence satisfies the pillar contract.
- FAIL — evidence proves a contract violation.
- UNKNOWN — required evidence is missing, stale, or cannot be reproduced.
- N/A-JUSTIFIED — allowed only by an explicit profile rule with technical justification.

Any FAIL or UNKNOWN blocks UI-12 eligibility. No averaging is allowed.

## The 12 pillars

1. Layout & Grid — deterministic regions, alignment, proportions, density, no collisions.
2. Typography Engineering — semantic mathematical type scale, controlled line-height and tracking.
3. Spacing System — semantic 4 px scale for margin, padding and gap.
4. Color Architecture — semantic tokens for surface, text, border, accent and state colors.
5. Lines, Borders & Dividers — tokenized thickness, opacity and radius with minimal visual noise.
6. Visual Hierarchy — critical state and blockers dominate secondary information predictably.
7. Component Geometry — equivalent controls share minimum targets, radius, alignment and proportion.
8. Information Density — executive information remains useful without clipping, overlap or arbitrary scroll.
9. Accessibility & Legibility — WCAG AA representative contrast, keyboard focus, 44 px targets, reduced motion and forced colors.
10. Responsive Spatial Behavior — hierarchy is preserved on desktop, tablet and mobile; no horizontal overflow.
11. Design Tokens & System — color, type, spacing, geometry, elevation and interaction tokens are centralized.
12. Visual Governance & QA — exact-SHA unit/E2E gates, screenshots, collision/overflow checks and fail-closed regression policy.

## Mandatory evidence
- test/ui-12-assurance.test.mjs
- test/control-plane-vnext.test.mjs
- test/e2e/control-plane-vnext.spec.mjs
- .github/workflows/quality-control-plane.yml
- Playwright screenshots for desktop, tablet, mobile and ZEA-10 drilldown.
- Exact source SHA associated with the remote run.

## Release rule
The Control Plane may be labeled UI-12 PROVEN only when every mandatory gate passes on the exact candidate SHA. Missing remote evidence is UNKNOWN, never inferred PASS.

## Scheduler-independent remote quorum
If the primary Quality Control Plane scheduler is unavailable before any test step executes, UI-12 remains fail-closed but may use an equivalent independent remote quorum on the exact candidate SHA:
1. Cloudflare Browser Run remote audit returns PASS for desktop, tablet, mobile, focus, target size, contrast, overflow, clipping, overlap and drilldown geometry.
2. At least one independent remote build provider reports SUCCESS for the exact SHA.
3. Two independent data-plane authorities recompute and validate the UI-12 source/invariant contract on the exact SHA.
4. Provider infrastructure errors that execute zero test steps are degradation telemetry, not functional vetoes. Any executed functional test failure remains a veto.

This fallback does not lower any acceptance criterion and cannot convert missing evidence into PASS.
