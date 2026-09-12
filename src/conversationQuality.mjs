const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const normalize=(v)=>String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const words=(v)=>new Set(normalize(v).split(' ').filter(x=>x.length>2));
const ratio=(a,b)=>{
  const A=words(a),B=words(b);if(!A.size||!B.size)return 0;
  let hit=0;for(const x of A)if(B.has(x))hit++;
  return hit/Math.max(1,new Set([...A,...B]).size);
};

export const ELITE_CONVERSATION_POLICY=Object.freeze({
  version:'elite-conversation-v1',
  min_message_chars:8,
  max_message_chars:1600,
  max_exclamations:2,
  max_uppercase_ratio:.28,
  max_recent_similarity:.72,
  max_questions:2,
});

const manipulative=[/ultima chance/i,/agora ou nunca/i,/voce vai perder/i,/garantid[oa]/i,/sem risco/i,/100% garant/i,/resultado garant/i];
const robotic=[/prezado cliente/i,/venho por meio desta/i,/conforme solicitado anteriormente/i,/estimado cliente/i];
export function evaluateConversationQuality({message='',channel='',recentMessages=[],decision={}}={}){
  const issues=[];const text=String(message||'').trim();const canonical=normalize(text);
  const cfg=ELITE_CONVERSATION_POLICY;
  if(text.length<cfg.min_message_chars)issues.push('message_too_short');
  if(text.length>cfg.max_message_chars)issues.push('message_too_long');
  if((text.match(/!/g)||[]).length>cfg.max_exclamations)issues.push('excessive_exclamation');
  if((text.match(/\?/g)||[]).length>cfg.max_questions)issues.push('too_many_questions');
  const letters=(text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g)||[]);const upper=letters.filter(x=>x===x.toUpperCase()&&x!==x.toLowerCase()).length;
  if(letters.length>=12&&upper/letters.length>cfg.max_uppercase_ratio)issues.push('excessive_uppercase');
  if(manipulative.some(rx=>rx.test(canonical)))issues.push('manipulative_or_unproven_claim');
  if(robotic.some(rx=>rx.test(canonical)))issues.push('robotic_language');
  const recent=(Array.isArray(recentMessages)?recentMessages:[]).slice(0,8);
  if(recent.some(x=>ratio(text,x)>=cfg.max_recent_similarity))issues.push('recent_message_repetition');
  if(/^(oi|ola|olá)[,.! ]*$/i.test(text))issues.push('low_information_message');
  if(decision.confidence!==undefined&&clamp(decision.confidence,0,1)<.35)issues.push('low_confidence_message');
  return Object.freeze({
    pass:issues.length===0,
    score:Number(Math.max(0,1-issues.length*.14).toFixed(2)),
    issues:Object.freeze(issues),
    policy_version:cfg.version,
    channel:String(channel||'unknown').toLowerCase(),
  });
}
