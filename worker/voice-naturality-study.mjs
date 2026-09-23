import { ttsBytesWithFailover } from "./voice-provider-router.mjs";

const CORPUS = Object.freeze([
  ["support_short","Olá, aqui é o suporte da ZEVANORY. Como posso ajudar você hoje?"],
  ["support_long","Entendi o que aconteceu. Vou conferir cada etapa com cuidado e explicar, em linguagem simples, o que precisa ser feito para você continuar sem repetir passos já concluídos."],
  ["commercial","A ZEVANORY organiza automação, software e inteligência artificial para operações que precisam de mais controle, rastreabilidade e execução."],
  ["numbers","Seu protocolo é 8 4 7 2 9 e o telefone informado termina em 5 4 1 3."],
  ["prices","O valor apresentado é de cento e setenta e nove reais e noventa centavos, sem cobrança adicional automática."],
  ["date","A próxima revisão está prevista para vinte e quatro de setembro de dois mil e vinte e seis."],
  ["time","O atendimento está programado para as quatorze horas e trinta minutos, no horário de Brasília."],
  ["proper_names","A equipe da ZEVANORY atende clientes em Várzea Alegre, no Ceará."],
  ["acronyms","A API, o CRM e o TTS precisam permanecer sincronizados durante todo o atendimento."],
  ["question","Você prefere receber a orientação em texto ou em áudio?"],
  ["statement","A configuração foi validada e o sistema continua operando normalmente."],
  ["punctuation","Certo: primeiro validamos a conta; depois, o número; por fim, o webhook."],
  ["prosody","Ótimo. Agora vem a parte importante: não feche a tela até a confirmação aparecer."],
  ["pronunciation","Inteligência artificial, autenticação, configuração, integração e observabilidade."],
  ["long_sentence","Quando uma integração externa fica indisponível, a ZEVANORY deve identificar a falha, preservar o contexto, selecionar uma rota segura e continuar o atendimento sem inventar confirmações."],
  ["short_sentence","Tudo certo por aqui."],
  ["negative","Ainda não há confirmação suficiente para concluir essa etapa com segurança."],
  ["mixed_digits","O pedido 2026-091 foi registrado às 18:05 e contém 3 itens."],
  ["support_security","Para sua segurança, nunca envie senha, token, PIN ou código de verificação em uma conversa pública."],
  ["closing","Obrigado pela avaliação. Sua resposta ajuda a medir a qualidade real da voz em português do Brasil."]
]);

