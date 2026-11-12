import {gunzipSync} from 'node:zlib';
// Public catalogs are data, never instructions. Exact hosts/prefixes, bounded bytes,
// literal licence on the same source page, and no redirects to unknown hosts.
const HOSTS=new Set(['freepd.com','www.freepd.com','web.archive.org','a.ocv.me']);
export function trustedSource(url){try{const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&HOSTS.has(u.hostname)&&(u.hostname!=='web.archive.org'||/^\/web\/\d+(?:id_)?\/https:\/\/freepd\.com\//.test(u.pathname))&&(u.hostname!=='a.ocv.me'||u.pathname.startsWith('/pub/stuff/music/freepd/'));}catch{return false;}}
export async function boundedFetch(url,{fetchImpl=fetch,maxBytes=12000000}={}){
 if(!trustedSource(url))throw Error('music_source_not_allowlisted');const r=await fetchImpl(url,{redirect:'follow',signal:AbortSignal.timeout(20000)});if(!r.ok||r.url&&!trustedSource(r.url)||Number(r.headers?.get('content-length')||0)>maxBytes)throw Error('music_source_unavailable');
 if(!r.body?.getReader){const b=new Uint8Array(await r.arrayBuffer());if(b.length>maxBytes)throw Error('music_source_too_large');return b;}
 const reader=r.body.getReader(),chunks=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw Error('music_source_too_large');}chunks.push(value);}const bytes=new Uint8Array(size);let cursor=0;for(const chunk of chunks){bytes.set(chunk,cursor);cursor+=chunk.length;}return bytes;
}
const plain=s=>String(s).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
export function parseFreePD(source,page,category){
 if(!trustedSource(page)||!/(Creative Commons 0|CC0|Public Domain Dedication)/i.test(plain(source)))return [];
 const result=[];for(const row of source.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[]){const title=plain(/<b>([\s\S]*?)<\/b>/i.exec(row)?.[1]||''),description=plain(row),author=/Written by (.*?)\./i.exec(description)?.[1]?.trim();if(!title||title.length>100||!author||/[\/\\]/.test(title))continue;result.push({titulo:title,autor:author,descricao_original:description.slice(0,2500),licenca:'CC0-1.0',pagina_licenca:page+'#:~:text='+encodeURIComponent(title),evidencia_licenca:plain(source).match(/Creative Commons 0|CC0|Public Domain Dedication/i)[0],fonte:'https://a.ocv.me/pub/stuff/music/freepd/'+category+'/'+encodeURIComponent(title+'.mp3'),temas_permitidos:category==='electronic'?['ia']:category==='upbeat'?['vendas','financas','dicas']:['dicas'],verificado_em:null});}return result;
}
export async function discoverFreePD({fetchImpl=fetch,max=12}={}){
 const rows=[],warnings=[];for(const [page,category] of [['electronic.php','electronic'],['upbeat.php','upbeat'],['misc.php','chill']]){
  let parsed=[];for(const url of ['https://freepd.com/'+page,'https://web.archive.org/web/20241217205507id_/https://freepd.com/'+page]){try{const bytes=await boundedFetch(url,{fetchImpl,maxBytes:500000});parsed=parseFreePD(new TextDecoder().decode(bytes[0]===31&&bytes[1]===139?gunzipSync(bytes,{maxOutputLength:500000}):bytes),url,category);if(parsed.length)break;}catch{warnings.push('catalogo_indisponivel:'+page);}}
  rows.push(...parsed);if(rows.length>=max*5)break;
 }return {candidates:rows.slice(0,Math.min(60,max*5)),warnings};
}
