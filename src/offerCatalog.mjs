export const ARBM_SIST_OFFER = Object.freeze({
  id: 'OFFER-0001',
  experiment_id: 'EXP-0001',
  product: 'ARBM SIST',
  version: '10.0.0',
  offer_type: 'digital_product',
  delivery_mode: 'digital',
  fulfillment_channel: 'secure_download_after_payment',
  artifact_name: 'ARBM-SIST-v10.0.0.zip',
  artifact_sha256: '70F233FA2AD84B66468CCB4789E3628A171ABA97A6C5C188C01A1EF56659B4E0',
  price_brl: 497,
  price_status: 'pilot_hypothesis_not_validated',
  license: 'single_customer_offer_terms',
  inventory_required: false,
  signed_executable_included: false,
  release_state: 'technically_certified_unsigned_not_public',
  code_signing_required: true,
  code_signing_gate: 'ARBM_SIST_CODE_SIGNING_READY',
  public_release_gate: 'ARBM_SIST_PUBLIC_RELEASE_APPROVED',
  positioning: 'Agente de desenvolvimento com IA local-first, worktrees, diff, rollback, testes e cloud opcional.',
  primary_channels: Object.freeze(['youtube','instagram','whatsapp','zevanory']),
  secondary_channels: Object.freeze(['tiktok','facebook','email','google','linkedin']),
});

export function publicOffer(env=process.env) {
  const {artifact_sha256,...safe}=ARBM_SIST_OFFER;
  const codeSigningReady=String(env.ARBM_SIST_CODE_SIGNING_READY||'').toLowerCase()==='true';
  const publicReleaseApproved=String(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED||'').toLowerCase()==='true';
  return Object.freeze({...safe,artifact_sha256,code_signing_ready:codeSigningReady,public_release_approved:publicReleaseApproved,artifact_commercially_releasable:codeSigningReady&&publicReleaseApproved});
}
