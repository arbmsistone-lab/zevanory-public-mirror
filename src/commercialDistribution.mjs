import { channelReadiness } from './channelAdapters.mjs';
import { evaluateAffiliateProgramReadiness } from './affiliateProgram.mjs';
import { assistedFallbackReadiness } from './assistedChannelFallbacks.mjs';
import { alternateAutomationReadiness } from './alternateChannelAutomation.mjs';
import { nuvemshopCsvFallbackReadiness } from './nuvemshopCsvFallback.mjs';
import { ACTIVE_COMMERCIAL_FRONTS } from './activeCommercialScope.mjs';

const front=(category,role,truth,attribution,confirmation)=>Object.freeze({category,role,revenue_truth:truth,attribution,provider_confirmation:confirmation,global_gate_required:true,policy_complete:true});
export const COMMERCIAL_DISTRIBUTION_CANONICAL=Object.freeze({
  zevanory:front('owned','conversion_hub','authenticated_payment','first_party_utm_session','first_party_checkout'),
  whatsapp:front('messaging','conversation_support','authenticated_payment','lead_session_touchpoint','provider_webhook'), email:front('messaging','crm_nurture','authenticated_payment','utm_and_lead_touchpoint','provider_webhook'),
  instagram:front('social','proof_reach','authenticated_payment','utm_and_platform_touchpoint','provider_lookup'), facebook:front('social','proof_retargeting','authenticated_payment','utm_and_platform_touchpoint','provider_lookup_or_webhook'),
  tiktok:front('social','short_form_discovery','authenticated_payment','utm_and_platform_touchpoint','provider_status'), youtube:front('social','demo_authority','authenticated_payment','utm_and_platform_touchpoint','provider_status'),
  linkedin:front('social','b2b_authority','authenticated_payment','utm_and_platform_touchpoint','provider_id'), google:front('search','seo_discovery','authenticated_payment','utm_and_first_party_session','first_party_checkout'),
  affiliate:front('partner','partner_distribution','confirmed_commission_only','partner_click_to_commission','provider_lookup_or_webhook'),
  nuvemshop:front('commerce','owned_store_distribution','authenticated_payment_or_store_order','provider_order_and_utm','provider_api_and_webhook'),
  mercado_livre:front('marketplace','marketplace_distribution','provider_confirmed_order','provider_order_resource','provider_api_after_notification'),
});
export const REQUIRED_DISTRIBUTION_FRONTS=ACTIVE_COMMERCIAL_FRONTS;

export function commercialDistributionReadiness(env=process.env,runtimeOAuth={}){
  const baseChannels=channelReadiness(env), channels=Object.fromEntries(Object.entries(baseChannels).map(([k,v])=>[k,runtimeOAuth[k]?.ready?{...v,configured:true,missing:[]}:v])), affiliate=evaluateAffiliateProgramReadiness(env);
  const fronts=Object.fromEntries(REQUIRED_DISTRIBUTION_FRONTS.map((key)=>{
    const policy=COMMERCIAL_DISTRIBUTION_CANONICAL[key], state=channels[key]||{configured:false,implemented:false,missing:['channel_contract_missing']};
    const fallback=assistedFallbackReadiness(key,env), alternate=alternateAutomationReadiness(key,env), contingency=key==='nuvemshop'?nuvemshopCsvFallbackReadiness(env):{ready:false,mode:null,provider:null}, blockers=[...state.missing]; if(key==='affiliate')blockers.push(...affiliate.blockers);
    const automationReady=(state.configured||alternate.ready)&&(key!=='affiliate'||affiliate.ready), operationalReady=automationReady||fallback.ready||contingency.ready;
    const operationalMode=state.configured?'provider_api':alternate.ready?alternate.mode:fallback.ready?fallback.mode:contingency.ready?contingency.mode:'blocked';
    return [key,Object.freeze({...policy,implemented:state.implemented,configured:state.configured,automation_ready:automationReady,alternate_api_ready:alternate.ready,alternate_provider:alternate.provider,contingency_ready:contingency.ready,contingency_mode:contingency.mode,contingency_provider:contingency.provider,operational_ready:operationalReady,operational_mode:operationalMode,assisted_fallback_ready:fallback.ready,blockers:Object.freeze(operationalReady?[]:[...new Set([...blockers,...alternate.blockers,...fallback.blockers])])})];
  }));
  const values=Object.values(fronts), technicalReady=values.every(x=>x.policy_complete&&x.implemented), operationalReady=values.every(x=>x.operational_ready);
  const blockers=Object.freeze(Object.entries(fronts).flatMap(([key,state])=>state.blockers.map(code=>`${key}:${code}`)));
  return Object.freeze({version:'commercial-distribution-canonical-v2',technical_ready:technicalReady,operational_ready:operationalReady,total_fronts:values.length,implemented_fronts:values.filter(x=>x.implemented).length,configured_fronts:values.filter(x=>x.operational_ready).length,automation_ready_fronts:values.filter(x=>x.automation_ready).length,fronts:Object.freeze(fronts),blockers});
}
