// AT Protocol public posting. No unsolicited DMs; fail closed on missing credentials.
const trim = v => String(v ?? "").trim();
export const BLUESKY_SECRETS = Object.freeze(["BLUESKY_HANDLE","BLUESKY_APP_PASSWORD"]);
export const blueskyReady = env => BLUESKY_SECRETS.every(k => Boolean(trim(env?.[k])));
export function blueskyPostText({title,productUrl,day}) {
  const url=new URL(productUrl);
  if(url.protocol!=="https:" || url.hostname!=="vendas.zevanory.api.br" || !url.pathname.startsWith("/comprar/")) throw new Error("bluesky_product_link_invalid");
  url.searchParams.set("utm_source","bluesky");
  url.searchParams.set("utm_medium","organic");
  url.searchParams.set("utm_campaign","conteudo_"+day.replace(/-/g,""));
  const link=url.toString();
  const prefix=trim(title).slice(0,150);
  return {text:prefix+"\n\n"+link,link};
}
export async function publishBluesky({env={},title,productUrl,day,fetchImpl=fetch}) {
  if(!blueskyReady(env)) return {status:"aguardando credencial"};
  const endpoint="https://bsky.social/xrpc/";
  const call=async (name,body,token) => {
    const response=await fetchImpl(endpoint+name,{method:"POST",headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error("bluesky_"+name.split(".").pop()+"_http_"+response.status);
    return response.json();
  };
  const session=await call("com.atproto.server.createSession",{identifier:trim(env.BLUESKY_HANDLE),password:trim(env.BLUESKY_APP_PASSWORD)});
  if(!session.did || !session.accessJwt) throw new Error("bluesky_session_invalid");
  const {text,link}=blueskyPostText({title,productUrl,day});
  const start=text.indexOf(link);
  const byteStart=new TextEncoder().encode(text.slice(0,start)).length;
  const byteEnd=byteStart+new TextEncoder().encode(link).length;
  const record={$type:"app.bsky.feed.post",text,createdAt:new Date().toISOString(),facets:[{index:{byteStart,byteEnd},features:[{$type:"app.bsky.richtext.facet#link",uri:link}]}],embed:{$type:"app.bsky.embed.external",external:{uri:link,title:trim(title).slice(0,120),description:"Guia digital ZEVANORY para pequenos negócios."}}};
  const posted=await call("com.atproto.repo.createRecord",{repo:session.did,collection:"app.bsky.feed.post",record},session.accessJwt);
  if(!posted.uri || !posted.cid) throw new Error("bluesky_receipt_missing");
  const rkey=posted.uri.split("/").pop();
  return {status:"publicado",provider_post_id:rkey,uri:posted.uri,cid:posted.cid,url:"https://bsky.app/profile/"+session.did+"/post/"+encodeURIComponent(rkey),landing_url:link};
}
