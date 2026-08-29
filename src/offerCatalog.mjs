export const ARBM_SIST_OFFER = Object.freeze({
  id: 'OFFER-0001',
  experiment_id: 'EXP-0001',
  product: 'ARBM SIST',
  version: '8.1.0',
  offer_type: 'digital_product',
  delivery_mode: 'digital',
  fulfillment_channel: 'secure_download_after_payment',
  artifact_name: 'ARBM-SIST-v8.1.0.zip',
  artifact_sha256: '0124C388CA2ACA68BC555AE2D3BE050919D26302AC1C17238D617F10BFD78EDC',
  price_brl: 497,
  price_status: 'pilot_hypothesis_not_validated',
  license: 'single_customer_offer_terms',
  inventory_required: false,
  signed_executable_included: false,
  positioning: 'Agente de desenvolvimento com IA local-first, worktrees, diff, rollback, testes e cloud opcional.',
  primary_channels: Object.freeze(['youtube','instagram','whatsapp','zevanory']),
  secondary_channels: Object.freeze(['tiktok','facebook','email','google','linkedin']),
});

export function publicOffer() {
  const {artifact_sha256,...safe}=ARBM_SIST_OFFER;
  return Object.freeze({...safe,artifact_sha256});
}
