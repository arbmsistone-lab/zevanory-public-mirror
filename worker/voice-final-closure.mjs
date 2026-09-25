import { voiceStudyStatus } from "./voice-naturality-study.mjs";
import { whatsappOnboardingStatus } from "./whatsapp-onboarding.mjs";
import { whatsappE2EStatus } from "./whatsapp-e2e-evidence.mjs";
import { voiceProviderStatus } from "./voice-provider-router.mjs";

async function readFinalCertificate(env={}){
  const kv=env.ZEVANORY_PRIVATE_ARTIFACTS||null;
  if(!kv?.get) return null;
  return kv.get("voice-final/certification",{type:"json"}).catch(()=>null);
}
export async function voiceFinalClosureStatus(env={}){
  const [study,whatsapp,e2e,certificate]=await Promise.all([
    voiceStudyStatus(env),
    whatsappOnboardingStatus(env),
    whatsappE2EStatus(env),
    readFinalCertificate(env)
  ]);
  const router=voiceProviderStatus(env);
  const release_sha=String(env.ZEVANORY_RELEASE_SHA||"").trim();
  const transport=whatsapp.configured===true&&whatsapp.identity_verified===true&&whatsapp.webhook_configured===true&&whatsapp.waba_subscribed===true&&whatsapp.phone_registration_ok===true;
  const zeroSpend=router.zero_spend_enforced===true&&router.providers.some(x=>x.available===true);
  const certifiedSha=String(certificate?.sha||"");
  const certificationEvidenceBound=Boolean(release_sha&&study.release_sha===release_sha);
  const whatsappE2EBound=Boolean(release_sha&&e2e.release_sha===release_sha);
  const canonical=Boolean(release_sha&&certifiedSha&&release_sha===certifiedSha);
  const regression=certificate?.regression_gates===true&&canonical;
  const productionProbe=certificate?.production_probe===true&&canonical;
  const finalGreen=study.certified===true&&certificationEvidenceBound&&transport&&e2e.e2e===true&&whatsappE2EBound&&zeroSpend&&regression&&productionProbe&&canonical;
  return Object.freeze({
    schema_version:1,
    service:"ZEVANORY",
    engine:"ZEVANORY Voice Support Final Closure",
    release_sha:release_sha||null,
    certified_sha:certifiedSha||null,
    canonical_sha_consistent:canonical,
    perceptual_evidence_sha:study.release_sha||null,
    perceptual_evidence_same_sha:certificationEvidenceBound,
    whatsapp_e2e_sha:e2e.release_sha||null,
    whatsapp_e2e_same_sha:whatsappE2EBound,
    voice_router:router.providers.some(x=>x.available===true),
    voice_provider_failover:router.failover_enabled===true,
    voice_zero_spend:zeroSpend,
    voice_perceptual_sample_count:Number(study.unique_evaluators||0),
    voice_perceptual_clips_covered:Number(study.clips_covered||0),
    voice_perceptual_blinding:study.blinded===true&&study.provider_disclosed===false,
    voice_perceptual_score:Number(study.natural_acceptance_pct||0),
    voice_intelligibility_score:Number(study.intelligibility_pct||0),
    voice_mean_naturalness_5:Number(study.mean_naturalness_5||0),
    voice_naturality_certified:study.certified===true,
    whatsapp_number_configured:whatsapp.identity_verified===true,
    whatsapp_transport_configured:transport,
    whatsapp_webhook:whatsapp.webhook_configured===true&&whatsapp.waba_subscribed===true,
    whatsapp_inbound:e2e.inbound===true,
    whatsapp_runtime_processing:e2e.runtime_processing===true,
    whatsapp_tts:e2e.tts===true,
    whatsapp_outbound:e2e.outbound===true,
    whatsapp_delivery:e2e.delivery===true,
    whatsapp_e2e:e2e.e2e===true,
    regression_gates:regression,
    production_probe:productionProbe,
    zero_spend:zeroSpend,
    final_green:finalGreen,
    e2e_chain:e2e.chain
  });
}
export async function handleVoiceFinalClosure(request,env={}){
  const url=new URL(request.url);
  if(url.pathname!=="/api/voice/final-closure") return null;
  if(request.method!=="GET") return new Response(JSON.stringify({error:"method_not_allowed"}),{status:405,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
  return new Response(JSON.stringify(await voiceFinalClosureStatus(env)),{status:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
