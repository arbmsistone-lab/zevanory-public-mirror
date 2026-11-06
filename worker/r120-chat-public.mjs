// R120 DEC-20: only zevanory.api.br serves the canonical public chat API.
// The sales origin retains its existing same-origin proxy, preventing a second stateful backend.
import {handleSiteChat} from "./site-chat.mjs";
export const CHAT_ALLOWED_ORIGINS=Object.freeze(["https://zevanory.api.br","https://vendas.zevanory.api.br"]);
const CHAT_PATHS=new Set(["/api/chat","/api/chat/status","/api/chat/session","/api/chat/handoff"]);
const json=(status,error,extra={})=>new Response(JSON.stringify({error}),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","vary":"origin",...extra}});
export async function handleR120PublicChat(request,env={},deps={}){
 const url=new URL(request.url);
 if(url.hostname!=="zevanory.api.br"||!CHAT_PATHS.has(url.pathname))return null;
 const origin=request.headers.get("origin")||"";
 if(request.method==="OPTIONS"){
   if(!CHAT_ALLOWED_ORIGINS.includes(origin))return json(403,"origin_not_allowed");
   const headers={"access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type","access-control-max-age":"600","vary":"origin"};
   if(origin==="https://zevanory.api.br")headers["access-control-allow-origin"]="https://zevanory.api.br";
   if(origin==="https://vendas.zevanory.api.br")headers["access-control-allow-origin"]="https://vendas.zevanory.api.br";
   return new Response(null,{status:204,headers});
 }
 const status=url.pathname==="/api/chat/status";
 if(status?request.method!=="GET":request.method!=="POST")return json(405,"method_not_allowed");
 if(!status && !CHAT_ALLOWED_ORIGINS.includes(origin))return json(403,"origin_not_allowed");
 if(!status && !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type")||""))return json(415,"json_required");
 if(Number(request.headers.get("content-length")||0)>4096)return json(413,"too_large");
 // Same handlers, database, audit and sales authority as the existing internal API.
 const headers=new Headers(request.headers);
 headers.delete("x-zev-client-ip");
 headers.set("x-zev-client-ip",request.headers.get("cf-connecting-ip")||"");
 const internal=new Request("https://chat.internal"+url.pathname+url.search,{method:request.method,headers,body:request.method==="GET"?undefined:request.body,duplex:request.method==="GET"?undefined:"half"});
 const res=await handleSiteChat(internal,env,deps);
 if(!res)return json(503,"chat_unavailable");
 const responseHeaders=new Headers(res.headers);
 responseHeaders.set("vary","origin");
 responseHeaders.set("cache-control","no-store");
 if(origin==="https://zevanory.api.br")responseHeaders.set("access-control-allow-origin","https://zevanory.api.br");
 if(origin==="https://vendas.zevanory.api.br")responseHeaders.set("access-control-allow-origin","https://vendas.zevanory.api.br");
 return new Response(res.body,{status:res.status,statusText:res.statusText,headers:responseHeaders});
}
