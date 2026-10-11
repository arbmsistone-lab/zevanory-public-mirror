// Official AT Protocol XRPC posting; credentials are Worker environment bindings only.
// Same rkey on every retry prevents a timeout from duplicating a published record.
const clean=v=>String(v??"").trim();
export const BLUESKY_SECRETS=Object.freeze(["BLUESKY_HANDLE","BLUESKY_APP_PASSWORD"]);
export const blueskyReady=env=>BLUESKY_SECRETS.every(k=>Boolean(clean(env?.[k])));
export const graphemeCount=s=>[...new Intl.Segmenter("pt-BR",{granularity:"grapheme"}).segment(String(s))].length;
const textPart=(v,n)=>[...new Intl.Segmenter("pt-BR",{granularity:"grapheme"}).segment(clean(v))].slice(0,n).map(x=>x.segment).join("");
// Discovery tags: Bluesky search/feeds index hashtag facets, so every daily post is
// reachable by people browsing these topics, not only by our followers.
export const BLUESKY_TAGS=Object.freeze(["empreendedorismo","pequenosnegocios","ia"]);
export function blueskyPostText({title,hook,value,cta,productUrl,day}){
 const u=new URL(productUrl);
 if(u.protocol!=="https:"||u.hostname!=="vendas.zevanory.api.br"||!/^\/comprar\/ZEV-[A-Z0-9-]+$/.test(u.pathname))throw new Error("bluesky_product_link_invalid");
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("bluesky_day_invalid");
 u.searchParams.set("utm_source","bluesky");u.searchParams.set("utm_medium","organic");u.searchParams.set("utm_campaign","conteudo_"+day.replace(/-/g,""));
 const link=u.toString();
 const tagsLine=BLUESKY_TAGS.map(t=>"#"+t).join(" ");
 const fixed="\n\n"+tagsLine+"\n"+link;
 const remaining=300-graphemeCount(fixed);
 if(remaining<40)throw new Error("bluesky_link_too_long");
 const hookPart=textPart(hook||title,Math.min(65,Math.max(0,remaining-45)));
 const ctaPart=textPart(cta||"Veja o guia digital:",28);
 const valueBudget=Math.max(0,remaining-graphemeCount(hookPart)-graphemeCount(ctaPart)-2);
 const valuePart=textPart(value||"Uma ideia prática para organizar sua rotina com revisão humana.",valueBudget);
 const candidate=[hookPart,valuePart,ctaPart].filter(Boolean).join("\n");
 const text=textPart(candidate,remaining)+fixed;
 if(graphemeCount(text)>300)throw new Error("bluesky_grapheme_limit");
 return {text,link,tags:[...BLUESKY_TAGS]};
}
export function blueskyFacets(text,link,tags=BLUESKY_TAGS){
 const enc=new TextEncoder(),bytes=s=>enc.encode(s).length,facets=[];
 const start=text.lastIndexOf(link);
 if(start>=0){const byteStart=bytes(text.slice(0,start));facets.push({index:{byteStart,byteEnd:byteStart+bytes(link)},features:[{$type:"app.bsky.richtext.facet#link",uri:link}]});}
 for(const tag of tags){const token="#"+tag,at=text.lastIndexOf(token);if(at<0)continue;const byteStart=bytes(text.slice(0,at));facets.push({index:{byteStart,byteEnd:byteStart+bytes(token)},features:[{$type:"app.bsky.richtext.facet#tag",tag}]});}
 return facets.sort((a,b)=>a.index.byteStart-b.index.byteStart);
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
// app.bsky.feed.post declares record key type "tid": a free-form rkey such as
// "zev-20261010-zev-ia-011" is rejected by the PDS. The TID is derived from the
// day's scheduled slot (19:00 America/Sao_Paulo) and the topic, so every retry of
// the same daily post reuses the same record key and can never duplicate it.
const TID_ALPHABET="234567abcdefghijklmnopqrstuvwxyz";
const fnv1a=s=>{let h=0x811c9dc5;for(const c of String(s)){h^=c.codePointAt(0);h=Math.imul(h,0x01000193)>>>0;}return h>>>0;};
export function deterministicTid(day,topic="daily"){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day)))throw new Error("bluesky_day_invalid");
 const ms=Date.parse(day+"T22:00:00Z");if(!Number.isFinite(ms))throw new Error("bluesky_day_invalid");
 const h=fnv1a(clean(topic).toLowerCase());
 const micros=BigInt(ms)*1000n+BigInt(h%1000);
 let v=(micros<<10n)|BigInt(h%1024),out="";
 for(let i=0;i<13;i++){out=TID_ALPHABET[Number(v&31n)]+out;v>>=5n;}
 return out;
}
export const isTid=v=>/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(String(v));
async function existingRecord({fetchImpl,did,rkey,token}){
 // Idempotency readback: an ambiguous earlier attempt may already have created the post.
 const u=new URL("https://bsky.social/xrpc/com.atproto.repo.getRecord");
 u.searchParams.set("repo",did);u.searchParams.set("collection","app.bsky.feed.post");u.searchParams.set("rkey",rkey);
 try{const r=await fetchImpl(u.toString(),{method:"GET",headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(15000)});if(!r.ok)return null;const j=await r.json();return j?.uri&&j?.cid?j:null;}catch{return null;}
}
export async function publishBluesky({env={},title,hook,value,cta,productUrl,day,topic="daily",fetchImpl=fetch,sleepImpl}={}){
 if(!blueskyReady(env))return {status:"aguardando credencial"};
 const endpoint="https://bsky.social/xrpc/";
 const request=(method,body,token)=>retryXrpc({fetchImpl,url:endpoint+method,body,token,sleepImpl});
 const session=await request("com.atproto.server.createSession",{identifier:clean(env.BLUESKY_HANDLE),password:clean(env.BLUESKY_APP_PASSWORD)});
 if(!session?.did||!session?.accessJwt)throw new Error("bluesky_session_invalid");
 const {text,link,tags}=blueskyPostText({title,hook,value,cta,productUrl,day});
 const rkey=deterministicTid(day,topic);
 const expectedUri="at://"+session.did+"/app.bsky.feed.post/"+rkey;
 const receiptFor=posted=>({status:"publicado",provider_post_id:rkey,uri:posted.uri,cid:posted.cid,url:"https://bsky.app/profile/"+encodeURIComponent(session.did)+"/post/"+encodeURIComponent(rkey),landing_url:link,graphemes:graphemeCount(text)});
 const record={$type:"app.bsky.feed.post",text,langs:["pt"],createdAt:new Date().toISOString(),facets:blueskyFacets(text,link,tags),embed:{$type:"app.bsky.embed.external",external:{uri:link,title:textPart(title||hook,95),description:textPart(value||"Guia digital ZEVANORY",100)}}};
 let posted;
 try{posted=await request("com.atproto.repo.createRecord",{repo:session.did,collection:"app.bsky.feed.post",rkey,record},session.accessJwt);}
 catch(error){
  // A conflicting rkey means the deterministic daily post already exists: adopt it.
  if(/^bluesky_http_(400|409)$/.test(error?.message||"")){
   const found=await existingRecord({fetchImpl,did:session.did,rkey,token:session.accessJwt});
   if(found?.uri===expectedUri)return {...receiptFor(found),adopted:true};
  }
  throw error;
 }
 if(!posted?.uri||!posted?.cid)throw new Error("bluesky_receipt_missing");
 if(posted.uri!==expectedUri)throw new Error("bluesky_receipt_mismatch");
 return receiptFor(posted);
}
