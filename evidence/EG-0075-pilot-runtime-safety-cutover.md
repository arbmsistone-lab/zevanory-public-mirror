# EG-0075 — Pilot Runtime Safety Cutover

Status: APPROVED FOR PILOT-SAFE RUNTIME CONFIGURATION.
Date: 2026-09-09.

## Purpose

Close the Production runtime gap without opening public sales.
The certification pilot remains enabled while the global commercial gates remain fail-closed.

## Production configuration contract

- `CERTIFICATION_PILOT_ENABLED=true`
- `CHECKOUT_ENABLED=true`
- `FINANCIAL_EVENTS_ENABLED=true`
- `SALE_GLOBALLY_ENABLED=false`
- `PRE_SALE_GATES_APPROVED=false`
- `WHATSAPP_SALES_ENABLED=false`

This is the pilot-safe pattern defined by `src/systemHealth.mjs`: checkout and financial infrastructure may be operational while public sales, pre-sale approval, and WhatsApp selling remain locked.

## Safety invariant

No checkout or financial subsystem may bypass `salesGate`.
Provider-neutral checkout must continue to fail closed while the global sales gate is closed.
Rollback disables global sales first and preserves all existing kill switches.

## Acceptance

A new Production deployment must prove `commercial_safety_locked=true`, GitHub/GitLab SHA convergence, and `audit:production:20x` 20/20 before this cutover is considered live.