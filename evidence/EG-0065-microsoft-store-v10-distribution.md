# EG-0065 â€” ARBM SIST V10 Microsoft Store distribution truth

Date: 2026-09-01
Decision: use Microsoft Store MSIX as the primary public Windows distribution route; do not buy or simulate a certificate solely for Store submission.

## Independent evidence
1. Microsoft Learn â€” MSIX signing guide: Store-distributed MSIX does not need developer signing; Microsoft signs during the submission/publishing process after certification.
   https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide
2. NIST â€” Security Considerations for Code Signing: digital signatures provide integrity and source authentication; distribution architecture must preserve those guarantees.
   https://www.nist.gov/publications/security-considerations-code-signing
3. Sigstore / OpenSSF â€” signing and verification are software supply-chain integrity controls, reinforcing that unsigned artifacts must not be represented as trusted signed releases.
   https://docs.sigstore.dev/about/overview/

## Local V10 evidence
- Certified ZIP SHA-256: `70F233FA2AD84B66468CCB4789E3628A171ABA97A6C5C188C01A1EF56659B4E0`.
- Verified Store MSIX SHA-256: `AD4B7BB91DA10FDA3233019506AC611F7840DFAD89578C9013A48EEAF5A80BB0`.
- `VERIFY-MSIX-V10-STORE.ps1`: PASS with 203 certified core files verified.
- `AUDIT-STORE-V10-20X.ps1`: 20/20 PASS.
- `AUDIT-STORE-V10-GOVERNANCE-20X.ps1`: 20/20 PASS.
- `msstore info`: blocked because `SellerId is not set`.

Truth boundary: Microsoft certification has NOT occurred; Partner Center identity is pending; public release remains blocked.
Verdict: APPROVED for Store-preparation metadata reconciliation only.

2026-09-01 reconciliation: the Store preview package was rebuilt under a frozen-instance policy after proving MakeAppx container hash variability; certified ZIP/core hashes remain unchanged. New canonical preview MSIX SHA-256: `AD4B7BB91DA10FDA3233019506AC611F7840DFAD89578C9013A48EEAF5A80BB0`. Public release remains blocked pending Partner Center identity and Microsoft certification.
