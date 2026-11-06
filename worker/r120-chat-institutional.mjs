// R120 / DEC-20. Institutional HTML augmentation, default OFF and no external chat SDK.
// Pure HTTP adapter; callers keep the original response when the switch is closed.
const HOST="zevanory.api.br";
const TURNSTILE="https://challenges.cloudflare.com";
const inject=(text)=>{
  if(/src=["']\/site-chat\.js["']/.test(text))return text;
  if(!/<\/head>/i.test(text)||!/<\/body>/i.test(text))return text;
  return text.replace(/<\/head>/i,'<link rel="stylesheet" href="/site-chat.css"></head>')
    .replace(/<\/body>/i,'<script src="/site-chat.js" defer></script></body>');
};
function extendCsp(value){
  let csp=String(value||"");
  if(!csp)return csp;
  for(const directive of ["script-src","frame-src","connect-src"]){
    const re=new RegExp("(^|;\\s*)("+directive+"\\s+)([^;]*)","i");
    if(re.test(csp)){
      csp=csp.replace(re,(all,prefix,lead,hosts)=>prefix+lead+(hosts.includes(TURNSTILE)?hosts:hosts+" "+TURNSTILE));
    } else csp+="; "+directive+" 'self' "+TURNSTILE;
  }
  return csp;
}
export async function injectInstitutionalChat(request,env,response){
  if(String(env?.SITE_CHAT_ENABLED||"").trim()!=="true")return response;
  const url=new URL(request.url);
  if(url.hostname!==HOST||request.method!=="GET"||url.pathname.startsWith("/api/"))return response;
  if(!response||response.status!==200||!/text\/html/i.test(response.headers.get("content-type")||""))return response;
  if(response.headers.get("content-encoding"))return response;
  const html=await response.text();
  const modified=inject(html);
  const headers=new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control","no-store");
  headers.set("vary","accept-encoding");
  if(headers.has("content-security-policy"))headers.set("content-security-policy",extendCsp(headers.get("content-security-policy")));
  return new Response(modified,{status:200,statusText:response.statusText,headers});
}
