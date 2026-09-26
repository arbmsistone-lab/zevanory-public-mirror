# PED-Versal V1.1 Supreme — ZEVANORY Engineering & Design Standard

Status: CORPORATE_STANDARD
Owner: ZEVANORY
Version: 1.1
Policy: FALSE_GREEN=0 · FAIL_CLOSED=true · REGRESSION_BUDGET=0

## 1. Scope profiles
- UI_ENTERPRISE: web/app/control-center surfaces.
- ENGINEERING_PROOF: CI, verifier, benchmark and infrastructure repositories with no user UI.

## 2. Non-negotiable engineering rules
- No regression may be merged.
- Existing debt is baselined; new debt is forbidden.
- Complexity must be the minimum theoretically necessary; O(n^2)+ requires explicit justification.
- All external mutations are fail-closed, idempotent where applicable, and evidence-bound.
- Loading, empty, success and error states are explicit for user-facing asynchronous surfaces.
- Evidence must be reproducible and tied to exact SHA/release.

## 3. UI_ENTERPRISE design contract
### Semantic tokens
Required in both LIGHT and DARK:
bg-primary, bg-secondary, surface, surface-elevated, text-primary, text-secondary, border,
action-primary, action-primary-text, status-success, status-error, status-warning, status-info, focus-ring.

### Accessibility
- WCAG AAA is the default target for body text.
- WCAG AA is the absolute floor when AAA is technically unjustified, with documented exception.
- Keyboard-only operation, visible :focus-visible, semantic landmarks and ARIA are mandatory.
- prefers-reduced-motion must be respected.

### Geometry
- Macro layout: 8pt grid (8,16,24,32,48,64,96,128...).
- Micro geometry: 4pt grid allowed only for icon/badge/optical alignment (4,12,20,28...) with no arbitrary values.
- No page-level accidental overflow.
- Text must wrap, ellipsize or expand deliberately.

### Typography
Primary Perfect Fourth:
- Body: 16px / 1rem, line-height >= 24px.
- H3: 21px / 1.3125rem.
- H2: 28px / 1.75rem.
- H1: 37px / 2.3125rem.
Functional scale may use 12px and 14px only for labels/meta; never for primary reading content.

### Certified viewports
- 1920px large desktop
- 1440px desktop
- 768px tablet
- 375px mobile
Visual regression evidence is required for promoted UI releases.

### Performance
- Lazy load non-critical modules.
- Avoid unnecessary synchronous work.
- Bundle, LCP, INP and CLS budgets must be monitored on promoted surfaces.

## 4. ENGINEERING_PROOF contract
Visual requirements are N/A unless a UI exists.
Required:
- deterministic commands;
- exact-SHA lineage;
- reproducible evidence;
- no false green;
- bounded retries/timeouts;
- no destructive fallback;
- provider/runtime truth must dominate labels;
- regression and security gates before promotion.

## 5. Enforcement
Phase A — BASELINE: inventory existing debt.
Phase B — NO_NEW_DEBT: CI blocks increases.
Phase C — STRICT: zero violations for touched/new surfaces.
Phase D — CERTIFIED: exact-release visual/accessibility/performance evidence.

All new ZEVANORY surfaces start at Phase C.
