const clean=(v,max=4000)=>String(v||'').trim().slice(0,max);
export function httpsMediaUrl(value,code='media_url_invalid'){
  const raw=clean(value);let url;try{url=new URL(raw);}catch{throw new Error(code);}
  if(url.protocol!=='https:')throw new Error(code);return url.toString();
}
export async function fetchRemoteMedia({url,fetchImpl=globalThis.fetch,maxBytes=25*1024*1024,acceptedTypes=[]}={}){
  const mediaUrl=httpsMediaUrl(url);const response=await fetchImpl(mediaUrl,{method:'GET',redirect:'follow'});
  if(!response.ok)throw new Error(`remote_media_http_${response.status}`);
  const type=clean(response.headers?.get?.('content-type'),120).split(';')[0].toLowerCase();
  if(acceptedTypes.length&&!acceptedTypes.some(prefix=>type.startsWith(prefix)))throw new Error('remote_media_type_invalid');
  const declared=Number(response.headers?.get?.('content-length'));if(Number.isFinite(declared)&&declared>maxBytes)throw new Error('remote_media_too_large');
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>maxBytes)throw new Error('remote_media_size_invalid');
  return Object.freeze({url:mediaUrl,type,size:bytes.length,bytes});
}
