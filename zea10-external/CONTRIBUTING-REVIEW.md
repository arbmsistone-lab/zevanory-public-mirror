# External Review Contribution Guide

External reviewers may participate without cloning the full repository workflow.

## Option 1 — GitHub issue comment
Comment on issue #30 with:
- reviewer organization and reviewer identity/ID;
- independence statement;
- pillar IDs covered;
- exact evaluated SHA;
- review date;
- methods;
- evidence checked;
- findings with severity;
- result: pass / pass_with_findings / fail;
- report identifier/hash;
- signature or verification URL.

## Option 2 — Pull request
Create a JSON file under `zea10-external/external-reviews/` conforming to `review.schema.json`.

## Option 3 — Signed/hashed external report
Provide a stable report URL, signature, or verifiable cryptographic hash. ZEVANORY will transcribe the report into the repository only if the external artifact remains independently verifiable.

## Review scope
Partial reviews are encouraged. A reviewer does not need to cover all ten pillars.

## Independence
Self-review by ZEVANORY/ARBM entities is never accepted as external validation.

## Claim boundary
A ZEA-10 framework review does not automatically create ISO, EAL, SIL, TRL, CIS, INCOSE or ISA certification claims.
