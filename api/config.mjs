import { PROJECT, ARBM_COMMERCIAL_MODEL } from '../src/config.mjs';
import { salesGate, channelEnabled } from '../src/salesGate.mjs';
import { buildActivationPlan } from '../src/activationPlan.mjs';
import { RELEASE } from '../src/release.mjs';
import { publicOffer, publicProductCatalog } from '../src/offerCatalog.mjs';
import { publicChannelStatus } from '../src/publicChannelStatus.mjs';
import { neon } from '@neondatabase/serverless';
import { buildLifecycleEvidenceSnapshot } from '../src/lifecycleEvidenceSnapshot.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { certificationPilotStatus } from '../src/certificationPilot.mjs';
import { verifyMercadoLivreLive } from '../src/mercadoLivreVerification.mjs';
import { brandIdentityReadiness } from '../src/brandIdentityReadiness.mjs';
import { isPublicDeploymentRequest, safeBearerEqual } from '../src/security.mjs';
import { verifyCreativeToken, createCreativeSpec, creativeAssetUrl } from '../src/creativeEngine.mjs';
import { renderCreativePng, renderCreativeWebm } from '../src/creativeRenderer.mjs';

export const config={maxDuration:30};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  const url=new URL(req.url||'/api/config','https://zevanory.api.br');
  const view=String(url.searchParams.get('view')||'');
  if(view==='creative_asset'){
    const token=verifyCreativeToken(url.searchParams.get('p'),url.searchParams.get('s'),process.env);
    if(!token){res.statusCode=403;res.setHeader('cache-control','no-store');return res.end('invalid_creative_token');}
    try{const body=token.format==='webm'?await renderCreativeWebm(token.spec):await renderCreativePng(token.spec);res.statusCode=200;res.setHeader('content-type',token.format==='webm'?'video/webm':'image/png');res.setHeader('content-length',String(body.length));res.setHeader('cache-control','public, max-age=31536000, immutable');res.setHeader('x-content-type-options','nosniff');res.setHeader('x-creative-id',token.spec.creative_id);return res.end(body);}catch(error){console.error('creative_render_failed',{creative_id:token.spec.creative_id,message:String(error?.message||'render_failed')});res.statusCode=503;res.setHeader('cache-control','no-store');return res.end('creative_render_unavailable');}
  }
  if(view==='creative_sample'){const origin=`${String(req.headers?.['x-forwarded-proto']||'https').split(',')[0]}://${String(req.headers?.['x-forwarded-host']||req.headers?.host||'zevanory.api.br').split(',')[0]}`;const sampleEnv={...process.env,PUBLIC_BASE_URL:origin};const imageSpec=createCreativeSpec({offerId:'OFFER-0001',channel:'instagram',hook:'Automacao com controle',body:'IA, execucao segura e evidencia real.',cta:'Conheca a ZEVANORY'});const videoSpec=createCreativeSpec({offerId:'OFFER-0001',channel:'youtube',hook:'Automacao com controle',body:'IA, execucao segura e evidencia real.',cta:'Conheca a ZEVANORY'});res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;return res.end(JSON.stringify({service:'ZEVANORY',image_creative_id:imageSpec.creative_id,video_creative_id:videoSpec.creative_id,png_url:creativeAssetUrl(imageSpec,'png',sampleEnv),webm_url:creativeAssetUrl(videoSpec,'webm',sampleEnv)}));}
  if(isPublicDeploymentRequest(req)&&['mercadolivre-audit','lifecycle','activation'].includes(view)){const expected=String(process.env.OPERATOR_TOKEN||process.env.FULFILLMENT_OPERATOR_TOKEN||'');const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');if(!safeBearerEqual(expected,provided)){res.statusCode=401;return res.end(JSON.stringify({error:'operator_auth_required'}));}}
  if(url.searchParams.get('view')==='mercadolivre-audit'){
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'database_required'}));}
    try{const result=await verifyMercadoLivreLive(neon(process.env.DATABASE_URL));res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=result.all_verified?200:503;return res.end(JSON.stringify(result));}catch(error){res.statusCode=503;return res.end(JSON.stringify({provider:'mercado_livre',all_verified:false,error:String(error?.message||'verification_failed').slice(0,120)}));}
  }
  if(url.searchParams.get('view')==='lifecycle'){
    if(!process.env.DATABASE_URL){res.statusCode=503;return res.end(JSON.stringify({error:'database_required'}));}
    try{const snapshot=await buildLifecycleEvidenceSnapshot(neon(process.env.DATABASE_URL),{deployedCommitSha:String(process.env.VERCEL_GIT_COMMIT_SHA||process.env.ZEVANORY_RELEASE_SHA||""),releaseId:RELEASE.id});res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;return res.end(JSON.stringify(snapshot));}catch{res.statusCode=503;return res.end(JSON.stringify({error:'lifecycle_certification_unavailable'}));}
  }
  if(url.searchParams.get('view')==='activation'){
    const plan=buildActivationPlan(process.env);
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',release_id:RELEASE.id,activation_phase:plan.phase,inputs_ready:plan.inputs_ready,commercial_enabled:plan.commercial_enabled,offer_type:plan.offer_type,external_inputs_remaining:plan.external_inputs_remaining,missing:plan.missing,lifecycle:plan.lifecycle,gates:plan.gates,cutover_order:plan.cutover_order,rollback_order:plan.rollback_order}));
  }
  const gate=salesGate();
  const whatsappEnabled=channelEnabled('WHATSAPP_SALES_ENABLED');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.statusCode = 200;
  const payload={
    commercial_enabled: gate.enabled,
    commercial_blockers: gate.blockers,
    sales_lifecycle: { version:gate.lifecycle.version, approved:gate.lifecycle.approved, required_score:gate.lifecycle.required_score, passed_dimensions:gate.lifecycle.passed_dimensions, total_dimensions:gate.lifecycle.total_dimensions, blockers:gate.lifecycle.blockers },
    whatsapp_enabled: whatsappEnabled,
    whatsapp_number: whatsappEnabled ? PROJECT.officialWhatsappE164 : null,
    offer_id: PROJECT.offerId,
    experiment_id: PROJECT.experimentId,
    experimental_price_brl: PROJECT.experimentalPriceBrl,
    commercial_model: {brand:'ZEVANORY',model:'digital_products',primary_offer:PROJECT.offerId,pilot_pricing:true},
    offer: publicOffer(),
    products: publicProductCatalog(),
    channels: publicChannelStatus(),
    distribution: commercialDistributionReadiness(),
    brand_identity: brandIdentityReadiness(),
    certification_pilot: certificationPilotStatus(),
    support_whatsapp_number: PROJECT.officialWhatsappE164,
    production_mode: gate.enabled ? 'commercial-gated' : 'pre-sale-blocked'
  };
  const o=payload.offer||{}; const safeOffer={sku:o.sku,product:o.product,commercial_name:o.commercial_name,brand:o.brand,endorsed_by:o.endorsed_by,brand_signature:o.brand_signature,version:o.version,offer_type:o.offer_type,delivery_mode:o.delivery_mode,table_price_brl:o.table_price_brl,pilot_price_brl:o.pilot_price_brl,price_brl:o.price_brl,price_status:o.price_status,primary:o.primary};
  const body=isPublicDeploymentRequest(req)?{commercial_enabled:payload.commercial_enabled,commercial_blockers:payload.commercial_blockers,whatsapp_enabled:payload.whatsapp_enabled,whatsapp_number:payload.whatsapp_number,offer_id:payload.offer_id,experiment_id:payload.experiment_id,experimental_price_brl:payload.experimental_price_brl,offer:safeOffer,support_whatsapp_number:payload.support_whatsapp_number,production_mode:payload.production_mode}:payload;
  return res.end(JSON.stringify(body));
}

