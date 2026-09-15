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
import { adviseMediaInvestment } from '../src/mediaInvestmentAdvisor.mjs';
import { verifyFacebookIdentity, verifyInstagramIdentity, verifyWhatsappIdentity, verifyYouTubeIdentity } from '../src/channelIdentityPreflight.mjs';
import { loadMetaCredential } from '../src/metaOAuth.mjs';
import { createHash } from 'node:crypto';

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
  const displayNameMaintenance=view==='whatsapp_display_name_update'&&req.method==='POST';
  if (req.method !== 'GET' && !creativeAssetRequest && !displayNameMaintenance) {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  if(view==='whatsapp_display_name_update'){
    const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'').trim();
    const providedHash=createHash('sha256').update(provided).digest('hex');
    if(!provided||!safeBearerEqual(providedHash,'675cbdb48110f3461dfcd6ffd985ee0264268153eca62cff5f548d66542bb1f9')){res.statusCode=401;res.setHeader('cache-control','no-store');return res.end(JSON.stringify({error:'maintenance_auth_required'}));}
    const phoneId=String(process.env.WHATSAPP_PHONE_NUMBER_ID||'').trim(),version=String(process.env.META_GRAPH_VERSION||'v26.0'),wabaId='1765777697944833';
    const candidates=[];const waToken=String(process.env.WHATSAPP_ACCESS_TOKEN||'').trim();if(waToken)candidates.push({name:'whatsapp_runtime',token:waToken});
    if(process.env.DATABASE_URL){try{const c=await loadMetaCredential(neon(process.env.DATABASE_URL),process.env);if(c?.access_token&&c.access_token!==waToken)candidates.push({name:'meta_oauth_persisted',token:c.access_token});}catch{}}
    if(!phoneId||candidates.length===0){res.statusCode=503;return res.end(JSON.stringify({error:'whatsapp_credentials_missing'}));}
    const endpoint=`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}`,fields='id,display_phone_number,verified_name,name_status,new_name_status,quality_rating';
    const safeError=b=>({code:b?.error?.code||null,subcode:b?.error?.error_subcode||null,type:String(b?.error?.type||''),message:String(b?.error?.message||'').slice(0,500),user_title:String(b?.error?.error_user_title||'').slice(0,300),user_msg:String(b?.error?.error_user_msg||'').slice(0,500),details:String(b?.error?.error_data?.details||'').slice(0,500)});
    const out=[];let success=false;
    for(const c of candidates){
      const h={authorization:`Bearer ${c.token}`};
      const pr=await fetch(`https://graph.facebook.com/${version}/me/permissions`,{headers:h,signal:AbortSignal.timeout(10000)});const pb=await pr.json().catch(()=>({}));
      const permissions=Array.isArray(pb?.data)?pb.data.filter(x=>x?.status==='granted').map(x=>String(x.permission)).sort():[];
      const wr=await fetch(`https://graph.facebook.com/${version}/${wabaId}?fields=id,name,business_verification_status,status`,{headers:h,signal:AbortSignal.timeout(10000)});const wb=await wr.json().catch(()=>({}));
      const br=await fetch(`${endpoint}?fields=${fields}`,{headers:h,signal:AbortSignal.timeout(10000)});const bb=await br.json().catch(()=>({}));
      let ur=null,ub={};if(br.ok){ur=await fetch(endpoint,{method:'POST',headers:{...h,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',new_display_name:'ZEVANORY'}),signal:AbortSignal.timeout(10000)});ub=await ur.json().catch(()=>({}));}
      const ar=await fetch(`${endpoint}?fields=${fields}`,{headers:h,signal:AbortSignal.timeout(10000)});const ab=await ar.json().catch(()=>({}));
      const ok=Boolean(ur?.ok);success=success||ok;out.push({credential:c.name,permissions_http:pr.status,permissions,waba_http:wr.status,waba_accessible:wr.ok,phone_read_http:br.status,phone_accessible:br.ok,update_http:ur?.status||null,update_ok:ok,error:ok?null:safeError(ub),before:br.ok?bb:null,after:ar.ok?ab:null});
      if(ok)break;
    }
    res.statusCode=success?200:502;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(JSON.stringify({ok:success,candidates:out}));
  }
  if(view==='channel_identity_health'){
    let metaEnv=process.env,persisted={},sql=null;
    if(process.env.DATABASE_URL){try{sql=neon(process.env.DATABASE_URL);persisted=await persistedOAuthReadiness(sql);const c=await loadMetaCredential(sql,process.env);metaEnv={...process.env,META_ACCESS_TOKEN:c.access_token,META_PAGE_ID:c.page_id,INSTAGRAM_BUSINESS_ACCOUNT_ID:c.instagram_id};}catch{}}
    const [facebook,instagram,whatsapp,youtube]=await Promise.all([verifyFacebookIdentity({env:metaEnv}),verifyInstagramIdentity({env:metaEnv}),verifyWhatsappIdentity(),verifyYouTubeIdentity()]);
    const brand=brandIdentityReadiness().fronts||{};
    const safe=(channel,x)=>({attempted:Boolean(x.attempted),verified:Boolean(x.verified),reason:String(x.reason||'unknown'),verification_source:x.verified?'provider_live':'none',stored_configuration:Boolean(persisted[channel]===true&&brand[channel]?.verified===true),...(channel==='instagram'?{whatsapp_contact_visible:x.whatsapp_contact_visible===true,whatsapp_route_ready:x.whatsapp_route_ready===true,whatsapp_route_mode:x.whatsapp_route_mode||'none',biography:x.biography||'',website:x.website||''}:{}),...(channel==='whatsapp'?{verified_name:x.verified_name||'',name_status:x.name_status||'',quality_rating:x.quality_rating||'',display_phone_number:x.display_phone_number||''}:{})});
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',fresh_provider_truth_required:true,facebook:safe('facebook',facebook),instagram:safe('instagram',instagram),whatsapp:safe('whatsapp',whatsapp),youtube:safe('youtube',youtube)}));
  }
  if(view==='creative_asset'){
    const token=verifyCreativeToken(url.searchParams.get('p'),url.searchParams.get('s'),process.env);
    if(!token){res.statusCode=403;res.setHeader('cache-control','no-store');return res.end('invalid_creative_token');}
    const etag=creativeAssetEtag(token.spec,token.format);if(String(req.headers?.['if-none-match']||'')===etag){res.statusCode=304;res.setHeader('etag',etag);res.setHeader('cache-control','public, max-age=31536000, s-maxage=31536000, immutable');return res.end();}
    try{const { renderCreativeAsset }=await import('../src/creativeRenderer.mjs');const body=await renderCreativeAsset(token.spec,token.format);const mime=token.format==='webm'?'video/webm':'image/png';const range=String(req.headers?.range||'');let status=200,payload=body;res.setHeader('accept-ranges','bytes');if(req.method==='GET'&&range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m){res.statusCode=416;res.setHeader('content-range',`bytes */${body.length}`);return res.end();}const start=Number(m[1]),end=m[2]?Math.min(Number(m[2]),body.length-1):body.length-1;if(start>=body.length||end<start){res.statusCode=416;res.setHeader('content-range',`bytes */${body.length}`);return res.end();}status=206;payload=body.subarray(start,end+1);res.setHeader('content-range',`bytes ${start}-${end}/${body.length}`);}res.statusCode=status;res.setHeader('content-type',mime);res.setHeader('content-length',String(req.method==='HEAD'?body.length:payload.length));res.setHeader('cache-control','public, max-age=31536000, s-maxage=31536000, immutable');res.setHeader('etag',etag);res.setHeader('x-content-type-options','nosniff');res.setHeader('x-creative-id',token.spec.creative_id);return req.method==='HEAD'?res.end():res.end(payload);}catch(error){console.error('creative_render_failed',{creative_id:token.spec.creative_id,message:String(error?.message||'render_failed')});res.statusCode=503;res.setHeader('cache-control','no-store');return res.end('creative_render_unavailable');}
  }
  if(view==='meta-migration-probe'){
    const raw=String(process.env.META_ACCESS_TOKEN||'').trim(),fallback=String(process.env.WHATSAPP_ACCESS_TOKEN||'').trim();
    const token=raw&&raw!=='[SENSITIVE]'?raw:fallback;const pageId=/^\d{8,30}$/.test(String(process.env.META_PAGE_ID||''))?String(process.env.META_PAGE_ID):'1249902628211703';const version=/^v\d+\.\d+$/.test(String(process.env.META_GRAPH_VERSION||''))?String(process.env.META_GRAPH_VERSION):'v26.0';
    let out={facebook:false,instagram:false,token_source:raw&&raw!=='[SENSITIVE]'?'meta':'whatsapp',reason:'provider_unavailable'};try{const r=await fetch(`https://graph.facebook.com/${version}/${pageId}?fields=id,name,instagram_business_account{id,username}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(7000)});const b=await r.json().catch(()=>({}));const facebook=r.ok&&String(b?.id||'')===pageId&&String(b?.name||'').trim().toUpperCase()==='ZEVANORY';const ig=b?.instagram_business_account||{};const instagram=facebook&&String(ig?.username||'').trim().toLowerCase()==='zevanory_';out={facebook,instagram,token_source:out.token_source,reason:r.ok?'checked':`provider_http_${r.status}`,page_id:facebook?pageId:null,instagram_id:instagram?String(ig.id||''):null};}catch{}
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;return res.end(JSON.stringify(out));
  }
  if(view==='closure_status'){
    let runtimeOAuth={},metaEnv=process.env,sql=null;
    if(process.env.DATABASE_URL){try{sql=neon(process.env.DATABASE_URL);runtimeOAuth=await persistedOAuthReadiness(sql);const c=await loadMetaCredential(sql,process.env);metaEnv={...process.env,META_ACCESS_TOKEN:c.access_token,META_PAGE_ID:c.page_id,INSTAGRAM_BUSINESS_ACCOUNT_ID:c.instagram_id};}catch{runtimeOAuth=runtimeOAuth||{};}}
    const gate=salesGate(),localChannels=overlayPersistedOAuth(publicChannelReadinessSummary(),runtimeOAuth),distribution=commercialDistributionReadiness(process.env,runtimeOAuth),brand=brandIdentityReadiness(),pilot=certificationPilotStatus();
    const [facebookIdentity,instagramIdentity,whatsappIdentity]=await Promise.all([verifyFacebookIdentity({env:metaEnv}),verifyInstagramIdentity({env:metaEnv}),verifyWhatsappIdentity()]);
    const identityBlockers=[];
    for(const [name,state] of Object.entries({facebook:facebookIdentity,instagram:instagramIdentity,whatsapp:whatsappIdentity}))if(state.attempted&&!state.verified)identityBlockers.push(`${name}_provider_identity_unverified`);
    const whatsappPresenceBlockers=[]; if(instagramIdentity.attempted&&instagramIdentity.verified&&!instagramIdentity.whatsapp_route_ready)whatsappPresenceBlockers.push('instagram_whatsapp_route_unverified');
    const freshBrandReady=brand.ready&&identityBlockers.length===0;
    const remoteTruth=await remoteRuntimeChannelTruth(process.env);
    const channels=overlayRemoteChannelTruth(localChannels,remoteTruth);
    const channelSummary=Object.fromEntries(Object.entries(channels).map(([name,state])=>[name,{operational_ready:state.operational_ready,operational_mode:state.operational_mode,api_configured:state.api_configured,alternate_api_configured:state.alternate_api_configured,contingency_ready:state.contingency_ready}]));
    const rawFrontSummary=Object.fromEntries(Object.entries(distribution.fronts).map(([name,state])=>[name,{operational_ready:state.operational_ready,operational_mode:state.operational_mode,automation_ready:state.automation_ready,contingency_ready:state.contingency_ready}]));
    const frontSummary=overlayRemoteChannelTruth(rawFrontSummary,remoteTruth);
    const frontValues=Object.values(frontSummary);
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',release_id:RELEASE.id,commercial_enabled:gate.enabled,lifecycle_approved:gate.lifecycle_approved,channels:channelSummary,distribution:{technical_ready:distribution.technical_ready,operational_ready:frontValues.every(x=>x.operational_ready),total_fronts:frontValues.length,configured_fronts:frontValues.filter(x=>x.operational_ready).length,automation_ready_fronts:frontValues.filter(x=>x.automation_ready).length,fronts:frontSummary},brand_identity:{ready:freshBrandReady,configured_ready:brand.ready,verified_fronts:brand.verified_fronts,total_fronts:brand.total_fronts,fresh_provider_blockers:identityBlockers},whatsapp_presence:{ready:whatsappPresenceBlockers.length===0,blockers:whatsappPresenceBlockers},certification_pilot:{enabled:pilot.enabled,ready:pilot.ready},excluded_fronts:EXCLUDED_COMMERCIAL_FRONTS,production_mode:gate.enabled?'commercial-gated':'pre-sale-blocked'}));
  }
  if(view==='creative_sample'){
    const origin=`${String(req.headers?.['x-forwarded-proto']||'https').split(',')[0]}://${String(req.headers?.['x-forwarded-host']||req.headers?.host||'zevanory.api.br').split(',')[0]}`;
    const common={offerId:'OFFER-0001',hook:'Automação com controle',body:'IA, execução segura e evidência real.',cta:'Conheça a ZEVANORY'};
    const sql=process.env.DATABASE_URL?neon(process.env.DATABASE_URL):null;
    const image=await selectCreativeVariantWithVisualEvidence(sql,{...common,channel:'instagram'}),video=await selectCreativeVariantWithVisualEvidence(sql,{...common,channel:'youtube'});
    const imageSpec=image.winner.spec,videoSpec=video.winner.spec;
    const spendRows=sql?await sql.query(`select campaign_id,variant_id,sum(spend_brl)::numeric spend_brl,max(occurred_at) last_spend_at from media_spend_events where campaign_id in ($1,$2) group by campaign_id,variant_id`,[imageSpec.campaign_id,videoSpec.campaign_id]).catch(()=>[]):[];
    const spendMap=new Map(spendRows.map(r=>[`${r.campaign_id}:${r.variant_id}`,r]));
    const summary=x=>x.ranking.map(v=>{
      const spend=spendMap.get(`${v.spec.campaign_id}:${v.variant_id}`)||{};
      const advisor=adviseMediaInvestment({creative:v,economics:{...v,acquisition_spend_brl:Number(spend.spend_brl||0)},current_daily_budget_brl:0});
      return {creative_id:v.spec.creative_id,variant_id:v.variant_id,layout:v.spec.layout,quality_score:v.quality_score,perceptual_score:v.perceptual_score,visual_min_frame_score:v.visual_min_frame_score,visual_frames:(v.visual_frames||[]).map(f=>({mode:f.mode,score:f.score,dynamic_range:Number(f.dynamic_range?.toFixed?.(2)||f.dynamic_range||0),luminance_std:Number(f.luminance_std?.toFixed?.(2)||f.luminance_std||0),occupied_fraction:Number(f.occupied_fraction?.toFixed?.(4)||f.occupied_fraction||0),edge_density:Number(f.edge_density?.toFixed?.(4)||f.edge_density||0),overflow:f.overflow===true,lines:Number(f.lines||f.hook_lines||f.body_lines||0)})),selection_score:v.selection_score,observed_ready:v.observed_ready,review_board:v.review_board,sessions:v.sessions||0,paid:v.paid||0,net_revenue_brl:v.net_revenue_brl||0,media_spend_brl:Number(spend.spend_brl||0),advisor};
    });
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.statusCode=200;
    return res.end(JSON.stringify({service:'ZEVANORY',engine:'creative-intelligence-v2',review_policy:{board:'senior-creative-review-v1',analysts:5,required:5,unanimous_required:true},image_selection_basis:image.selection_basis,video_selection_basis:video.selection_basis,image_review_board:image.review_board,video_review_board:video.review_board,image_technical_release_ready:image.technical_release_ready,video_technical_release_ready:video.technical_release_ready,image_variants:summary(image),video_variants:summary(video),image_creative_id:imageSpec.creative_id,video_creative_id:videoSpec.creative_id,png_url:`${origin}/brand/creative-sample.svg`,webm_url:`${origin}/brand/creative-sample.webm`}));
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

