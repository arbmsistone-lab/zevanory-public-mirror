# ZEVANORY International Security Baseline

This baseline is aligned to OWASP ASVS 5.0, NIST SSDF, and software supply-chain hardening practices.

## Mandatory controls

- Fail closed on HIGH/CRITICAL dependency, secret, or misconfiguration findings.
- Pin every external GitHub Action to a full immutable commit SHA.
- Keep `GITHUB_TOKEN` at read-only by default and grant writes only per job when required.
- Generate a CycloneDX SBOM for every protected change.
- Reject committed credentials and private keys.
- Verify production TLS/security headers continuously.
- Require authenticated, signed, replay-resistant webhook processing for external channels.
- Keep payment, Meta, WhatsApp, Google, and deployment credentials separate by purpose and least privilege.
- Record a permanent regression test for every security defect discovered.
- Maintain recoverability evidence and never trade rollback/recovery for release speed.

## ZEVANORY-specific threat priorities

1. Social-channel token theft or scope abuse.
2. Forged or replayed webhooks from Meta/payment integrations.
3. Unauthorized autonomous publishing or checkout actions.
4. Prompt/content injection crossing into privileged tools.
5. Supply-chain compromise through dependencies or CI actions.
6. Secret leakage through logs, generated content, artifacts, or source control.
7. Production drift between approved source and deployed runtime.

## Release rule

A security gate failure is a NO-GO. Exceptions must be explicit, time-bounded, documented, and independently reviewed before release.