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
  .filter(v=>Number.isFinite(v.segundos)&&v.segundos>0&&v.segundos<=180&&v.views>=1000&&Number.isFinite(Date.parse(v.publicado)));
 for(const v of rows)v.score=desempenho(v,now);
 return rows.sort((a,b)=>b.score-a.score).slice(0,12).map(v=>({sku,...v,url:'https://www.youtube.com/shorts/'+v.id}));
}
