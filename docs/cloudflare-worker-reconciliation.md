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


## Recovered active-bundle contract (2026-09-20)

The active Worker tail recovered from Cloudflare establishes these source-level facts and replaces the earlier dashboard-label inference:

- Node bridge port: `8788`
- server lifecycle: `http.createServer(...)` followed by `server.listen(PORT)`
- API bridge: `handleAsNodeRequest(PORT, request)`
- static assets: `env.ASSETS.fetch(...)`
- Workers AI reference in recovered code: `env.AI`
- private KV reference in recovered code: `env.ZEVANORY_PRIVATE_ARTIFACTS`
- ZEA10 live-report reference in recovered code: `env.ZEA10_ENGINE.report()`
- production rollback version remains `52a989a2`

The recovered text is only the tail of the generated bundle and begins after required handler/helper definitions. It MUST NOT be promoted as a complete production source file. The Git-repro Worker remains intentionally fail-closed for `/api/*` until the complete active bundle or its complete source is recovered and a remote functional-equivalence proof succeeds.

### Cutover invariant

No Git-native production cutover is authorized while `recovered_bundle_completeness != complete`. A successful compile/dry-run of the staging safety Worker proves reproducibility of the safety candidate only; it does not prove API equivalence.
