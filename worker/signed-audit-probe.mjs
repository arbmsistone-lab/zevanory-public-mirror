// Signed internal GET probes only. Does not bypass or alter Cloudflare WAF.
export const AUDIT_READ_PATHS=Object.freeze(new Set([
  "/api/status","/api/health","/api/provider-health","/api/control-plane",
  "/api/internal/audit/financial-classification","/api/internal/audit/runtime-identity"
]));
export async function verifySignedAuditProbe(request, env, {now=Date.now()}={}){
  const url=new URL(request.url);
  if(request.method!=="GET"||!AUDIT_READ_PATHS.has(url.pathname))return false;
  const secret=String(env?.CERTIFICATION_E2E_TOKEN||"");
  const ts=String(request.headers.get("x-zevanory-audit-ts")||"");
  const sig=String(request.headers.get("x-zevanory-audit-signature")||"").toLowerCase();
  if(secret.length<32||!/^[0-9]{10}$/.test(ts)||!/^[0-9a-f]{64}$/.test(sig))return false;
  const when=Number(ts)*1000;
  if(!Number.isFinite(when)||Math.abs(now-when)>300000)return false;
  const msg="GET\n"+url.pathname+"\n"+ts;
  try{
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const bytes=Uint8Array.from(sig.match(/../g),s=>parseInt(s,16));
    return await crypto.subtle.verify("HMAC",key,bytes,new TextEncoder().encode(msg));
  }catch{return false;}
}
