// Internal financial read-only audit. No mutation of commerce, provider or database.
import { verifySignedAuditProbe } from "./signed-audit-probe.mjs";
const HEADERS={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
const reply=(code,data)=>new Response(JSON.stringify(data),{status:code,headers:HEADERS});
const authLimiter=new Map();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value))))).map(x=>x.toString(16).padStart(2,"0")).join("");
async function authorized(request, env) {
  const expected=String(env.CERTIFICATION_E2E_TOKEN||"");
  const actual=String(request.headers.get("x-certification-e2e-token")||"");
  if(expected.length<32||actual.length!==expected.length)return false;
  const [a,b]=await Promise.all([hash(actual),hash(expected)]);
  return a===b;
}
function rateLimited(request,now=Date.now()) {
  const key=String(request.headers.get("cf-connecting-ip")||"unknown").slice(0,80);
  const state=authLimiter.get(key);
  if(!state||now-state.started>300000){authLimiter.set(key,{started:now,count:1});return false;}
  state.count++;
  return state.count>5;
}
export function safeDbHost(url) {
  try{
    const h=new URL(String(url)).hostname.toLowerCase();
    for(const s of ["neon.tech","render.com","supabase.co","supabase.com"])if(h===s||h.endsWith("."+s))return s;
  }catch{}
  return "unknown";
}
export function classifyPayment(row,response,accountId) {
  if(row.provider!=="mercadopago"||row.pilot!==false||row.orphan)return "ambiguo";
  const id=String(row.id||"");
  if(!/^\d{1,32}$/.test(id))return "ambiguo";
  if(response.status===404)return "nao_existe_em_producao";
  if(response.status!==200||!response.body)return "ambiguo";
  const b=response.body;
  const idMatch=String(b.id||"")===id;
  const collectorMatch=String(b.collector_id||b.collector?.id||"")===String(accountId);
  const ref=String(b.external_reference||"");
  const origin=String(row.reference||"");
  const orderId=String(row.order_id||"");
  const refMatch=ref!==""&&(ref===origin||ref===orderId||ref.endsWith(":"+orderId));
  return idMatch&&collectorMatch&&refMatch&&b.live_mode===true?"producao_confirmado":"ambiguo";
}
async function mpGet(path,token) {
  if(!token||token.startsWith("TEST-"))return {status:0,body:null};
  try{
    const r=await fetch("https://api.mercadopago.com"+path,{method:"GET",headers:{"authorization":"Bearer "+token,"accept":"application/json"},signal:AbortSignal.timeout(7000)});
    if(r.status!==200)return {status:r.status,body:null};
    return {status:200,body:await r.json()};
  }catch{return {status:0,body:null};}
}
async function getOwner(token){
  const r=await mpGet("/users/me",token),body=r.body||{};
  const tags=body.tags;
  const verified=r.status===200&&body.site_id==="MLB"&&Array.isArray(tags)&&!tags.includes("test_user")&&/^\d+$/.test(String(body.id||""));
  return {verified,body};
}
async function runtimeIdentity(env,sqlFactory){
  const token=String(env.MERCADOPAGO_ACCESS_TOKEN||"");
  const owner=await getOwner(token);
  const identity={environment:String(env.MERCADOPAGO_ENV||"unknown"),site_id:owner.verified?"MLB":null,
    test_user:owner.body.tags?.includes?.("test_user")??null,
    user_id_sha256_16:owner.verified?(await hash(String(owner.body.id))).slice(0,16):null,
    production_account_verified:owner.verified};
  const db={provider_host_suffix:safeDbHost(env.DATABASE_URL),postgres_version:null,created_at:null,size_bytes:null,
    plan:"not_visible_in_sql",expiration_at:null};
  if(env.DATABASE_URL&&sqlFactory){
    try{
      const sql=sqlFactory(env.DATABASE_URL);
      const rows=await sql.query("select current_setting('server_version') as version, pg_database_size(current_database())::bigint as bytes",[]);
      db.postgres_version=String(rows?.[0]?.version||"").slice(0,80)||null;
      db.size_bytes=Number(rows?.[0]?.bytes)||0;
    }catch{db.database_query="unavailable";}
  }
  return {schema:"zevanory.audit.runtime-identity/v1",identity,database:db,commercial_release_allowed:false};
}
async function financialClassification(env,sqlFactory){
  const result={schema:"zevanory.audit.financial-classification/v1",production_confirmed:0,
    not_in_production:0,ambiguous:0,orders:{total:0,certification:0,noncertified_unverified:0},
    payment_ids:{producao_confirmado:[],ambiguo:[]},complete:false,commercial_release_allowed:false};
  if(!env.DATABASE_URL||!sqlFactory)return {code:503,result:{error:"database_unavailable"}};
  const token=String(env.MERCADOPAGO_ACCESS_TOKEN||"");
  const owner=await getOwner(token);
  if(!owner.verified)return {code:503,result:{error:"production_token_unverified"}};
  let rows;
  try{
    const sql=sqlFactory(env.DATABASE_URL);
    const counts=await sql.query("select count(*)::int total, count(*) filter(where certification_pilot is true)::int certification from orders",[]);
    result.orders.total=Number(counts?.[0]?.total)||0;
    result.orders.certification=Number(counts?.[0]?.certification)||0;
    result.orders.noncertified_unverified=result.orders.total-result.orders.certification;
    rows=await sql.query(`select f.provider_payment_id::text id,f.provider::text provider,
      f.external_reference::text reference,f.order_id::text order_id,
      o.certification_pilot pilot,(o.order_id is null) orphan
      from financial_events f left join orders o on o.order_id=f.order_id
      order by f.provider_payment_id::text limit 41`,[]);
  }catch{return {code:503,result:{error:"database_read_unavailable"}};}
  if(rows.length>40)return {code:503,result:{error:"audit_limit_exceeded",complete:false}};
  const ids=new Map();
  for(const x of rows)if(/^\d{1,32}$/.test(String(x.id||"")))ids.set(String(x.id),null);
  if(ids.size>40)return {code:503,result:{error:"audit_limit_exceeded",complete:false}};
  for(const id of ids.keys())ids.set(id,await mpGet("/v1/payments/"+id,token));
  for(const row of rows){
    const label=classifyPayment(row,ids.get(String(row.id))||{status:0,body:null},owner.body.id);
    if(label==="producao_confirmado"){result.production_confirmed++;result.payment_ids.producao_confirmado.push(String(row.id));}
    else if(label==="nao_existe_em_producao")result.not_in_production++;
    else{result.ambiguous++;result.payment_ids.ambiguo.push(String(row.id||"unknown"));}
  }
  result.payment_ids.producao_confirmado=[...new Set(result.payment_ids.producao_confirmado)];
  result.payment_ids.ambiguo=[...new Set(result.payment_ids.ambiguo)];
  result.complete=true;
  return {code:result.ambiguous?409:200,result};
}
export async function handleInternalFinancialAudit(request,env,{sqlFactory}={}){
  const path=new URL(request.url).pathname;
  if(!["/api/internal/audit/financial-classification","/api/internal/audit/runtime-identity"].includes(path))return null;
  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});
  if(!(await authorized(request,env)) && !(await verifySignedAuditProbe(request,env)))return reply(401,{error:"unauthorized"});
  if(rateLimited(request))return reply(429,{error:"audit_rate_limited"});
  if(path.endsWith("/runtime-identity"))return reply(200,await runtimeIdentity(env,sqlFactory));
  const x=await financialClassification(env,sqlFactory);
  return reply(x.code,x.result);
}
