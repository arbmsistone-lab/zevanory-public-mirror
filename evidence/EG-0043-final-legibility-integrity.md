# EG-0043 — Final legibility and information integrity

Status: APPROVED FOR FINAL VALIDATION
Scope: ZEVANORY command center visual layer only.

## Acceptance contract
- One desktop page with no global horizontal or vertical scroll.
- No internal overflow in Motor & IA, Infra & release, or Garantias & segurança.
- Minimum visible operational text floor: 8 px in compact and tall desktop validation.
- No ellipsis or clipping of commercial/runtime truth.
- No operational field may be hidden only to make the rail fit.
- Motor and Infra state grids use three compact horizontal columns.
- Secondary runtime details remain visible and retain tooltip truth.
- Commercial kill switches remain runtime-driven and fail-closed.

## Measured compact viewport
1280x720 browser window -> 1262x624 content viewport.
Expected: overflowX=false; overflowY=false; minFont>=8; trunc=[]; hidden=0.
Expected rail invariant: scrollHeight === clientHeight for all three rail cards.

## Safety
No backend, database, payment, sales, WhatsApp, financial, or autonomy gate is enabled by this visual phase.
## Measured tall desktop
1600x900 browser window -> 1582x804 content viewport.
Measured: overflowX=false; overflowY=false; minFont=8; trunc=[]; hidden=0.
Measured rail invariant: scrollHeight === clientHeight for all three rail cards.