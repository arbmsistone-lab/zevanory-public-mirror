// A2/A3: one fail-closed policy applied before all checkout handlers.
export const REQUIRED = Object.freeze(["global","pre_sale","absolute","checkout","financial","kv","preflight","environment","token"]);
export function isCheckoutRoute(path){
  return /^\/(?:api\/checkout(?:\/|$)|checkout(?:\/|$)|comprar(?:\/|$)|api\/payments?\/checkout(?:\/|$))/.test(String(path||"").toLowerCase());
}
export function allowCheckout(flags){
  return REQUIRED.every(k=>flags?.[k]===true);
}
export function isProductionPilotBlocked(env){
  return String(env?.MERCADOPAGO_ENV||"").toLowerCase()==="production"&&
    String(env?.CERTIFICATION_PILOT_PRODUCTION_ALLOWED||"").toLowerCase()!=="true";
}
const toSha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value))))).map(v=>v.toString(16).padStart(2,"0")).join("");
let tokenCache={key:"",at:0,valid:false};
export async function verifyProductionToken(env,{fetcher=fetch,now=Date.now()}={}){
  const token=String(env?.MERCADOPAGO_ACCESS_TOKEN||"").trim();
  const expected=String(env?.MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16||"").toLowerCase().trim();
  if(token.length<32||token.startsWith("TEST-")||!/^[a-f0-9]{16}$/.test(expected))return false;
  const key=await toSha(token+"|"+expected);
  if(tokenCache.key===key&&now-tokenCache.at<120000)return tokenCache.valid;
  let valid=false;
  try{
    const r=await fetcher("https://api.mercadopago.com/users/me",{method:"GET",headers:{Authorization:"Bearer "+token,Accept:"application/json"},signal:AbortSignal.timeout(5000)});
    if(r.status===200){
      const j=await r.json();
      valid=j?.site_id==="MLB"&&Array.isArray(j?.tags)&&!j.tags.includes("test_user")&&
        /^\d+$/.test(String(j?.id||""))&&(await toSha(String(j.id))).slice(0,16)===expected;
    }
  }catch{}
  tokenCache={key,at:now,valid};
  return valid;
}
export async function evaluateCheckout(env,sw,{verify=verifyProductionToken,now=Date.now()}={}){
  let pre=null;
  try{pre=JSON.parse(String(await env?.ZEVANORY_PRIVATE_ARTIFACTS?.get("zpc-sales-preflight:v1")||"null"));}catch{}
  const timestamp=Date.parse(String(pre?.at||""));
  const flags={
    global:(String(env?.SALE_GLOBALLY_ENABLED||"").toLowerCase()==="true" || sw?.authorized===true) && sw?.enabled===true,
    pre_sale:String(env?.PRE_SALE_GATES_APPROVED||"").toLowerCase()==="true",
    absolute:String(env?.ABSOLUTE_RELEASE_APPROVED||"").toLowerCase()==="true",
    checkout:String(env?.CHECKOUT_ENABLED||"").toLowerCase()==="true",
    financial:String(env?.FINANCIAL_EVENTS_ENABLED||"").toLowerCase()==="true",
    kv:sw?.enabled===true,
    preflight:pre?.ok===true&&Number.isFinite(timestamp)&&timestamp<=now&&now-timestamp<3*3600000,
    environment:String(env?.MERCADOPAGO_ENV||"").toLowerCase()==="production",
    token:false
  };
  if(REQUIRED.filter(k=>k!=="token").every(k=>flags[k]))flags.token=await verify(env);
  return {allowed:allowCheckout(flags),flags};
}
export function denyCheckout(reason="commercial_checkout_closed"){
  return new Response(JSON.stringify({error:reason}),{status:503,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
export async function requiresPilotDenial(request,env){
  if(!isProductionPilotBlocked(env))return false;
  const pathname=new URL(request.url).pathname;
  if(request.method!=="GET"&&request.method!=="HEAD"&&pathname.startsWith("/api/internal/certification/"))return true;
  if(pathname==="/api/events/operator"&&request.method==="POST"){
    try{
      const body=await request.clone().json();
      return String(body?.name||"")==="certification_pilot_invite_create";
    }catch{return true;}
  }
  return false;
}
