import { PROJECT, ARBM_COMMERCIAL_MODEL } from '../src/config.mjs';
import { salesGate, channelEnabled } from '../src/salesGate.mjs';
import { buildActivationPlan } from '../src/activationPlan.mjs';
import { RELEASE } from '../src/release.mjs';
import { publicOffer, publicProductCatalog } from '../src/offerCatalog.mjs';
import { publicChannelStatus, publicChannelReadinessSummary } from '../src/publicChannelStatus.mjs';
import { persistedOAuthReadiness, overlayPersistedOAuth } from '../src/runtimeOAuthChannelReadiness.mjs';
import { neon } from '@neondatabase/serverless';
import { buildLifecycleEvidenceSnapshot } from '../src/lifecycleEvidenceSnapshot.mjs';
import { commercialDistributionReadiness } from '../src/commercialDistribution.mjs';
import { EXCLUDED_COMMERCIAL_FRONTS } from '../src/activeCommercialScope.mjs';
import { remoteRuntimeChannelTruth, overlayRemoteChannelTruth } from '../src/remoteRuntimeTelemetry.mjs';
import { certificationPilotStatus } from '../src/certificationPilot.mjs';
import { verifyMercadoLivreLive } from '../src/mercadoLivreVerification.mjs';
import { brandIdentityReadiness } from '../src/brandIdentityReadiness.mjs';
import { isPublicDeploymentRequest, safeBearerEqual } from '../src/security.mjs';
import { verifyCreativeToken, creativeAssetEtag } from '../src/creativeEngine.mjs';
import { selectCreativeVariantWithVisualEvidence } from '../src/creativeIntelligence.mjs';

export const config={maxDuration:30};
async function channelStatusWithOAuth(summary=false){
  const base=summary?publicChannelReadinessSummary():publicChannelStatus();
  if(!process.env.DATABASE_URL)return base;
  try{return overlayPersistedOAuth(base,await persistedOAuthReadiness(neon(process.env.DATABASE_URL)));}catch{return base;}
}

