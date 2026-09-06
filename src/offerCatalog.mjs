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
export const ZEVANORY_PRODUCTS = Object.freeze([
  Object.freeze({sku:'ZEV-IA-011',product:'ZEVANORY IA na Prática',version:'1.1',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_IA_na_Pratica_v1.1.zip',artifact_sha256:'afb6349acb8f6498e422bffb01ef4f400b3879a9d272d21c55cf9d63aa73edae',table_price_brl:197,pilot_price_brl:147,price_status:'pilot_hypothesis_not_validated',primary:false,status:'ready_for_pilot_not_published'}),
  Object.freeze({sku:'ZEV-VEN-011',product:'ZEVANORY Vendas na Prática',version:'1.1',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Vendas_na_Pratica_v1.1.zip',artifact_sha256:'97e5449177666a69a1cfc94f1002109d17f123bc44b2d4023c4d42f731f89070',table_price_brl:197,pilot_price_brl:147,price_status:'pilot_hypothesis_not_validated',primary:false,status:'ready_for_pilot_not_published'}),
  Object.freeze({sku:'ZEV-CMB-011',product:'ZEVANORY Combo IA + Vendas',version:'1.1',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Combo_IA_e_Vendas_v1.1.zip',artifact_sha256:'99644ae9506695956ae515992879998cad9ec5bde1df003097bfad4f14f8b0ea',table_price_brl:297,pilot_price_brl:247,price_status:'pilot_hypothesis_not_validated',primary:true,status:'primary_offer_ready_for_pilot_not_published'}),
]);

export function getZevanoryProduct(sku) {
  return ZEVANORY_PRODUCTS.find(item=>item.sku===String(sku||'').trim().toUpperCase())||null;
}

export function publicProductCatalog() {
  return Object.freeze(ZEVANORY_PRODUCTS.map(({artifact_sha256,...item})=>Object.freeze({...item,artifact_sha256})));
}

export function publicOffer(env=process.env) {
  const {artifact_sha256,...safe}=ARBM_SIST_OFFER;
  const codeSigningReady=String(env.ARBM_SIST_CODE_SIGNING_READY||'').toLowerCase()==='true';
  const publicReleaseApproved=String(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED||'').toLowerCase()==='true';
  return Object.freeze({...safe,artifact_sha256,code_signing_ready:codeSigningReady,public_release_approved:publicReleaseApproved,artifact_commercially_releasable:codeSigningReady&&publicReleaseApproved});
}
export function resolveCheckoutOffer(id) {
  const key=String(id||'').trim().toUpperCase();
  if(!key||key===ARBM_SIST_OFFER.id) return Object.freeze({id:ARBM_SIST_OFFER.id,product:ARBM_SIST_OFFER.product,version:ARBM_SIST_OFFER.version,price_brl:ARBM_SIST_OFFER.price_brl,artifact_name:ARBM_SIST_OFFER.artifact_name,artifact_sha256:ARBM_SIST_OFFER.artifact_sha256});
  const product=getZevanoryProduct(key);
  if(!product) return null;
  return Object.freeze({id:product.sku,product:product.product,version:product.version,price_brl:product.pilot_price_brl,artifact_name:product.artifact_name,artifact_sha256:product.artifact_sha256});
}
