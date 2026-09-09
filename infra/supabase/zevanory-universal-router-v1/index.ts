import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ORIGINS=Object.freeze([
  {name:"cloudflare",base:"https://edge.zevanory.api.br"},
  {name:"vercel",base:"https://zevanory-site.vercel.app"},
]);
const SLUG="/zevanory-universal-router-v1";
const READ_METHODS=new Set(["GET","HEAD"]);
function routedPath(url:URL){
  const i=url.pathname.indexOf(SLUG);
  const suffix=i>=0?url.pathname.slice(i+SLUG.length):url.pathname;
  return `${suffix||"/"}${url.search}`;
}
function headersFor(req:Request){
  const headers=new Headers(req.headers);
  headers.delete("host");headers.delete("content-length");
  headers.set("x-zevanory-router","supabase-v2");
  return headers;
}
async function proxy(req:Request,origin:{name:string;base:string},path:string,timeoutMs=6000){
  const init:RequestInit={method:req.method,headers:headersFor(req),redirect:"manual",signal:AbortSignal.timeout(timeoutMs)};
  if(!READ_METHODS.has(req.method))init.body=req.body;
  const r=await fetch(new Request(new URL(path,origin.base),init));
  const out=new Headers(r.headers);
  out.set("x-zevanory-router-origin",origin.name);
  out.set("x-zevanory-router-policy",READ_METHODS.has(req.method)?"fast-primary-read-failover":"single-origin-no-blind-retry");
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:out});
}
async function health(origin:{name:string;base:string}){
  const started=performance.now();
  try{
    const r=await fetch(`${origin.base}/api/health`,{signal:AbortSignal.timeout(3500),headers:{accept:"application/json"}});
    const b=await r.json().catch(()=>({}));
    return {name:origin.name,healthy:r.status===200&&b?.ready===true,status:r.status,latency_ms:Math.round(performance.now()-started),schema:b?.schema||null};
  }catch{return {name:origin.name,healthy:false,status:0,latency_ms:Math.round(performance.now()-started),schema:null};}
}
Deno.serve(async(req:Request)=>{
  const url=new URL(req.url),path=routedPath(url);
  if(path.startsWith("/__router/health")){
    const states=await Promise.all(ORIGINS.map(health));
    return Response.json({service:"ZEVANORY",router:"supabase-universal-router-v2",ready:states.some(x=>x.healthy),policy:{reads:"fast-primary-then-safe-failover",mutations:"cloudflare-only-no-blind-retry"},origins:states},{headers:{"cache-control":"no-store"}});
  }
  if(!READ_METHODS.has(req.method)){
    try{return await proxy(req,ORIGINS[0],path,7000);}catch{return Response.json({error:"mutation_origin_unavailable",preserved:true,retried:false},{status:503,headers:{"cache-control":"no-store"}});}
  }
  try{
    const primary=await proxy(req,ORIGINS[0],path,3500);
    if(primary.status<500)return primary;
  }catch{}
  try{return await proxy(req,ORIGINS[1],path,5000);}catch{return Response.json({error:"all_read_origins_unavailable"},{status:503,headers:{"cache-control":"no-store"}});}
});