export default async function handler(req, res) {
  const url=new URL(req.url||'/api/config','https://zevanory.api.br');
  const view=String(url.searchParams.get('view')||'');
  const creativeAssetRequest=view==='creative_asset'&&(req.method==='GET'||req.method==='HEAD');
  if (req.method !== 'GET' && !creativeAssetRequest) {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  if(view==='creative_asset'){
    const token=verifyCreativeToken(url.searchParams.get('p'),url.searchParams.get('s'),process.env);
    if(!token){res.statusCode=403;res.setHeader('cache-control','no-store');return res.end('invalid_creative_token');}
    const etag=creativeAssetEtag(token.spec,token.format);if(String(req.headers?.['if-none-match']||'')===etag){res.statusCode=304;res.setHeader('etag',etag);res.setHeader('cache-control','public, max-age=31536000, s-maxage=31536000, immutable');return res.end();}
    try{const { renderCreativeAsset }=await import('../src/creativeRenderer.mjs');const body=await renderCreativeAsset(token.spec,token.format);const mime=token.format==='webm'?'video/webm':'image/png';const range=String(req.headers?.range||'');let status=200,payload=body;res.setHeader('accept-ranges','bytes');if(req.method==='GET'&&range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.statusCode=416;res.setHeader('content-range',`bytes */${body.length}`);return res.end();}const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),body.length-1):body.length-1;if(start>=body.length||end<start){res.statusCode=416;res.setHeader('content-range',`bytes */${body.length}`);return res.end();}status=206;payload=body.subarray(start,end+1);res.setHeader('content-range',`bytes ${start}-${end}/${body.length}`);}res.statusCode=status;res.setHeader('content-type',mime);res.setHeader('content-length',String(req.method==='HEAD'?body.length:payload.length));res.setHeader('cache-control','public, max-age=31536000, s-maxage=31536000, immutable');res.setHeader('etag',etag);res.setHeader('x-content-type-options','nosniff');res.setHeader('x-creative-id',token.spec.creative_id);return req.method==='HEAD'?res.end():res.end(payload);}catch(error){console.error('creative_render_failed',{creative_id:token.spec.creative_id,message:String(error?.message||'render_failed')});res.statusCode=503;res.setHeader('cache-control','no-store');return res.end('creative_render_unavailable');}
  }
  if(view==='closure_status'){
    let runtimeOAuth={}; if(process.env.DATABASE_URL){try{runtimeOAuth=await persistedOAuthReadiness(neon(process.env.DATABASE_URL));}catch{runtimeOAuth={};}}
    const gate=salesGate(),localChannels=overlayPersistedOAuth(publicChannelReadinessSummary(),runtimeOAuth),distribution=commercialDistributionReadiness(process.env,runtimeOAuth),brand=brandIdentityReadiness(),pilot=certificationPilotStatus();
    const remoteTruth=await remoteRuntimeChannelTruth(process.env);
    const channels=overlayRemoteChannelTruth(localChannels,remoteTruth);
    const channelSummary=Object.fromEntries(Object.entries(channels).map(([name,state])=>[name,{operational_ready:state.operational_ready,operational_mode:state.operational_mode,api_configured:state.api_configured,alternate_api_configured:state.alternate_api_configured,contingency_ready:state.contingency_ready}]));
    const rawFrontSummary=Object.fromEntries(Object.entries(distribution.fronts).map(([name,state])=>[name,{operational_ready:state.operational_ready,operational_mode:state.operational_mode,automation_ready:state.automation_ready,contingency_ready:state.contingency_ready}]));
    const frontSummary=overlayRemoteChannelTruth(rawFrontSummary,remoteTruth);
    const frontValues=Object.values(frontSummary);
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',release_id:RELEASE.id,commercial_enabled:gate.enabled,lifecycle_approved:gate.lifecycle_approved,channels:channelSummary,distribution:{technical_ready:distribution.technical_ready,operational_ready:frontValues.every(x=>x.operational_ready),total_fronts:frontValues.length,configured_fronts:frontValues.filter(x=>x.operational_ready).length,automation_ready_fronts:frontValues.filter(x=>x.automation_ready).length,fronts:frontSummary},brand_identity:{ready:brand.ready,verified_fronts:brand.verified_fronts,total_fronts:brand.total_fronts},certification_pilot:{enabled:pilot.enabled,ready:pilot.ready},excluded_fronts:EXCLUDED_COMMERCIAL_FRONTS,production_mode:gate.enabled?'commercial-gated':'pre-sale-blocked'}));
  }
  if(view==='creative_sample'){
    const origin=`${String(req.headers?.['x-forwarded-proto']||'https').split(',')[0]}://${String(req.headers?.['x-forwarded-host']||req.headers?.host||'zevanory.api.br').split(',')[0]}`;
    const common={offerId:'OFFER-0001',hook:'Automacao com controle',body:'IA, execucao segura e evidencia real.',cta:'Conheca a ZEVANORY'};
    const image=await selectCreativeVariantWithVisualEvidence(null,{...common,channel:'instagram'}),video=await selectCreativeVariantWithVisualEvidence(null,{...common,channel:'youtube'});
    const imageSpec=image.winner.spec,videoSpec=video.winner.spec;
    const summary=x=>x.ranking.map(v=>({creative_id:v.spec.creative_id,variant_id:v.variant_id,layout:v.spec.layout,quality_score:v.quality_score,perceptual_score:v.perceptual_score,visual_min_frame_score:v.visual_min_frame_score,visual_frames:(v.visual_frames||[]).map(f=>({mode:f.mode,score:f.score,dynamic_range:Number(f.dynamic_range?.toFixed?.(2)||f.dynamic_range||0),luminance_std:Number(f.luminance_std?.toFixed?.(2)||f.luminance_std||0),occupied_fraction:Number(f.occupied_fraction?.toFixed?.(4)||f.occupied_fraction||0),edge_density:Number(f.edge_density?.toFixed?.(4)||f.edge_density||0),overflow:f.overflow===true,lines:Number(f.lines||f.hook_lines||f.body_lines||0)})),selection_score:v.selection_score,observed_ready:v.observed_ready,review_board:v.review_board}));
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',engine:'creative-intelligence-v2',review_policy:{board:'senior-creative-review-v1',analysts:5,required:5,unanimous_required:true},image_selection_basis:image.selection_basis,video_selection_basis:video.selection_basis,image_review_board:image.review_board,video_review_board:video.review_board,image_technical_release_ready:image.technical_release_ready,video_technical_release_ready:video.technical_release_ready,image_variants:summary(image),video_variants:summary(video),image_creative_id:imageSpec.creative_id,video_creative_id:videoSpec.creative_id,png_url:`${origin}/brand/creative-sample.png`,webm_url:`${origin}/brand/creative-sample.webm`}));
  }

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
    channels: await channelStatusWithOAuth(false),
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

