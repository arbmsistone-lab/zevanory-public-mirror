import { createHash } from 'node:crypto';
import { defineExecutionProvider, executeUniversallySafely } from './universalExecutionFabric.mjs';

export const DEFAULT_AI_MODEL = 'gemini-3.7-flash';
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function deterministicDecision(input = {}) {
  const stage = String(input.stage || 'new');
  const map = {
    new: 'first_response', contacted: 'qualify', qualified: 'offer',
    offer_sent: 'follow_up', checkout_started: 'follow_up',
  };
  const action=String(input.job_type||'')==='learning_review'?'learn_outcomes':(map[stage]||'review');
  return Object.freeze({
    provider: 'deterministic', model: 'rules-v1', mode: 'deterministic',
    action, confidence: 1,
    rationale: 'Fail-safe deterministic policy used because AI is unavailable or not required.',
    input_hash: hash(input),
  });
}

export async function askGemini({ input, systemInstruction, apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_AI_MODEL } = {}) {
  if (!apiKey || process.env.AGENT_AI_ENABLED !== 'true') return deterministicDecision(input);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    system_instruction: { parts: [{ text: String(systemInstruction || '') }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(input || {}) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const started = Date.now();
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`gemini_http_${response.status}`);
  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';
  let decision;
  try { decision = JSON.parse(text); } catch { throw new Error('gemini_invalid_json'); }
  return Object.freeze({ provider: 'google', model, mode: 'ai_assisted', latency_ms: Date.now() - started, input_hash: hash(input), ...decision });
}

async function askOpenAiCompatible({input,systemInstruction,apiKey,model,endpoint,provider}){
  if(!apiKey||process.env.AGENT_AI_ENABLED!=="true") throw new Error(`${provider}_not_configured`);
  const started=Date.now();
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,messages:[{role:'system',content:String(systemInstruction||'')},{role:'user',content:JSON.stringify(input||{})}],temperature:0.2,response_format:{type:'json_object'}}),signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`${provider}_http_${response.status}`);
  const json=await response.json();
  const text=String(json?.choices?.[0]?.message?.content||'{}');
  let decision; try{decision=JSON.parse(text);}catch{throw new Error(`${provider}_invalid_json`);}
  return Object.freeze({provider,model,mode:'ai_assisted',latency_ms:Date.now()-started,input_hash:hash(input),...decision});
}

function buildCompatProvider({id,domain,key,model,endpoint}){
  if(!key||process.env.AGENT_AI_ENABLED!=='true') return null;
  return defineExecutionProvider({id,capabilities:['ai:decision'],independenceDomain:domain,cost:0,health:async()=>({state:'available'}),execute:async({input,systemInstruction})=>askOpenAiCompatible({input,systemInstruction,apiKey:key,model,endpoint,provider:id})});
}
export function buildGeminiExecutionProvider({apiKey=process.env.GEMINI_API_KEY,model=process.env.GEMINI_MODEL||DEFAULT_AI_MODEL}={}){
  if(!apiKey||process.env.AGENT_AI_ENABLED!=='true') return null;
  return defineExecutionProvider({
    id:'ai-gemini-adapter',capabilities:['ai:decision'],independenceDomain:'google-ai',cost:0,
    health:async()=>({state:'available'}),
    execute:async({input,systemInstruction})=>askGemini({input,systemInstruction,apiKey,model}),
  });
}

export async function decideWithAiProviders({input,systemInstruction,providers=[],apiKey,model}={}){
  const dynamic=[...providers];
  const gemini=buildGeminiExecutionProvider({apiKey,model});
  if(gemini) dynamic.push(gemini);
  const mistral=buildCompatProvider({id:'ai-mistral-adapter',domain:'mistral-ai',key:process.env.MISTRAL_API_KEY,model:process.env.MISTRAL_MODEL||'mistral-small-latest',endpoint:'https://api.mistral.ai/v1/chat/completions'});
  const groq=buildCompatProvider({id:'ai-groq-adapter',domain:'groqcloud',key:process.env.GROQ_API_KEY,model:process.env.GROQ_MODEL||'llama-3.3-70b-versatile',endpoint:'https://api.groq.com/openai/v1/chat/completions'});
  if(mistral) dynamic.push(mistral);
  if(groq) dynamic.push(groq);
  const domains=new Set(dynamic.map((p)=>String(p?.independence_domain||'')).filter(Boolean));
  if(domains.size<3) return Object.freeze({...deterministicDecision(input),fallback_reason:'ai_mesh_redundancy_below_minimum',configured_independent_domains:domains.size,minimum_independent_domains:3});
  const routed=await executeUniversallySafely({
    operation:{input,systemInstruction},providers:dynamic,
    requirements:{capabilities:['ai:decision'],zeroCost:true},
  });
  if(!routed.ok) return Object.freeze({...deterministicDecision(input),fallback_reason:routed.reason,provider_attempts:routed.attempts});
  return Object.freeze({...routed.result,routed_provider:routed.provider,routed_domain:routed.independence_domain});
}
