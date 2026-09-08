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

## Expansao 2026-09-08 — Durable Operation Journal
- Criado journal provider-neutral para preservar operacoes quando storage transacional estiver indisponivel.
- Payload selado com AES-256-GCM; integridade SHA-256; operation_id idempotente.
- Quorum de journal conta apenas dominios de falha independentes e exclui providers pagos sob politica zero-cost.
- Cloudflare KV privado existente foi integrado como um adapter de journal, nunca como dependencia principal.
- Rota `/private/journal/append` exige bearer forte e grava somente envelope criptografado.
- Regra: journal preserva intencao; reconciliacao decide aplicacao posterior. Nunca replica cegamente efeitos financeiros ou publicacoes ambiguas.
- Validacao focada: 4/4 PASS + IDENTITY_GUARD_PASS.

## Expansao 2026-09-08 — Observabilidade e Deploy/Certificacao
- Observabilidade deixou de depender somente do console do runtime: sinks HTTP provider-neutral podem operar em paralelo.
- Falha de sink de telemetria nunca derruba a operacao de negocio; copias minimas podem exigir dominios independentes.
- Deploy/certificacao ganhou capability `deploy:preview` + `deploy:verify`, sem fornecedor nominal no contrato.
- Prova de deploy com SHA divergente e rejeitada.
- Release critica exige quorum configuravel de provas PASS com mesmo artifact/operation SHA e dominios de falha independentes.
- O script Vercel legado permanece como mecanismo especifico existente, mas nao e mais o modelo arquitetural obrigatorio do core.
- Auditoria `audit:universal-fabric:3x`: 9/9 invariantes PASS.
- Validacao focada journal + observabilidade + deploy: 10/10 PASS + IDENTITY_GUARD_PASS.

## Storage Fabric evidence extension — 2026-09-08
- AWS Prescriptive Guidance, Transactional Outbox: dual writes can produce inconsistent state; persist state/event atomically and make downstream consumers idempotent.
- Microsoft Azure Architecture Center, Compensating Transaction: eventual-consistency workflows must durably record progress and use idempotent commands; manual reconciliation can be required.
- PostgreSQL documentation, Transactions: grouped writes are all-or-nothing; COMMIT makes the transaction durable and ROLLBACK discards the updates.
- Cloudflare Queues delivery guarantees: at-least-once delivery may duplicate messages; unique IDs/idempotency keys are required for safe deduplication.
- Decision: database failover cannot be implemented as blind multi-master replay. Pre-write unavailability may be journaled as replayable; any failure after a write attempt is treated as ambiguous until reconciled.
- Gate: APPROVED FOR IMPLEMENTATION / production cutover remains blocked pending remote proof.

## Verified Read Fabric evidence extension — 2026-09-08
- PostgreSQL Hot Standby: standby connections are read-only and can be eventually consistent with measurable replication delay.
- Neon Read Replicas: a branch may expose multiple read-only compute endpoints for the same data source.
- Supabase Read Replicas: dedicated read endpoints are asynchronously synchronized and may have replication lag.
- Decision: operational/reporting reads may reroute only to explicitly verified read-only routes for the same canonical dataset. Strong-current-state decisions such as payment confirmation remain on canonical transactional truth.
- Alternate read route requires explicit verification metadata; absence of verification excludes it from the pool.
- Gate: APPROVED FOR IMPLEMENTATION / no production cutover implied.
