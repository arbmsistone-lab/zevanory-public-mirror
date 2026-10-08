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
export function classifyPaymentEvidence(row,response,accountId) {
  const id=String(row?.id||"");
  const status=Number(response?.status||0);
  const ambiguous=reason=>({classification:"ambiguo",reason});
  // An unidentifiable payment is not evidence of being a sandbox payment.
  if(!/^\\d{1,32}$/.test(id))return ambiguous("payment_id_missing_or_invalid");
  if(row?.orphan===true)return ambiguous("order_missing");
  if(row?.pilot===true){
    // Production-token 404 plus an explicit pilot flag is provable certification,
    // not proof of commercial revenue. HTTP 200 here indicates account contamination.
    if(status===404)return {classification:"teste_certificacao",reason:"pilot_id_absent_from_production_account"};
    if(status===200)return ambiguous("pilot_payment_visible_in_production_account");
    return ambiguous("pilot_payment_lookup_unverified");
  }
  if(row?.pilot!==false)return ambiguous("certification_provenance_unverified");
  if(row?.provider!=="mercadopago")return ambiguous("provider_outside_mercadopago_proof");
  if(status===404)return {classification:"nao_existe_em_producao",reason:"production_provider_404"};
  if(status!==200||!response?.body)return ambiguous("production_provider_unavailable_or_unexpected_http");
  const payment=response.body;
  if(String(payment.id||"")!==id)return ambiguous("provider_payment_id_mismatch");
  if(String(payment.collector_id||payment.collector?.id||"")!==String(accountId))return ambiguous("merchant_account_mismatch");
  if(payment.live_mode!==true)return ambiguous("provider_live_mode_not_true");
  const reference=String(payment.external_reference||"");
  const expected=String(row.reference||"");
  const orderId=String(row.order_id||"");
  if(!reference||(reference!==expected&&reference!==orderId&&!reference.endsWith(":"+orderId)))return ambiguous("external_reference_not_reconciled");
  return {classification:"producao_confirmado",reason:"production_account_and_reference_verified"};
}
export function classifyPayment(row,response,accountId) {
  return classifyPaymentEvidence(row,response,accountId).classification;
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
    payment_ids:{producao_confirmado:[],ambiguo:[]},evidence_reasons:[],certification_events:0,complete:false,commercial_release_allowed:false};
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
  const reasonCounts=new Map();
  for(const row of rows){
    const evidence=classifyPaymentEvidence(row,ids.get(String(row.id))||{status:0,body:null},owner.body.id);
    const label=evidence.classification;
    const reasonKey=label+":"+evidence.reason;
    reasonCounts.set(reasonKey,(reasonCounts.get(reasonKey)||0)+1);
    if(label==="producao_confirmado"){result.production_confirmed++;result.payment_ids.producao_confirmado.push(String(row.id));}
    else if(label==="nao_existe_em_producao")result.not_in_production++;
    else if(label==="teste_certificacao")result.certification_events++;
    else{result.ambiguous++;result.payment_ids.ambiguo.push(String(row.id||"unknown"));}
  }
  result.payment_ids.producao_confirmado=[...new Set(result.payment_ids.producao_confirmado)];
  result.payment_ids.ambiguo=[...new Set(result.payment_ids.ambiguo)];
  result.evidence_reasons=[...reasonCounts.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count}));
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
