import { ARBM_COMMERCIAL_MODEL } from './config.mjs';

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
  price_brl: ARBM_COMMERCIAL_MODEL.pro.price_brl,
  price_status: 'commercial_model_defined_release_gated',
  commercial_model: ARBM_COMMERCIAL_MODEL,
  license: 'pro_perpetual_stable_license_with_12_months_continuity',
  inventory_required: false,
  signed_executable_included: false,
  release_state: 'technically_certified_unsigned_not_public',
  public_distribution_channel: 'microsoft_store_msix',
  store_package_name: 'ARBM-SIST-v10.0.0-STORE-UNSIGNED.msix',
  store_package_sha256: 'AD4B7BB91DA10FDA3233019506AC611F7840DFAD89578C9013A48EEAF5A80BB0',
  store_package_state: 'verified_unsigned_pending_partner_center_identity',
  store_identity_status: 'pending_partner_center',
  store_submission_ready: false,
  microsoft_certification_required: true,
  code_signing_provider: 'microsoft_store_re_signing_after_certification',
  direct_unsigned_distribution_allowed: false,
  code_signing_required: true,
  code_signing_gate: 'ARBM_SIST_CODE_SIGNING_READY',
  public_release_gate: 'ARBM_SIST_PUBLIC_RELEASE_APPROVED',
  positioning: 'Agente de desenvolvimento com IA local-first, provider-independent, Zero Cost Firewall, rollback e cloud opcional.',
  primary_channels: Object.freeze(['youtube','instagram','whatsapp','zevanory']),
  secondary_channels: Object.freeze(['tiktok','facebook','email','google','linkedin','nuvemshop','mercado_livre']),
});

export function publicOffer(env=process.env) {
  const {artifact_sha256,...safe}=ARBM_SIST_OFFER;
  const codeSigningReady=String(env.ARBM_SIST_CODE_SIGNING_READY||'').toLowerCase()==='true';
  const publicReleaseApproved=String(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED||'').toLowerCase()==='true';
  return Object.freeze({...safe,artifact_sha256,code_signing_ready:codeSigningReady,public_release_approved:publicReleaseApproved,artifact_commercially_releasable:codeSigningReady&&publicReleaseApproved});
}
