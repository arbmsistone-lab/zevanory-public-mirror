import { ARBM_COMMERCIAL_MODEL, PROJECT } from './config.mjs';
import { ARBM_ONE_OFFER } from './arbmOneOffer.mjs';

export const ARBM_SIST_OFFER = Object.freeze({
  id: 'OFFER-0001',
  experiment_id: 'EXP-0001',
  product: 'ARBM SIST',
  commercial_name: 'ARBM SIST - by ZEVANORY',
  brand: 'ZEVANORY',
  portfolio_role: 'primary_product',
  primary: true,
  sellable: true,
  artifact_materialized: true,
  status: 'ready_secure_delivery_release_gated_not_published',
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
  Object.freeze({sku:'ZEV-IA-011',product:'ZEVANORY IA na Prática',commercial_name:'ZEVANORY IA na Prática - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.0',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_IA_na_Pratica_v2.0.zip',artifact_sha256:'67293badc24f0ebbbabfa8912e2149873ee3a22dc1c60ea90cade381a5f4dd19',table_price_brl:197,pilot_price_brl:147,price_status:'pilot_hypothesis_not_validated',primary:false,sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',status:'content_quality_certified_global_sales_gate_blocked_not_published'}),
  Object.freeze({sku:'ZEV-VEN-011',product:'ZEVANORY Vendas na Prática',commercial_name:'ZEVANORY Vendas na Prática - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.0',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Vendas_na_Pratica_v2.0.zip',artifact_sha256:'640740406382ec4fd92ff14039707eac830d2b685ffc45b98b8af606b9467a31',table_price_brl:197,pilot_price_brl:147,price_status:'pilot_hypothesis_not_validated',primary:false,sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',status:'content_quality_certified_global_sales_gate_blocked_not_published'}),
  Object.freeze({sku:'ZEV-LCX-011',product:'ZEVANORY Lucro & Caixa',commercial_name:'ZEVANORY Lucro & Caixa - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.0',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Lucro_e_Caixa_v2.0.zip',artifact_sha256:'46cdbbdc201050c895c79e542dedb95d5e934171132136cbf177556c6daaefa5',table_price_brl:247,pilot_price_brl:197,price_status:'pilot_hypothesis_not_validated',primary:false,sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',status:'content_quality_certified_global_sales_gate_blocked_not_published'}),
  Object.freeze({sku:'ZEV-CMB-011',product:'ZEVANORY Combo IA + Vendas',commercial_name:'ZEVANORY Combo IA + Vendas - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.0',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Combo_IA_e_Vendas_v2.0.zip',artifact_sha256:'3e1ebf1f615e6876e20d1b3b42d89c20aeb0357d3546bce1af395b31211a8d35',table_price_brl:297,pilot_price_brl:247,price_status:'pilot_hypothesis_not_validated',primary:false,sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',status:'content_quality_certified_global_sales_gate_blocked_not_published'}),
  Object.freeze({sku:'ZEV-NGC-011',product:'ZEVANORY Negócio Completo',commercial_name:'ZEVANORY Negócio Completo - by ARBM',brand:'ZEVANORY',endorsed_by:'ARBM',brand_signature:'by ARBM',version:'2.0',offer_type:'digital_product',delivery_mode:'digital',fulfillment_channel:'secure_download_after_payment',artifact_name:'ZEVANORY_Negocio_Completo_v2.0.zip',artifact_sha256:'484c4ed7848f8f3d57b739a4c5dab8fce77901d0fbc638c87d1c76e233fa342a',table_price_brl:397,pilot_price_brl:347,price_status:'pilot_hypothesis_not_validated',primary:false,portfolio_role:'content_bundle',sellable:false,artifact_materialized:true,content_quality_certified:true,quality_certified:false,quality_standard:'excellence_100_confidence_99_evidence_required',status:'content_quality_certified_global_sales_gate_blocked_not_published'}),
]);

export const ZEVANORY_PORTFOLIO = Object.freeze([ARBM_SIST_OFFER, ARBM_ONE_OFFER, ...ZEVANORY_PRODUCTS]);

export function getZevanoryProduct(sku) {
  return ZEVANORY_PRODUCTS.find(item=>item.sku===String(sku||'').trim().toUpperCase())||null;
}

export function publicProductCatalog() {
  return Object.freeze(ZEVANORY_PORTFOLIO.map(({artifact_sha256,founder_program,...item})=>Object.freeze({...item,artifact_sha256})));
}

export function publicOffer(env=process.env) {
  const product=getZevanoryProduct(PROJECT.offerId);
  if(product){
    const {artifact_sha256,...safe}=product;
    const integrityVerified=String(env.ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED||'').toLowerCase()==='true';
    const deliveryReady=String(env.ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY||'').toLowerCase()==='true';
    return Object.freeze({...safe,id:product.sku,price_brl:product.pilot_price_brl,artifact_sha256,integrity_verified:integrityVerified,secure_delivery_ready:deliveryReady,artifact_commercially_releasable:integrityVerified&&deliveryReady});
  }
  const {artifact_sha256,...safe}=ARBM_SIST_OFFER;
  const codeSigningReady=String(env.ARBM_SIST_CODE_SIGNING_READY||'').toLowerCase()==='true';
  const publicReleaseApproved=String(env.ARBM_SIST_PUBLIC_RELEASE_APPROVED||'').toLowerCase()==='true';
  return Object.freeze({...safe,artifact_sha256,code_signing_ready:codeSigningReady,public_release_approved:publicReleaseApproved,artifact_commercially_releasable:codeSigningReady&&publicReleaseApproved});
}
export function resolveCheckoutOffer(id) {
  const key=String(id||PROJECT.offerId).trim().toUpperCase();
  if(key===ARBM_SIST_OFFER.id) return Object.freeze({id:ARBM_SIST_OFFER.id,product:ARBM_SIST_OFFER.product,version:ARBM_SIST_OFFER.version,price_brl:ARBM_SIST_OFFER.price_brl,artifact_name:ARBM_SIST_OFFER.artifact_name,artifact_sha256:ARBM_SIST_OFFER.artifact_sha256});
  const product=getZevanoryProduct(key);
  if(!product||product.sellable!==true||product.artifact_materialized!==true) return null;
  return Object.freeze({id:product.sku,product:product.product,commercial_name:product.commercial_name,brand:product.brand,endorsed_by:product.endorsed_by,brand_signature:product.brand_signature,version:product.version,price_brl:product.pilot_price_brl,artifact_name:product.artifact_name,artifact_sha256:product.artifact_sha256});
}
