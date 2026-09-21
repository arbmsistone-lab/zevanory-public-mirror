# ZEA-10 External Review Intake

Place independent review JSON files in this directory.

Every review is validated against `../review.schema.json` and must:
- identify an independent reviewer organization and reviewer;
- describe scope and method;
- bind to an exact 40-character Git SHA;
- identify the ZEA-10 pillar(s) covered;
- list evidence actually checked;
- record findings;
- return `pass`, `pass_with_findings`, or `fail`;
- provide a report identifier/hash;
- include a signature or verification reference when available.

A review does **not** become accepted merely because it is committed. The CI intake gate rejects malformed, self-attested, SHA-mismatched, incomplete, or unverifiable submissions.

The repository remains fail-closed: no pillar is marked `remote_certified=true` until a valid independent artifact exists and passes the intake policy.
