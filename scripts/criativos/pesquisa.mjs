// Laboratório de Criativos — PESQUISA. A ZEVANORY descobre, com dados públicos reais do YouTube, quais Shorts em
// português do Brasil mais performam em cada tema dos kits (visualizações, curtidas e comentários por visualização,
// recência). Não copia conteúdo de terceiros: guarda só metadados e números como EVIDÊNCIA do padrão.
// Limite honesto: "mais vende" não é observável em vídeo de terceiros; o proxy é desempenho público. As vendas dos
// próprios Shorts (Hotmart src=youtube) entram depois, no ciclo de aprendizado.
export const TEMAS=Object.freeze({
 'ZEV-LCX-011':['controle de caixa pequena empresa','quanto sobra de lucro no negócio','margem de lucro loja'],
 'ZEV-VEN-011':['como vender mais pelo whatsapp','atendimento que vende','script de vendas pequeno negócio'],
 'ZEV-IA-011':['inteligência artificial para pequenos negócios','chatgpt para empreendedor','ia no atendimento'],
 'ZEV-CMB-011':['ia para vender mais','chatgpt vendas whatsapp','automatizar atendimento pequeno negócio'],
 'ZEV-NGC-011':['organizar finanças e vendas do negócio','gestão de pequeno negócio','empreendedor iniciante dicas']
});
const YT='https://www.googleapis.com/youtube/v3';
export async function youtubeToken({clientId,clientSecret,refreshToken},fetchImpl=fetch){
 if(!clientId||!clientSecret||!refreshToken)throw Error('pesquisa_youtube_credencial_ausente');
 const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000)});
 const j=await r.json().catch(()=>null);if(!r.ok||typeof j?.access_token!=='string')throw Error('pesquisa_youtube_token_falhou');return j.access_token;
}
const iso8601=s=>{const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s||''));return m?(+m[1]||0)*3600+(+m[2]||0)*60+(+m[3]||0):NaN;};
// Pontuação de desempenho: visualizações (log) + engajamento por visualização, penalizando vídeo antigo demais.
export function desempenho(v,now){const views=v.views,eng=(v.likes+3*v.comments)/Math.max(views,1),dias=Math.max(1,(now-Date.parse(v.publicado))/86400000);
 return Math.round((Math.log10(Math.max(views,1))*10+Math.min(eng,0.2)*200+Math.log10(views/dias+1)*5)*100)/100;}
export async function pesquisarTema({sku,consultas,token,now=Date.now(),fetchImpl=fetch,porConsulta=15}){
 const get=async path=>{const r=await fetchImpl(YT+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});if(r.status!==200)throw Error('pesquisa_youtube_http_'+r.status);return r.json();};
 const after=new Date(now-180*86400000).toISOString(),ids=new Set();
 for(const q of consultas){const p=new URLSearchParams({part:'id',type:'video',videoDuration:'short',regionCode:'BR',relevanceLanguage:'pt',order:'viewCount',publishedAfter:after,maxResults:String(porConsulta),q:q+' #shorts'});
  const j=await get('/search?'+p);for(const it of j.items||[])if(typeof it?.id?.videoId==='string')ids.add(it.id.videoId);}
 if(!ids.size)throw Error('pesquisa_sem_resultados:'+sku);
 const j=await get('/videos?'+new URLSearchParams({part:'snippet,statistics,contentDetails',id:[...ids].slice(0,50).join(',')}));
 const rows=(j.items||[]).map(v=>({id:v.id,titulo:String(v.snippet?.title||'').slice(0,140),canal:String(v.snippet?.channelTitle||'').slice(0,80),publicado:v.snippet?.publishedAt,
  segundos:iso8601(v.contentDetails?.duration),views:+v.statistics?.viewCount||0,likes:+v.statistics?.likeCount||0,comments:+v.statistics?.commentCount||0,
  descricao:String(v.snippet?.description||'').slice(0,300),thumb:v.snippet?.thumbnails?.high?.url||v.snippet?.thumbnails?.default?.url||null}))
  .filter(v=>Number.isFinite(v.segundos)&&v.segundos>0&&v.segundos<=180&&v.views>=1000&&Number.isFinite(Date.parse(v.publicado))&&Date.parse(v.publicado)>=Date.parse(after)&&Date.parse(v.publicado)<=now);
 for(const v of rows)v.score=desempenho(v,now);
 // NC-05: duração curta não prova que é Short. Confirma no próprio YouTube: /shorts/<id> responde 200 sem
 // redirecionar para /watch. Não confirmado = fora da evidência.
 const out=[];
 for(const v of rows.sort((a,b)=>b.score-a.score)){if(out.length>=12)break;if(await confirmarShort(v.id,fetchImpl))out.push({sku,...v,confirmado_short:true,url:'https://www.youtube.com/shorts/'+v.id});}
 return out;
}
export async function confirmarShort(id,fetchImpl=fetch){
 if(!/^[A-Za-z0-9_-]{11}$/.test(id))return false;
 try{const r=await fetchImpl('https://www.youtube.com/shorts/'+id,{method:'GET',redirect:'manual',headers:{'user-agent':'Mozilla/5.0','accept-language':'pt-BR'},signal:AbortSignal.timeout(15000)});return r.status===200;}catch{return false;}
}
// NC-01: dos metadados só se conclui o que eles mostram. Fatos calculados por CÓDIGO (nunca pela IA), cada um com
// os vídeos que o sustentam. Nada sobre visual, ritmo de edição ou legibilidade: isso não está nos metadados.
const mediana=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)/2)]:NaN;};
export function padroesDeMetadados(evidencia){
 if(!Array.isArray(evidencia)||evidencia.length<5)throw Error('pesquisa_evidencia_insuficiente');
 const top=[...evidencia].sort((a,b)=>b.score-a.score).slice(0,Math.max(5,Math.ceil(evidencia.length/2)));
 const fato=(id,padrao,valor,apoio)=>({criterio:'metadados',fato:id,padrao,valor,evidencias:apoio.map(v=>v.id).slice(0,12)});
 const pergunta=top.filter(v=>/\?/.test(v.titulo)),numero=top.filter(v=>/\d|R\$/.test(v.titulo)),dur=mediana(top.map(v=>v.segundos)),pal=mediana(top.map(v=>v.titulo.split(/\s+/).filter(Boolean).length));
 const eng=mediana(top.map(v=>(v.likes+3*v.comments)/Math.max(1,v.views)));
 const out=[fato('duracao_mediana_s',`Duração mediana dos Shorts de melhor desempenho: ${dur} s.`,dur,top),
  fato('palavras_titulo_mediana',`Título mediano com ${pal} palavras.`,pal,top),
  fato('engajamento_mediano',`Engajamento mediano (curtidas + 3×comentários por visualização): ${(eng*100).toFixed(2)}%.`,Math.round(eng*10000)/10000,top)];
 if(pergunta.length>=3)out.push(fato('titulo_pergunta_pct',`${Math.round(pergunta.length/top.length*100)}% dos títulos de melhor desempenho são perguntas.`,Math.round(pergunta.length/top.length*100),pergunta));
 if(numero.length>=3)out.push(fato('titulo_numero_pct',`${Math.round(numero.length/top.length*100)}% dos títulos de melhor desempenho trazem número ou valor.`,Math.round(numero.length/top.length*100),numero));
 return out;
}
