// Dedicated certification perimeter. The commerce implementation is the SAME
// SHA-pinned canonical runtime imported below, not a fork of payment logic.
// Workers.dev exposes only authenticated sandbox proof endpoints, never a shop.
import canonical from "./worker/cloudflare-worker.compat.mjs";
const prefix="/api/internal/certification/";
const allowed=new Set([
 "/api/internal/certification/e2e/status",
 "/api/internal/certification/e2e/checkout",
 "/api/internal/certification/e2e/reconcile",
 "/api/internal/certification/e2e/download",
 "/api/internal/certification/e2e/post-sale",
 "/api/internal/certification/e2e/refund-approve",
 "/api/internal/certification/inbox/profile",
 "/api/internal/certification/inbox/messages",
 "/api/support/refund-request",
 "/api/webhooks"
]);
const reply=(status,error)=>new Response(JSON.stringify({error}),{
 status,headers:{"content-type":"application/json","cache-control":"no-store","x-robots-tag":"noindex",
 "x-content-type-options":"nosniff"}
});
function safe(env){
 if(env.CERTIFICATION_WORKER_NAME!=="zevanory-certification"||
    !/^[0-9a-f]{40}$/.test(String(env.CERTIFICATION_SOURCE_SHA||""))||
    env.ZEVANORY_DEPLOYMENT_ENV!=="certification"||
    env.CERTIFICATION_PILOT_ENV!=="sandbox"||
    env.MERCADOPAGO_ENV!=="sandbox"||
    String(env.SALE_GLOBALLY_ENABLED)!=="false"||
    String(env.CERTIFICATION_PILOT_PRODUCTION_ALLOWED)!=="false")return false;
 // No production secrets/bindings, production KV, or shared database.
 for(const key of ["MERCADOPAGO_ACCESS_TOKEN","MERCADOPAGO_WEBHOOK_SECRET",
   "MERCADOPAGO_PUBLIC_KEY","DATABASE_URL","OPERATOR_TOKEN","STRIPE_SECRET_KEY",
   "RESEND_API_KEY","ASAAS_API_KEY","SELF","CORE"]){
   if(env[key]!==undefined && env[key]!==null)return false;
 }
 return Boolean(env.ZEVANORY_PRIVATE_ARTIFACTS?.get && env.CERTIFICATION_D1?.prepare &&
   env.CERTIFICATION_DATABASE_URL && env.CERTIFICATION_OPERATOR_TOKEN &&
   env.CERTIFICATION_E2E_TOKEN && env.MERCADOPAGO_TEST_ACCESS_TOKEN &&
   env.MERCADOPAGO_TEST_PUBLIC_KEY && env.MERCADOPAGO_TEST_WEBHOOK_SECRET);
}
export default {
 async fetch(request,env,ctx){
   const url=new URL(request.url);
   if(!safe(env))return reply(503,"certification_isolation_unavailable");
   if(!allowed.has(url.pathname))return reply(404,"not_found");
   if(url.pathname==="/api/webhooks" &&
     (request.method!=="POST"||url.search!=="?provider=mercadopago_test"))
       return reply(404,"not_found");
   if(url.pathname==="/api/support/refund-request" && request.method!=="POST")
       return reply(405,"method_not_allowed");
   if(!url.pathname.startsWith(prefix)&&url.pathname!=="/api/support/refund-request"&&url.pathname!=="/api/webhooks")
       return reply(404,"not_found");
   const sandboxEnv={...env,
     DATABASE_URL:env.CERTIFICATION_DATABASE_URL,
     OPERATOR_TOKEN:env.CERTIFICATION_OPERATOR_TOKEN,
     RESEND_API_KEY:env.CERTIFICATION_RESEND_API_KEY,
     RESEND_RECEIVING_API_KEY:env.CERTIFICATION_RESEND_RECEIVING_API_KEY
   };
   const res=await canonical.fetch(request,sandboxEnv,ctx);
   if(url.pathname==="/api/internal/certification/e2e/status" && res.status===200){
     const payload=await res.clone().json().catch(()=>null);
     if(!payload||typeof payload!=="object")return reply(503,"certification_status_invalid");
     const headers=new Headers(res.headers);
     headers.set("cache-control","no-store");
     return new Response(JSON.stringify({...payload,certification_worker_source_sha:env.CERTIFICATION_SOURCE_SHA}),{status:res.status,headers});
   }
   return res;
 },
 async scheduled(){ /* Intentionally no cron; certification is manual-only. */ },
};
