# ZEA-10 External Evidence Pack

This directory prepares ZEVANORY for independent review of the ten ZEA-10 engineering pillars. It is an **evidence package, not an external certificate**.

## Frozen review target

- Canonical repository SHA: `c7d660a99710ef0a06d2150be55304b189366078`
- Production release SHA reported by control-plane: `83620c680958d726fc4b0fd16e2574cdcc362a6d`
- Commercial state: fail-closed
- External certification claimed: **no**
- Rollback reference: `52a989a2`

## Evidence model

Each pillar is evaluated in three layers:

1. **Internal reproducible proof** — source, CI run, runtime probe, artifact, or contract that another reviewer can reproduce.
2. **Independent review** — a third party validates the evidence and records scope, method, findings, evaluated SHA, date, and report identity.
3. **External attestation/certification where applicable** — only when a recognized certification scheme actually exists for that scope.

The pack intentionally does not convert references such as TRL, SIL, EAL, ISO/IEC 25010, ISO 27001, CIS or INCOSE into certification claims by wording alone.

## Pillar evidence index

| Pillar | Scope | Primary evidence |
|---|---|---|
| ZEA10-01 | Operational maturity/readiness | consolidated closure + APEX |
| ZEA10-02 | Architecture/systems engineering | Worker compatibility + continuity router |
| ZEA10-03 | Performance/efficiency | APEX Lighthouse/SLO evidence |
| ZEA10-04 | Software quality | APEX + remote quality |
| ZEA10-05 | Safety/functional integrity | DR + fail-closed closure |
| ZEA10-06 | Cybersecurity | APEX security assertions + binding contract |
| ZEA10-07 | Product quality | APEX UX/WCAG/performance |
| ZEA10-08 | Automation/integrations | provider independence + quorum |
| ZEA10-09 | Information security/governance | APEX + consolidated closure |
| ZEA10-10 | Resilience/recovery | portable DR + parity + provider quorum |

## Independent reviewer handoff

An external reviewer should start from `manifest.json`, verify every referenced file exists at the frozen SHA, reproduce the listed GitHub Actions, probe the production surfaces, then place signed or hashed review records in `external-reviews/` using `review-template.json`.

No ZEA-10 pillar should be marked `remote_certified=true` until that independent artifact exists and is bound to the exact evaluated SHA.