function json(body, status=200, extra={}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...extra}
  });
}
function html(body, status=200, extra={}) {
  return new Response(body,{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",...extra}});
}
function kv(env) { return env.ZEVANORY_PRIVATE_ARTIFACTS || null; }
function releaseSha(env) {
  const sha=String(env.ZEVANORY_RELEASE_SHA||"").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha)?sha:"";
}
function clientIp(request) { return String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "").split(",")[0].trim(); }
function userAgent(request) { return String(request.headers.get("user-agent") || "").slice(0,320); }
function cookie(request,name) {
  const raw=String(request.headers.get("cookie")||"");
  for(const part of raw.split(";")){const [k,...rest]=part.trim().split("="); if(k===name)return decodeURIComponent(rest.join("="));}
  return "";
}
async function sha256(value) {
  const data=new TextEncoder().encode(String(value));
  const digest=await crypto.subtle.digest("SHA-256",data);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function participant(request,env) {
  const existing=cookie(request,"zev_voice_study");
  const pid=/^[a-f0-9]{32,64}$/.test(existing)?existing:(await sha256(crypto.randomUUID())).slice(0,40);
  const salt=String(env.ELITE_INTERNAL_TOKEN || env.OPERATOR_TOKEN || env.META_APP_SECRET || "zevanory-voice-study-v1");
  const fingerprint=await sha256(salt+"|"+clientIp(request)+"|"+userAgent(request));
  return {pid,fingerprint};
}
function assignedClip(fingerprint) {
  const n=parseInt(String(fingerprint).slice(0,8),16);
  return Number.isFinite(n)?n%CORPUS.length:0;
}
function safeInt(v,min,max){const n=Number(v); return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
function safeBool(v){return v===true||v==="true"?true:v===false||v==="false"?false:null;}

async function listRatings(env) {
  const store=kv(env); if(!store?.list) return [];
  const sha=releaseSha(env); if(!sha) return [];
  const out=[]; let cursor=undefined;
  do {
    const page=await store.list({prefix:`voice-study/rating/${sha}/`,limit:1000,cursor});
    for(const key of page.keys||[]) {
      const item=await store.get(key.name,{type:"json"}).catch(()=>null);
      if(item) out.push(item);
    }
    cursor=page.list_complete?undefined:page.cursor;
  } while(cursor);
  return out;
}

function aggregate(ratings, sha) {
  const valid=ratings.filter(r=>r&&r.schema_version===1&&r.blinded===true&&r.human_attested===true&&r.release_sha===sha);
  const unique=new Set(valid.map(r=>r.fingerprint_hash));
  const clips=new Set(valid.map(r=>r.clip_id));
  const naturalAccept=valid.filter(r=>r.natural_acceptance===true).length;
  const intelligible=valid.filter(r=>r.intelligible===true).length;
  const mean=valid.length?valid.reduce((a,r)=>a+Number(r.naturalness_5||0),0)/valid.length:0;
  const naturalPct=valid.length?100*naturalAccept/valid.length:0;
  const intelligPct=valid.length?100*intelligible/valid.length:0;
  const certified=CORPUS.length>=20&&unique.size>=100&&clips.size>=20&&naturalPct>=99&&intelligPct>=99&&mean>=4.8;
  return {
    release_sha:sha||null,
    clips:CORPUS.length,
    clips_covered:clips.size,
    blind_ratings:valid.length,
    unique_evaluators:unique.size,
    blinded:true,
    real_tts_audio:true,
    pt_br:true,
    natural_acceptance_pct:Number(naturalPct.toFixed(3)),
    intelligibility_pct:Number(intelligPct.toFixed(3)),
    mean_naturalness_5:Number(mean.toFixed(3)),
    certified,
    requirements:{
      "clips>=20":CORPUS.length>=20,
      "clips_covered>=20":clips.size>=20,
      "unique_evaluators>=100":unique.size>=100,
      "blinded":true,
      "real_tts_audio":true,
      "pt_br":true,
      "natural_acceptance>=99":naturalPct>=99,
      "intelligibility>=99":intelligPct>=99,
      "mean_naturalness>=4.8":mean>=4.8
    }
  };
}

function pageHtml(session) {
  const escaped=session.text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avaliação cega de voz — ZEVANORY</title><style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.45;background:#0b0d10;color:#f4f5f6}main{background:#151922;border:1px solid #303746;border-radius:18px;padding:24px}h1{font-size:1.55rem}audio{width:100%;margin:16px 0}.card{background:#0f131a;padding:14px;border-radius:12px;margin:14px 0}.grid{display:grid;gap:14px}.scale{display:flex;gap:12px;flex-wrap:wrap}button{background:#fff;color:#111;border:0;border-radius:10px;padding:12px 18px;font-weight:700;cursor:pointer}label{display:block;margin:6px 0}small{color:#b9c0cc}.ok{color:#8de39c}.err{color:#ff9c9c}</style></head><body><main>
  <h1>Avaliação cega de voz em português do Brasil</h1><p>Ouça uma única amostra e avalie apenas o áudio. O provedor e o modelo ficam ocultos para evitar viés.</p>
  <div class="card"><strong>Frase de referência</strong><p>${escaped}</p><audio controls preload="none" src="/api/voice-study/sample?id=${session.clip_id}"></audio></div>
  <form id="f" class="grid">
    <div><strong>Naturalidade</strong><small> 1 = muito artificial; 5 = totalmente natural</small><div class="scale">${[1,2,3,4,5].map(n=>`<label><input required type="radio" name="naturalness_5" value="${n}"> ${n}</label>`).join("")}</div></div>
    <div><strong>Pronúncia pt-BR</strong><div class="scale">${[1,2,3,4,5].map(n=>`<label><input required type="radio" name="pronunciation_5" value="${n}"> ${n}</label>`).join("")}</div></div>
    <div><strong>Ritmo</strong><div class="scale">${[1,2,3,4,5].map(n=>`<label><input required type="radio" name="pace_5" value="${n}"> ${n}</label>`).join("")}</div></div>
    <div><strong>Você entendeu integralmente a frase?</strong><label><input required type="radio" name="intelligible" value="true"> Sim</label><label><input required type="radio" name="intelligible" value="false"> Não</label></div>
    <div><strong>Você aceitaria esta voz em um atendimento real?</strong><label><input required type="radio" name="natural_acceptance" value="true"> Sim</label><label><input required type="radio" name="natural_acceptance" value="false"> Não</label></div>
    <label><input required type="checkbox" name="human_attested"> Confirmo que sou uma pessoa e ouvi a amostra antes de responder.</label>
    <input type="hidden" name="clip_id" value="${session.clip_id}"><button>Enviar avaliação</button><div id="msg"></div>
  </form></main><script>
  document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.target);const body=Object.fromEntries(f.entries());body.human_attested=f.get('human_attested')==='on';body.intelligible=body.intelligible==='true';body.natural_acceptance=body.natural_acceptance==='true';for(const k of ['naturalness_5','pronunciation_5','pace_5'])body[k]=Number(body[k]);const m=document.getElementById('msg');m.textContent='Enviando...';const r=await fetch('/api/voice-study/rate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();m.className=r.ok?'ok':'err';m.textContent=r.ok?'Avaliação registrada. Obrigado.':(j.error||'Não foi possível registrar.');if(r.ok)e.target.querySelector('button').disabled=true;});
  </script></body></html>`;
}

export async function handleVoiceStudy(request,env={}) {
  const url=new URL(request.url);
  const {pid,fingerprint}=await participant(request,env);
  const sha=releaseSha(env);
  if(!sha) return json({error:"release_sha_unavailable"},503);
  const headers={"set-cookie":`zev_voice_study=${pid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`};
  if(url.pathname==="/voice-study") {
    const done=await kv(env)?.get?.(`voice-study/fingerprint/${sha}/${fingerprint}`).catch(()=>null);
    if(done) return html("<!doctype html><meta charset=utf-8><title>ZEVANORY</title><body style='font-family:system-ui;background:#0b0d10;color:#fff;padding:40px'><h1>Avaliação já registrada</h1><p>Obrigado por participar. Cada pessoa conta uma única vez nesta bateria.</p></body>",200,headers);
    const clip=assignedClip(fingerprint); return html(pageHtml({clip_id:clip,text:CORPUS[clip][1]}),200,headers);
  }
  if(url.pathname==="/api/voice-study/session") {
    const clip=assignedClip(fingerprint); return json({release_sha:sha,clip_id:clip,category:CORPUS[clip][0],text:CORPUS[clip][1],blinded:true},200,headers);
  }
  if(url.pathname==="/api/voice-study/sample") {
    const requested=safeInt(url.searchParams.get("id"),0,CORPUS.length-1); const assigned=assignedClip(fingerprint);
    if(requested===null||requested!==assigned) return json({error:"sample_not_assigned"},403,headers);
    const audio=await ttsBytesWithFailover(CORPUS[assigned][1],env,fetch);
    return new Response(audio.bytes,{status:200,headers:{...headers,"content-type":audio.mime||"audio/wav","cache-control":"private, no-store","content-length":String(audio.bytes.length),"x-content-type-options":"nosniff","x-voice-study-blinded":"true"}});
  }
  if(url.pathname==="/api/voice-study/rate") {
    if(request.method!=="POST") return json({error:"method_not_allowed"},405,headers);
    const store=kv(env); if(!store?.put) return json({error:"rating_storage_unavailable"},503,headers);
    const existing=await store.get(`voice-study/fingerprint/${sha}/${fingerprint}`).catch(()=>null);
    if(existing) return json({error:"duplicate_evaluator"},409,headers);
    const body=await request.json().catch(()=>null); if(!body) return json({error:"invalid_json"},400,headers);
    const clip=safeInt(body.clip_id,0,CORPUS.length-1);
    if(clip===null||clip!==assignedClip(fingerprint)) return json({error:"clip_assignment_mismatch"},409,headers);
    const naturalness=safeInt(body.naturalness_5,1,5), pronunciation=safeInt(body.pronunciation_5,1,5), pace=safeInt(body.pace_5,1,5);
    const intelligible=safeBool(body.intelligible), accept=safeBool(body.natural_acceptance);
    if([naturalness,pronunciation,pace,intelligible,accept].some(v=>v===null)||body.human_attested!==true) return json({error:"rating_invalid"},400,headers);
    const record={schema_version:1,release_sha:sha,blinded:true,human_attested:true,clip_id:clip,category:CORPUS[clip][0],participant_hash:await sha256(pid),fingerprint_hash:fingerprint,naturalness_5:naturalness,pronunciation_5:pronunciation,pace_5:pace,intelligible,natural_acceptance:accept,created_at:new Date().toISOString()};
    await store.put(`voice-study/rating/${sha}/${fingerprint}`,JSON.stringify(record));
    await store.put(`voice-study/fingerprint/${sha}/${fingerprint}`,record.created_at);
    return json({accepted:true,blinded:true},201,headers);
  }
  if(url.pathname==="/api/voice-study/status") {
    return json(await voiceStudyStatus(env));
  }
  return null;
}

export async function voiceStudyStatus(env={}) {
  const sha=releaseSha(env);
  const stats=aggregate(await listRatings(env),sha);
  return Object.freeze({schema_version:1,engine:"ZEVANORY Voice Support Engine",study:"human_blind_ptbr_naturality",provider_disclosed:false,...stats});
}

export { CORPUS };
