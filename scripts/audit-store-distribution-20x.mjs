import { readFileSync } from 'node:fs';
import { ARBM_SIST_OFFER, publicOffer } from '../src/offerCatalog.mjs';
const evidence=readFileSync(new URL('../evidence/EG-0065-microsoft-store-v10-distribution.md',import.meta.url),'utf8');
const expectedStoreHash='AD4B7BB91DA10FDA3233019506AC611F7840DFAD89578C9013A48EEAF5A80BB0';
let pass=0;
for(let i=1;i<=20;i++){
  const blocked=publicOffer({ARBM_SIST_CODE_SIGNING_READY:'false',ARBM_SIST_PUBLIC_RELEASE_APPROVED:'false'});
  const ok=ARBM_SIST_OFFER.version==='10.0.0'&&
    ARBM_SIST_OFFER.public_distribution_channel==='microsoft_store_msix'&&
    ARBM_SIST_OFFER.store_package_sha256===expectedStoreHash&&
    ARBM_SIST_OFFER.store_package_state==='verified_unsigned_pending_partner_center_identity'&&
    ARBM_SIST_OFFER.store_identity_status==='pending_partner_center'&&
    ARBM_SIST_OFFER.store_submission_ready===false&&
    ARBM_SIST_OFFER.microsoft_certification_required===true&&
    ARBM_SIST_OFFER.code_signing_provider==='microsoft_store_re_signing_after_certification'&&
    ARBM_SIST_OFFER.direct_unsigned_distribution_allowed===false&&
    blocked.code_signing_ready===false&&blocked.public_release_approved===false&&blocked.artifact_commercially_releasable===false&&
    evidence.includes('Microsoft Learn')&&evidence.includes('NIST')&&evidence.includes('Sigstore')&&evidence.includes('Microsoft certification has NOT occurred');
  if(!ok){console.error(`STORE_DISTRIBUTION_AUDIT_${i}=FAIL`);process.exit(1);}pass++;console.log(`STORE_DISTRIBUTION_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_STORE_DISTRIBUTION_20X_PASS=${pass}/20`);
