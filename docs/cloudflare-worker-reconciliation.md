# Cloudflare Worker Git reconciliation

This branch is a non-production reconciliation target for the existing `zevanory` Worker.

## Observed production contract (2026-09-20)

- compatibility date: `2026-09-04`
- static asset binding: `ASSETS`
- Workers AI binding: `IA`
- service binding: `ZEA10_MOTOR` -> existing ZEA10 control-plane service
- KV binding: `ZEVANORY_ARTEFATOS_PRIVADOS`
- hourly scheduled trigger
- `/api/*` is Worker-first and must preserve the current API implementation
- production rollback version: Cloudflare version `52a989a2`
- observed production release marker: `83620c680958d726fc4b0fd16e2574cdcc362a6d`

## Safety

This configuration MUST NOT be connected to the production Worker yet. It deliberately deploys under a separate staging name and keeps all commercial gates false. Secrets are never committed.

The current production bindings cannot be safely invented from screenshots. Before cutover, the service binding target and KV namespace identifier must be obtained from Cloudflare metadata/API and inserted as deployment configuration or CI secrets. The existing production API source must also be reconciled; until then `/api/*` fails closed in this staging Worker rather than silently becoming static.

Cutover is allowed only after remote validation of assets, API contract, bindings, exact source SHA, commercial lock, and a tested rollback to version `52a989a2`.
