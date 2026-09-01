# EG-0063 — ARBM SIST V10 Offer Reconciliation

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencia interna auditavel
- Manifest V10: version 10.0.0, releaseState TECHNICALLY_CERTIFIED_UNSIGNED_NOT_PUBLIC, 208 arquivos.
- ZIP real e manifest possuem SHA-256 identico: 70F233FA2AD84B66468CCB4789E3628A171ABA97A6C5C188C01A1EF56659B4E0.
- VERIFY-RELEASE-V10.ps1: VERIFY_RELEASE_V10_PASS.
- Certificacao interna: 25/25 ciclos PASS, HASH_DRIFT=FALSE.
- release-approval.json: technicalCertification.approved=true, codeSigning.status=certificate_required, publicCommercialRelease=false.

## Evidencias externas independentes
1. Microsoft Learn: apps Windows sem assinatura sofrem SmartScreen forte; Store ou certificado valido sao caminhos recomendados.
2. NIST Security Considerations for Code Signing: assinatura digital protege integridade e autentica a origem do software.
3. Sigstore/OpenSSF: assinatura e verificacao criptografica protegem artefatos contra adulteracao e estabelecem proveniencia.

## Decisao
ARBM SIST 10.0.0 substitui 8.1.0 como artefato canonico de pre-lancamento da OFFER-0001.
A ativacao comercial permanece fail-closed ate assinatura publica confiavel e liberacao comercial explicita, alem dos gates de pagamento existentes.
