// Signed internal GET probes only. Does not bypass or alter Cloudflare WAF.
import { operatorCredentialCandidates, recordOperatorAuth } from "./operator-credential.mjs";
export const AUDIT_READ_PATHS=Object.freeze(new Set([
  "/api/status","/api/health","/api/provider-health","/api/control-plane",
  "/api/internal/audit/financial-classification","/api/internal/audit/runtime-identity",
  "/api/internal/audit/credential-identity",
  "/api/internal/watch/paid-delivery",
  "/api/sales/status"
]));
// Categoria aceita ("" = recusa). Dentro da janela de migração da credencial de operador a assinatura vale com qualquer
// candidato de operator-credential.mjs (todos são testados, sem atalho); fora dela, só com a credencial de sempre.
export async function signedAuditProbeCategory(request, env, {now=Date.now()}={}){
  const url=new URL(request.url);
  if(request.method!=="GET"||!AUDIT_READ_PATHS.has(url.pathname))return "";
  const ts=String(request.headers.get("x-zevanory-audit-ts")||"");
  const sig=String(request.headers.get("x-zevanory-audit-signature")||"").toLowerCase();
  if(!/^[0-9]{10}$/.test(ts)||!/^[0-9a-f]{64}$/.test(sig))return "";
  const when=Number(ts)*1000;
  if(!Number.isFinite(when)||Math.abs(now-when)>300000)return "";
  const msg=new TextEncoder().encode("GET\n"+url.pathname+"\n"+ts);
  const bytes=Uint8Array.from(sig.match(/../g),s=>parseInt(s,16));
  let hit="";
  for(const c of operatorCredentialCandidates(env,{now})){
    if(c.token.length<32)continue;
    try{
      const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(c.token),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
      if(await crypto.subtle.verify("HMAC",key,bytes,msg)&&!hit)hit=c.category;
    }catch{}
  }
  recordOperatorAuth(hit||"none");
  return hit;
}
export async function verifySignedAuditProbe(request, env, opts={}){
  return Boolean(await signedAuditProbeCategory(request, env, opts));
}
