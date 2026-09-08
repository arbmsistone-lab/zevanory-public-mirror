# EG-0071 — UNIVERSAL EXECUTION FABRIC

Status: APPROVED FOR IMPLEMENTATION / NO COMMERCIAL CUTOVER.
Date: 2026-09-08.
Scope: provider-agnostic execution, preservation and evidence quorum.

## Evidence Gate 3X
1. Kubernetes Scheduler (kubernetes.io): filtering + scoring selects feasible execution nodes from requirements rather than a mandatory named node/provider.
2. Terraform Core/Plugins (developer.hashicorp.com): core and provider-specific implementations are separated through a plugin/RPC architecture.
3. SLSA Provenance v1.2 (slsa.dev): build provenance identifies builder and artifact while preserving a standard verifiable evidence model across build platforms.

## Architectural decision
The core MUST request capabilities, not brands. No provider is principal, secondary or mandatory.
Provider-specific details remain at adapters/edges. A provider may disappear without changing the core policy.
A valid operation is preserved when no qualified provider is available; provider dependency alone must not destroy the operation.
Rerouting happens before delayed retry when the prior attempt is known not to have produced an external effect.
If an attempt has ambiguous external effect, automatic rerouting is forbidden until reconciliation to prevent duplicates.
Critical certification requires evidence from independent infrastructure domains and identical operation/artifact hashes.
Zero-cost policy is an execution requirement; paid-only candidates are not feasible providers.
Heavy local execution is forbidden; local machine remains control plane/light validation only.

## Continuity semantics
- provider unavailable -> reroute to another qualified provider;
- all qualified providers unavailable -> preserve operation in durable queue and retry later;
- ambiguous external effect -> preserve evidence and require reconciliation before reroute;
- provider recovers -> circuit closes after health success and provider returns to pool;
- new provider -> adapter can join after capability/health/evidence qualification without core rewrite.

## Commercial boundary
This architecture changes execution resilience only. It does not enable SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, checkout, financial events, outbound commercial activation or production cutover.
