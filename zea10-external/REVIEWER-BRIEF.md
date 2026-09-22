# ZEA-10 External — Independent Reviewer Brief

## Frozen technical target

- Product/repository snapshot to evaluate: `4e16fc48486f8d56f16401adbe34e764528a6a52`
- Audited candidate that produced the latest full engineering gate set: `bd7e587cec1eb35cb8dcbabbb4d548ad4684e3f5`
- Production release reported by the live control-plane: `83620c680958d726fc4b0fd16e2574cdcc362a6d`
- Commercial execution remains fail-closed.
- Current ZEA-10 state remains 0/10 externally validated.

The repository snapshot and production release are intentionally tracked separately. A reviewer must state exactly which one was evaluated.

## Review tracks

A reviewer may cover one or more tracks. No reviewer is required to cover all ten pillars.

### Track A — systems, maturity, performance and software quality
- ZEA10-01 — Maturidade e prontidão operacional
- ZEA10-02 — Arquitetura e engenharia de sistemas
- ZEA10-03 — Performance e eficiência computacional
- ZEA10-04 — Qualidade de software

### Track B — safety, cybersecurity and governance
- ZEA10-05 — Safety e integridade funcional
- ZEA10-06 — Cibersegurança
- ZEA10-09 — Segurança da informação e governança

### Track C — product quality and automation
- ZEA10-07 — Qualidade global do produto
- ZEA10-08 — Automação e integrações

### Track D — resilience and recovery
- ZEA10-10 — Validação, testes extremos, resiliência e recuperação

## Minimum acceptable external artifact

The external artifact must identify:
- reviewer organization;
- reviewer identity or stable reviewer ID;
- independence statement;
- pillar IDs covered;
- exact evaluated SHA;
- date;
- methods used;
- evidence actually checked;
- findings and severities;
- result: `pass`, `pass_with_findings` or `fail`;
- stable report identifier or cryptographic hash.

A review with critical findings can be stored as evidence but cannot promote the covered pillar to external-validated state.

## Important claim boundary

References such as TRL 9, ESEP/INCOSE, SIL 4, EAL7, ISO/IEC 25010, ISO 27001, CIS and ISA are comparison/reference scopes in the internal control-plane. They are **not formal certifications** unless a recognized external process specifically establishes that claim.

## ZERO_SPEND-first route

Preferred first routes:
1. academic laboratory/research group;
2. independent engineer/researcher with identifiable affiliation;
3. pro-bono technical review by an ICT/engineering organization;
4. community review with a stable public identity and reproducible report.

Formal accredited certification, when applicable, is a separate later workstream.
