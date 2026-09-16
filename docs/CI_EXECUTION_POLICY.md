# ZEVANORY CI Execution Policy

Status: canonical
Mode: ZERO_SPEND / fail-closed

## Canonical execution plane

CircleCI is the canonical remote execution plane for repository quality, security, recovery, E2E, SBOM, lifecycle and closure gates.

GitHub and GitLab remain authoritative repository mirrors and review surfaces, but their native CI executors are disabled while their account-level runner/quota state cannot execute jobs reliably.

## Required evidence

A candidate is eligible for promotion only when the exact SHA has all canonical CircleCI jobs green, exact-SHA preview deployment evidence, and independent runtime/certifier evidence required by the release policy.

Disabling a duplicate executor never waives, skips or downgrades a test. The equivalent canonical CircleCI jobs must execute and pass.

Commercial gates are independent. CI success must never enable sales, checkout, payment movement or commercial autonomy.
