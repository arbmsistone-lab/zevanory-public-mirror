import { buildControlPlaneSnapshot } from "./controlPlanePolicy.mjs";
import { runtimeReleaseModes, RELEASE } from "./release.mjs";

const json=(body,status=200)=>new Response(JSON.stringify(body),{
  status,
  headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
    "content-security-policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  }
});

const yes=(v)=>String(v||"").toLowerCase()==="true";
const sha=(env)=>String(env.ZEVANORY_RELEASE_SHA||"").trim().toLowerCase();

async function databaseHealth(env){
  const url=String(env.DATABASE_URL||"").trim();
  if(!url) return {ok:false,error:"database_url_missing"};
  try{
    const { neon }=await import("npm:@neondatabase/serverless@1.1.0");
    const sql=neon(url);
    const rows=await sql`select 1 as ok`;
    return {ok:Number(rows?.[0]?.ok)===1};
  }catch(error){
    return {ok:false,error:"database_probe_failed",detail:String(error?.message||error).slice(0,160)};
  }
}

export async function handleDenoFailover(request,env=Deno.env.toObject()){
  const url=new URL(request.url);
  const method=String(request.method||"GET").toUpperCase();
  const releaseSha=sha(env);
  const validSha=/^[0-9a-f]{40}$/.test(releaseSha);
  const modes=runtimeReleaseModes(env);
  const publicSales=modes.salesMode==="enabled";

  if(method==="GET"&&url.pathname==="/api/health"){
    const db=await databaseHealth(env);
    const ready=db.ok&&validSha&&!publicSales;
    return json({
      service:"ZEVANORY",
      provider:"deno-deploy",
      mode:"failover-readonly",
      ready,
      database:db,
      release_sha:validSha?releaseSha:null,
      branch:String(env.ZEVANORY_RELEASE_REF||"main"),
      environment:String(env.ZEVANORY_DEPLOYMENT_ENV||"failover"),
      commercial_safety_locked:!publicSales,
      public_sales_locked:!publicSales,
      checkout_mode:"disabled",
      financial_mode:"disabled",
      fail_closed:true
    },ready?200:503);
  }

  if(method==="GET"&&url.pathname==="/api/release"){
    return json({
      service:"ZEVANORY",
      provider:"deno-deploy",
      release_id:RELEASE.id,
      deployment:{
        commit_sha:validSha?releaseSha:null,
        branch:String(env.ZEVANORY_RELEASE_REF||"main"),
        environment:String(env.ZEVANORY_DEPLOYMENT_ENV||"failover")
      },
      modes:{
        sales:"globally-blocked",
        checkout:"globally-blocked",
        financial:"disabled",
        whatsapp:"disabled"
      },
      fail_closed:true
    },validSha?200:503);
  }

  if(method==="GET"&&url.pathname==="/api/config"){
    return json({
      service:"ZEVANORY",
      provider:"deno-deploy",
      failover:true,
      commercial_enabled:false,
      checkout_enabled:false,
      financial_events_enabled:false,
      whatsapp_sales_enabled:false,
      pre_sale_gates_approved:false,
      absolute_release_approved:false,
      blockers:["failover_readonly","global_sale_disabled"],
      release_sha:validSha?releaseSha:null
    });
  }

  if(method==="GET"&&url.pathname==="/api/control-plane"){
    const lockedEnv={
      ...env,
      SALE_GLOBALLY_ENABLED:"false",
      PRE_SALE_GATES_APPROVED:"false",
      ABSOLUTE_RELEASE_APPROVED:"false",
      CHECKOUT_ENABLED:"false",
      FINANCIAL_EVENTS_ENABLED:"false",
      WHATSAPP_SALES_ENABLED:"false",
      ZEVANORY_DEPLOYMENT_ENV:String(env.ZEVANORY_DEPLOYMENT_ENV||"failover"),
      ZEVANORY_RELEASE_SHA:releaseSha
    };
    const snapshot=buildControlPlaneSnapshot(lockedEnv,null);
    return json({...snapshot,provider:"deno-deploy",failover_mode:"readonly",fail_closed:true});
  }

  if(method==="GET"&&url.pathname==="/"){
    return new Response("ZEVANORY Deno Failover\n",{
      status:200,
      headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}
    });
  }

  if(method!=="GET"&&method!=="HEAD"){
    return json({error:"failover_readonly",provider:"deno-deploy"},503);
  }

  return json({error:"not_found"},404);
}

if(import.meta.main){
  Deno.serve((request)=>handleDenoFailover(request));
}
