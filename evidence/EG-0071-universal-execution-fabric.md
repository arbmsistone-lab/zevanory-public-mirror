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

## Expansion — payments + AI
- Payment provider selection is capability/readiness based; `PAYMENT_PROVIDER` is optional preference only.
- Checkout resolves a ready provider before any financial side effect; explicit unavailable providers fail closed.
- Agent checkout enqueue records the selected provider and reason, without requiring a named provider globally.
- AI decisions now route through a neutral `ai:decision` provider pool.
- Gemini remains an adapter, not a core dependency; independent adapters can be injected without changing revenue-agent logic.
- If every AI provider fails, deterministic policy remains available and preserves safe operation.
- Financial ambiguity still forbids blind failover after provider side effects.

## 2026-09-08 — Channel fabric expansion
- Every current outbound channel is now exposed as a capability (`channel:<name>`) through the universal fabric.
- Built-in adapters remain compatible, but future independent adapters can be injected without changing core dispatch logic.
- Channel authorization no longer blocks solely because the nominal provider is unconfigured; the outbox preserves the operation for later routing.
- Ambiguous provider effects halt cross-provider rerouting and require reconciliation before another provider may execute.
- Existing Buffer fallback behavior for LinkedIn/TikTok remains compatible while the generic provider registry supports broader alternatives.
- Focused validation: 20/20 PASS + IDENTITY_GUARD_PASS.

## 2026-09-08 — real provider expansion: email
- Resend remains one email execution member; it is not a mandatory core dependency.
- Brevo is added as an independent `channel:email` provider adapter using the official transactional API.
- Brevo Free evidence: 300 transactional emails/day, no time limit and no card required at qualification time.
- Resend Free evidence: 3,000 emails/month and 100/day at qualification time.
- Both providers remain zero-cost eligible only while their free-plan constraints remain satisfied.
- Provider network/5xx ambiguity on mutating delivery blocks blind cross-provider replay and requires reconciliation.

## Correlated-provider rule: WhatsApp
- Multiple WhatsApp BSPs do not automatically satisfy infrastructure-independence quorum when they depend on the same Meta WhatsApp platform.
- WhatsApp continuity may use multiple access paths, but certification independence must account for the shared Meta failure domain.
- True communication continuity therefore also requires independent channels such as email/web rather than pretending two BSPs are two independent platforms.
