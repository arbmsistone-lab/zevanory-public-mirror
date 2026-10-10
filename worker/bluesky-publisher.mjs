// Official AT Protocol XRPC posting; credentials are Worker environment bindings only.
// Same rkey on every retry prevents a timeout from duplicating a published record.
const clean=v=>String(v??"").trim();
export const BLUESKY_SECRETS=Object.freeze(["BLUESKY_HANDLE","BLUESKY_APP_PASSWORD"]);
export const blueskyReady=env=>BLUESKY_SECRETS.every(k=>Boolean(clean(env?.[k])));
export const graphemeCount=s=>[...new Intl.Segmenter("pt-BR",{granularity:"grapheme"}).segment(String(s))].length;
const textPart=(v,n)=>[...new Intl.Segmenter("pt-BR",{granularity:"grapheme"}).segment(clean(v))].slice(0,n).map(x=>x.segment).join("");
export function blueskyPostText({title,hook,value,cta,productUrl,day}){
 const u=new URL(productUrl);
 if(u.protocol!=="https:"||u.hostname!=="vendas.zevanory.api.br"||!/^\/comprar\/ZEV-[A-Z0-9-]+$/.test(u.pathname))throw new Error("bluesky_product_link_invalid");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("bluesky_day_invalid");
 u.searchParams.set("utm_source","bluesky");u.searchParams.set("utm_medium","organic");u.searchParams.set("utm_campaign","conteudo_"+day.replace(/-/g,""));
 const link=u.toString();
 const fixed="\n\n"+link;
 const remaining=300-graphemeCount(fixed);
 if(remaining<40)throw new Error("bluesky_link_too_long");
 const candidate=[textPart(hook||title,95),textPart(value||"Uma ideia prática para organizar sua rotina com revisão humana.",115),textPart(cta||"Veja o guia digital:",35)].filter(Boolean).join("\n");
 const text=textPart(candidate,remaining)+fixed;
 if(graphemeCount(text)>300)throw new Error("bluesky_grapheme_limit");
 return {text,link};
}
const retryable=(status)=>status===429||(status>=500&&status<=599);
async function retryXrpc({fetchImpl,url,body,token,retries=2,sleepImpl=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 for(let attempt=0;attempt<=retries;attempt++){
  try{
   const res=await fetchImpl(url,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
   if(!res.ok){
    if(!retryable(res.status)||attempt>=retries)throw new Error("bluesky_http_"+res.status);
    const after=Number(res.headers?.get?.("retry-after"));
    await sleepImpl(Number.isFinite(after)&&after>0?Math.min(5000,after*1000):250*2**attempt);
    continue;
   }
   return await res.json();
  }catch(error){
   const timeout=error?.name==="TimeoutError"||error?.name==="AbortError";
   if(!timeout||attempt>=retries)throw error;
   await sleepImpl(250*2**attempt);
  }
 }
 throw new Error("bluesky_retry_exhausted");
}
export async function publishBluesky({env={},title,hook,value,cta,productUrl,day,topic="daily",fetchImpl=fetch,sleepImpl}={}){
 if(!blueskyReady(env))return {status:"aguardando credencial"};
 const endpoint="https://bsky.social/xrpc/";
 const request=(method,body,token)=>retryXrpc({fetchImpl,url:endpoint+method,body,token,sleepImpl});
 const session=await request("com.atproto.server.createSession",{identifier:clean(env.BLUESKY_HANDLE),password:clean(env.BLUESKY_APP_PASSWORD)});
 if(!session?.did||!session?.accessJwt)throw new Error("bluesky_session_invalid");
 const {text,link}=blueskyPostText({title,hook,value,cta,productUrl,day});
 const start=text.indexOf(link),byteStart=new TextEncoder().encode(text.slice(0,start)).length,byteEnd=byteStart+new TextEncoder().encode(link).length;
 const rkey="zev-"+day.replaceAll("-","")+"-"+clean(topic).toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,24);
 const record={$type:"app.bsky.feed.post",text,createdAt:new Date().toISOString(),facets:[{index:{byteStart,byteEnd},features:[{$type:"app.bsky.richtext.facet#link",uri:link}]}],embed:{$type:"app.bsky.embed.external",external:{uri:link,title:textPart(title||hook,95),description:textPart(value||"Guia digital ZEVANORY",100)}}};
 const posted=await request("com.atproto.repo.createRecord",{repo:session.did,collection:"app.bsky.feed.post",rkey,record},session.accessJwt);
 if(!posted?.uri||!posted?.cid)throw new Error("bluesky_receipt_missing");
 if(posted.uri!=="at://"+session.did+"/app.bsky.feed.post/"+rkey)throw new Error("bluesky_receipt_mismatch");
 return {status:"publicado",provider_post_id:rkey,uri:posted.uri,cid:posted.cid,url:"https://bsky.app/profile/"+encodeURIComponent(session.did)+"/post/"+encodeURIComponent(rkey),landing_url:link,graphemes:graphemeCount(text)};
}
