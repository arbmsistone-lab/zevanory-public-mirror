const clean=(v,max=5000)=>String(v??'').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const runtimeAi=()=>globalThis.__ZEVANORY_EDGE_AI__?.AI||null;
const extFor=(mime='')=>({
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
  'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/aac':'aac','video/mp4':'mp4','video/3gpp':'3gp'
}[String(mime).split(';')[0].toLowerCase()]||'bin');
const base64=(bytes)=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(s);};

async function fetchWhatsappMedia(item,env,fetchImpl=globalThis.fetch){
  const id=clean(item?.media_id,240),token=clean(env.WHATSAPP_ACCESS_TOKEN,5000),version=clean(env.META_GRAPH_VERSION||'v26.0',20);
  if(!id||!token)throw new Error('whatsapp_media_credentials_missing');
  const meta=await fetchImpl(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(id)}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
  if(!meta.ok)throw new Error(`whatsapp_media_meta_http_${meta.status}`);
  const info=await meta.json(),url=clean(info?.url,4000),mime=clean(info?.mime_type||item?.mime_type,120);
  if(!/^https:\/\//i.test(url))throw new Error('whatsapp_media_url_missing');
  const res=await fetchImpl(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw new Error(`whatsapp_media_download_http_${res.status}`);
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(!bytes.length||bytes.length>16*1024*1024)throw new Error('whatsapp_media_size_unsupported');
  return {bytes,mime:mime||String(res.headers?.get?.('content-type')||''),sha256:info?.sha256||null};
}

export async function understandWhatsappInbound(item,{env=process.env,fetchImpl=globalThis.fetch}={}){
  const type=String(item?.type||'text').toLowerCase(),caption=clean(item?.text||item?.caption,1800);
  if(!item?.media_id)return Object.freeze({...item,understanding:caption,understanding_mode:'text',understanding_confidence:1});
  const ai=runtimeAi();
  if(!ai)return Object.freeze({...item,understanding:caption||`Cliente enviou ${type}; an?lise multim?dia indispon?vel.`,understanding_mode:'media_pending',understanding_confidence:0});
  const {bytes,mime}=await fetchWhatsappMedia(item,env,fetchImpl);
  if(type==='audio'||String(mime).startsWith('audio/')){
    const result=await ai.run('@cf/openai/whisper',{audio:[...bytes],task:'transcribe',language:'pt'});
    const transcript=clean(result?.text||result?.transcription_info?.text,5000);
    if(!transcript)throw new Error('whatsapp_audio_transcription_empty');
    return Object.freeze({...item,understanding:[caption,`Transcri??o do ?udio: ${transcript}`].filter(Boolean).join(' | '),understanding_mode:'cloudflare_whisper',understanding_confidence:.99,mime_type:mime});
  }
  if(type==='image'||String(mime).startsWith('image/')){
    let data='';
    if(typeof ai.toMarkdown==='function'){
      const r=await ai.toMarkdown({name:`whatsapp.${extFor(mime)}`,blob:new Blob([bytes],{type:mime})},{conversionOptions:{image:{descriptionLanguage:'pt'},output:{format:'text'}}});
      data=clean(Array.isArray(r)?r[0]?.data:r?.data,5000);
    }
    if(!data){
      const result=await ai.run('@cf/meta/llama-3.2-11b-vision-instruct',{messages:[{role:'system',content:'Descreva a imagem objetivamente em portugu?s brasileiro, priorizando texto vis?vel, erro, produto, tela e contexto ?til para atendimento.'},{role:'user',content:'Analise esta imagem enviada por um cliente da ZEVANORY.'}],image:`data:${mime};base64,${base64(bytes)}`,max_tokens:500,temperature:.1});
      data=clean(result?.response,5000);
    }
    if(!data)throw new Error('whatsapp_image_understanding_empty');
    return Object.freeze({...item,understanding:[caption,`Descri??o da imagem: ${data}`].filter(Boolean).join(' | '),understanding_mode:'cloudflare_vision',understanding_confidence:.99,mime_type:mime});
  }
  if(type==='video'||String(mime).startsWith('video/')){
    try{
      const result=await ai.run('@cf/openai/whisper',{audio:[...bytes],task:'transcribe',language:'pt'});
      const transcript=clean(result?.text||result?.transcription_info?.text,5000);
      if(transcript)return Object.freeze({...item,understanding:[caption,`?udio do v?deo: ${transcript}`].filter(Boolean).join(' | '),understanding_mode:'video_audio_transcription',understanding_confidence:.99,mime_type:mime});
    }catch{}
    return Object.freeze({...item,understanding:caption||'Cliente enviou um v?deo que requer revis?o visual antes de responder.',understanding_mode:'video_requires_visual_review',understanding_confidence:caption?.length?0.7:0,mime_type:mime});
  }
  return Object.freeze({...item,understanding:caption||`Cliente enviou ${type}.`,understanding_mode:'media_metadata_only',understanding_confidence:caption?0.7:0,mime_type:mime});
}
