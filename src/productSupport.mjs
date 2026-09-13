import { decideWithAiProviders } from './aiProvider.mjs';

const TRUST_WEIGHT=Object.freeze({official:1,verified:.95,internal:.8,unverified:0});
const clean=(value,max=1200)=>String(value??'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const unique=(values)=>[...new Set(values.filter(Boolean).map(String))];
const commercialRx=/\b(compre|comprar|checkout|pagamento|pague|pix|cupom|desconto|promo[cç][aã]o|oferta)\b|r\$\s*\d/i;
const riskyRx=/\b(produ[cç][aã]o|banco de dados|database|migra[cç][aã]o|token|credencial|senha|criptograf|permiss[aã]o|dns|deploy|webhook|backup|restore|restaur|excluir|apagar|reset|formatar)\b/i;

export const ELITE_PRODUCT_SUPPORT_POLICY=Object.freeze({
  version:'elite-senior-product-support-v1',
  minimum_confidence:.82,
  standard_min_sources:1,
  high_risk_min_sources:2,
  accepted_trust:Object.freeze(['official','verified','internal']),
  support_channels:Object.freeze(['whatsapp','email']),
});

export function normalizeSupportRequest(input={}){
  return Object.freeze({
    case_id:clean(input.case_id,80),product_code:clean(input.product_code||input.product,120),
    product_version:clean(input.product_version||input.version,80),module:clean(input.module,120),
    symptom:clean(input.symptom,1200),error_code:clean(input.error_code,200),question:clean(input.question,1600),
    channel:clean(input.channel,40).toLowerCase(),customer_context:input.customer_context||null,
    recent_conversation:Object.freeze((Array.isArray(input.recent_conversation)?input.recent_conversation:[]).map(x=>clean(x,800)).filter(Boolean).slice(0,6)),
  });
}
export function buildSupportKnowledgeQuery(request={}){
  const r=normalizeSupportRequest(request);
  return unique([r.product_code,r.product_version,r.module,r.error_code,r.symptom,r.question]).join(' ').slice(0,500);
}

export function evaluateSupportEvidence(request={},knowledge=[]){
  const r=normalizeSupportRequest(request),highRisk=riskyRx.test([r.symptom,r.question,r.module].join(' '));
  const accepted=(Array.isArray(knowledge)?knowledge:[]).filter(x=>ELITE_PRODUCT_SUPPORT_POLICY.accepted_trust.includes(String(x?.trust_level||''))&&String(x?.source_ref||'').trim());
  const weighted=accepted.map(x=>({source_ref:String(x.source_ref),trust_level:String(x.trust_level),weight:TRUST_WEIGHT[String(x.trust_level)]||0}));
  const min=highRisk?ELITE_PRODUCT_SUPPORT_POLICY.high_risk_min_sources:ELITE_PRODUCT_SUPPORT_POLICY.standard_min_sources;
  const productKnown=Boolean(r.product_code),versionKnown=Boolean(r.product_version);
  const ready=productKnown&&accepted.length>=min&&(!highRisk||versionKnown);
  return Object.freeze({ready,high_risk:highRisk,required_sources:min,source_count:accepted.length,product_known:productKnown,version_known:versionKnown,sources:Object.freeze(weighted),reason:ready?'evidence_sufficient':!productKnown?'product_identity_required':highRisk&&!versionKnown?'product_version_required':'verified_sources_required'});
}

export function validateSupportDecision(decision={},evidence={}){
  const issues=[],action=clean(decision.action,40).toLowerCase(),message=clean(decision.message||decision.content,5000);
  const confidence=Number(decision.confidence),citations=unique(Array.isArray(decision.source_refs)?decision.source_refs:[]);
  if(!['support_reply','support_escalate','support_request_context'].includes(action))issues.push('invalid_support_action');
  if(!message)issues.push('support_message_required');
  if(!Number.isFinite(confidence)||confidence<0||confidence>1)issues.push('invalid_support_confidence');
  if(commercialRx.test(message))issues.push('commercial_content_forbidden_in_support');
  if(action==='support_reply'){
    if(!evidence.ready)issues.push('support_evidence_not_ready');
    if(confidence<ELITE_PRODUCT_SUPPORT_POLICY.minimum_confidence)issues.push('support_confidence_below_elite_threshold');
    const allowed=new Set((evidence.sources||[]).map(x=>String(x.source_ref)));
    if(citations.length<evidence.required_sources||citations.some(x=>!allowed.has(x)))issues.push('support_citations_invalid_or_insufficient');
  }
  return Object.freeze({pass:issues.length===0,score:Math.max(0,1-issues.length*.2),issues:Object.freeze(issues),citations:Object.freeze(citations)});
}
export const PRODUCT_SUPPORT_SYSTEM_POLICY=`You are ZEVANORY's elite senior product support engineer.
Answer only from supplied product knowledge and customer context. Never invent commands, settings, versions, compatibility, credentials, data state, incident cause or resolution.
Identify product, version, module, symptom and error before risky guidance. For high-risk operations require product version and at least two verified sources.
Prefer diagnosis before mutation. Never request passwords, full tokens or secrets. Never instruct destructive actions without explicit verified recovery/backup guidance in supplied evidence.
If evidence is insufficient, choose support_request_context or support_escalate. Do not guess.
Support is strictly non-commercial: never add prices, offers, checkout, discounts, scarcity or sales CTAs.
Output strict JSON: action, rationale, confidence, message, source_refs, diagnosis, next_step and escalation_reason when applicable.`;

export async function decideEliteProductSupport({request,knowledge=[],providers=[],apiKey,model}={}){
  const normalized=normalizeSupportRequest(request),evidence=evaluateSupportEvidence(normalized,knowledge);
  if(!evidence.ready){
    const missing=evidence.reason==='product_identity_required'?'o produto':evidence.reason==='product_version_required'?'a versão exata do produto':'evidência técnica suficiente';
    return Object.freeze({action:'support_request_context',rationale:evidence.reason,confidence:1,message:`Para orientar com segurança, preciso confirmar ${missing} antes de indicar uma correção.`,source_refs:[],diagnosis:null,next_step:evidence.reason,evidence});
  }
  const input={support_request:normalized,knowledge,required_source_refs:evidence.sources.map(x=>x.source_ref),evidence_policy:evidence};
  const decision=await decideWithAiProviders({input,systemInstruction:PRODUCT_SUPPORT_SYSTEM_POLICY,providers,apiKey,model});
  const validated=validateSupportDecision(decision,evidence);
  if(!validated.pass)return Object.freeze({action:'support_escalate',rationale:'support_answer_failed_elite_gate',confidence:1,message:'Vou encaminhar este caso para uma análise técnica mais profunda porque ainda não há segurança suficiente para orientar uma alteração.',source_refs:[],diagnosis:null,next_step:'engineering_review',escalation_reason:validated.issues.join(','),evidence,validation:validated});
  return Object.freeze({...decision,evidence,validation:validated});
}
