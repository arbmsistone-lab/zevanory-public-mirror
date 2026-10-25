// Internal financial read-only audit. No mutation of commerce, provider or database.
import { signedAuditProbeCategory } from "./signed-audit-probe.mjs";
import { verifyOperatorToken, operatorAuthCounts, operatorTokenMigration, operatorTokenSource, operatorTokenFallbackUses, isCertificationPerimeter } from "./operator-credential.mjs";
const HEADERS={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
const reply=(code,data)=>new Response(JSON.stringify(data),{status:code,headers:HEADERS});
const authLimiter=new Map();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value))))).map(x=>x.toString(16).padStart(2,"0")).join("");
// Devolve a categoria aceita (primary | legacy | legacy_fallback | certification) ou "" (recusa); ver operator-credential.mjs.
async function authorized(request, env) {
  return verifyOperatorToken(env,String(request.headers.get("x-certification-e2e-token")||""),{minLength:32});
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
  if(!/^\d{1,32}$/.test(id))return ambiguous("payment_id_missing_or_invalid");
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

const asaasSafeId=id=>/^[a-zA-Z0-9_-]{6,96}$/.test(String(id||""));
export function classifyAsaasSandboxPilot(row,response,env={}) {
  const denied=reason=>({classification:"ambiguo",reason});
  if(row?.provider!=="asaas"||row?.pilot!==true||row?.orphan!==false)return denied("asaas_pilot_provenance_unverified");
  if(String(env.ASAAS_ENV||"").toLowerCase()!=="sandbox" || !String(env.ASAAS_API_KEY||"").trim())return denied("asaas_sandbox_credential_not_verified");
  if(!asaasSafeId(row.id))return denied("asaas_payment_id_not_eligible_for_lookup");
  if(response?.status!==200||!response?.body)return denied("asaas_sandbox_payment_lookup_unverified");
  const payment=response.body;
  const ref=String(payment.externalReference||"");
  const orderId=String(row.order_id||"");
  const expected=String(row.reference||"");
  const refOk=orderId.length>=32&&(ref===orderId||ref.endsWith(":"+orderId))&&(!expected||ref===expected);
  if(String(payment.id||"")!==String(row.id)||!refOk)return denied("asaas_sandbox_payment_reference_mismatch");
  const state=String(payment.status||"").toUpperCase();
  if(row.normalized_event==="payment_confirmed"&&!["CONFIRMED","RECEIVED","REFUNDED"].includes(state))return denied("asaas_sandbox_payment_status_not_confirmed");
  if(row.normalized_event==="refund_confirmed"&&state!=="REFUNDED")return denied("asaas_sandbox_refund_status_not_confirmed");
  if(!["payment_confirmed","refund_confirmed"].includes(String(row.normalized_event||"")))return denied("asaas_sandbox_event_not_supported");
  return {classification:"teste_certificacao",reason:"asaas_sandbox_provider_get_and_reference_verified"};
}
async function asaasSandboxGet(id,env,budget) {
  if(String(env.ASAAS_ENV||"").toLowerCase()!=="sandbox"||!String(env.ASAAS_API_KEY||"").trim()||!asaasSafeId(id))return {status:0,body:null};
  if(budget&&budget.remaining<=0)return {status:0,body:null};
  if(budget)budget.remaining--;
  try{
    const response=await fetch("https://api-sandbox.asaas.com/v3/payments/"+encodeURIComponent(id),{
      method:"GET",headers:{access_token:String(env.ASAAS_API_KEY),accept:"application/json","user-agent":"ZEVANORY-F1-READONLY-AUDIT/1.0"},
      signal:AbortSignal.timeout(7000)});
    if(response.status!==200)return {status:response.status,body:null};
    return {status:200,body:await response.json()};
  }catch{return {status:0,body:null};}
}

// Shared per-invocation budget: 46 outbound provider GETs max, leaving Worker Free
// subrequests for Neon SQL and internal infrastructure. Retries max six in total.
export const TRANSIENT_LOOKUP_REASONS=new Set(["production_provider_unavailable_or_unexpected_http","pilot_payment_lookup_unverified"]);
const auditBudget=()=>({remaining:46,retries:6});
export async function mpGet(path,token,budget=auditBudget(),{fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(!token||token.startsWith("TEST-"))return {status:0,body:null};
  let last={status:0,body:null};
  for(let attempt=0;attempt<3;attempt++){
    if(budget.remaining<=0)return last;
    budget.remaining--;
    try{
      const r=await fetchImpl("https://api.mercadopago.com"+path,{method:"GET",headers:{"authorization":"Bearer "+token,"accept":"application/json"},signal:AbortSignal.timeout(7000)});
      last=r.status===200?{status:200,body:await r.json()}:{status:r.status,body:null};
    }catch{last={status:0,body:null};}
    const transient=last.status===0||last.status===429||last.status>=500;
    if(!transient||attempt===2||budget.retries<=0||budget.remaining<=0)return last;
    budget.retries--;
    await sleep(attempt===0?500:1500);
  }
  return last;
}
async function getOwner(token,budget){
  const r=await mpGet("/users/me",token,budget),body=r.body||{};
  const tags=body.tags;
  const verified=r.status===200&&body.site_id==="MLB"&&Array.isArray(tags)&&!tags.includes("test_user")&&/^\d+$/.test(String(body.id||""));
  return {verified,body};
}
// Free-tier budget: counts Resend sends (24 h and month to date) from the list API.
// Only timestamps are read; recipients, subjects and IDs never leave this function.
export async function resendUsage(env,{fetchImpl=fetch,now=Date.now(),maxPages=35}={}){
  const key=String(env?.RESEND_API_KEY||"").trim();
  if(!key)return {status:"no_key",emails_24h:null,emails_month:null};
  const dayAgo=now-24*3600e3, d=new Date(now), monthStart=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);
  let day=0,month=0,after="";
  for(let page=0;page<maxPages;page++){
    let r;
    try{r=await fetchImpl("https://api.resend.com/emails?limit=100"+(after?"&after="+encodeURIComponent(after):""),{headers:{authorization:"Bearer "+key},signal:AbortSignal.timeout(8000)});}
    catch{return {status:"unreachable",emails_24h:null,emails_month:null};}
    if(!r.ok)return {status:"list_http_"+r.status,emails_24h:null,emails_month:null};
    const body=await r.json().catch(()=>({}));
    const items=Array.isArray(body?.data)?body.data:[];
    let oldest=Infinity;
    for(const it of items){
      const t=Date.parse(String(it?.created_at||"").replace(" ","T").replace(/([+-]\d{2})$/,"$1:00"));
      if(!Number.isFinite(t))continue;
      oldest=Math.min(oldest,t);
      if(t>=dayAgo)day++;
      if(t>=monthStart)month++;
    }
    if(!body?.has_more||!items.length||oldest<monthStart)return {status:"ok",emails_24h:day,emails_month:month};
    after=String(items[items.length-1]?.id||"");
    if(!after)break;
  }
  return {status:"ok_truncated",emails_24h:day,emails_month:month};
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
  const email=await resendUsage(env);
  return {schema:"zevanory.audit.runtime-identity/v1",identity,database:db,email,commercial_release_allowed:false};
}
// Diagnostic dimensions are fixed enums. Never output raw event IDs or references.
export function safeFinancialAuditDimensions(row={}) {
  const provider=["mercadopago","asaas","stripe"].includes(String(row.provider||""))?String(row.provider):"other_or_missing";
  const event=["payment_confirmed","refund_confirmed"].includes(String(row.normalized_event||""))?String(row.normalized_event):"other_event";
  const pilot=row.pilot===true?"pilot_true":row.pilot===false?"pilot_false":"pilot_unknown";
  const rawId=String(row.id||"");
  const id_format=rawId.trim()===""?"missing":/^\d{1,32}$/.test(rawId)?"mercadopago_numeric":"other_format";
  const eventId=String(row.provider_event_id||"").toLowerCase();
  const marker_hint=eventId.startsWith("mp-test:")?"mp_test_prefix":
    /(?:^|[-_:])(?:fixture|seed)(?:[-_:]|$)/.test(eventId)?"fixture_or_seed_prefix":
    /(?:^|[-_:])(?:pilot|test|sandbox)(?:[-_:]|$)/.test(eventId)?"pilot_or_test_prefix":"not_classifiable_from_prefix";
  return {provider,event,pilot,id_format,marker_hint};
}

async function financialClassification(env,sqlFactory){
  const result={schema:"zevanory.audit.financial-classification/v1",production_confirmed:0,
    not_in_production:0,ambiguous:0,ambiguous_transient:0,orders:{total:0,certification:0,noncertified_unverified:0},
    payment_ids:{producao_confirmado:[],ambiguo:[]},production_payment_events:0,production_refund_events:0,production_paid_orders:0,evidence_reasons:[],evidence_breakdown:[],certification_events:0,asaas_sandbox:{environment:"unknown",credential_configured:false,ids_queried:0},complete:false,commercial_release_allowed:false};
  if(!env.DATABASE_URL||!sqlFactory)return {code:503,result:{error:"database_unavailable"}};
  const token=String(env.MERCADOPAGO_ACCESS_TOKEN||"");
  const budget=auditBudget();
  const owner=await getOwner(token,budget);
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
      f.normalized_event::text normalized_event,f.provider_event_id::text provider_event_id,
      o.certification_pilot pilot,(o.order_id is null) orphan
      from financial_events f left join orders o on o.order_id=f.order_id
      order by f.provider_payment_id::text limit 41`,[]);
  }catch{return {code:503,result:{error:"database_read_unavailable"}};}
  if(rows.length>40)return {code:503,result:{error:"audit_limit_exceeded",complete:false}};
  const ids=new Map();
  for(const x of rows)if(/^\d{1,32}$/.test(String(x.id||"")))ids.set(String(x.id),null);
  if(ids.size>40)return {code:503,result:{error:"audit_limit_exceeded",complete:false}};
  for(const id of ids.keys())ids.set(id,await mpGet("/v1/payments/"+id,token,budget));
  const asaasMode=String(env.ASAAS_ENV||"").toLowerCase();
  result.asaas_sandbox.environment=asaasMode==="sandbox"?"sandbox":asaasMode==="production"?"production":"unknown";
  result.asaas_sandbox.credential_configured=Boolean(String(env.ASAAS_API_KEY||"").trim());
  const asaasResults=new Map();
  if(asaasMode==="sandbox"&&result.asaas_sandbox.credential_configured){
    for(const row of rows)if(row.provider==="asaas"&&row.pilot===true&&asaasSafeId(row.id)&&!asaasResults.has(String(row.id))){
      asaasResults.set(String(row.id),await asaasSandboxGet(row.id,env,budget));
    }
  }
  result.asaas_sandbox.ids_queried=asaasResults.size;
  const productionOrderIds=new Set();
  const reasonCounts=new Map();
  const breakdown=new Map();
  for(const row of rows){
    const evidence=row.provider==="asaas"&&row.pilot===true?
      classifyAsaasSandboxPilot(row,asaasResults.get(String(row.id))||{status:0,body:null},env):
      classifyPaymentEvidence(row,ids.get(String(row.id))||{status:0,body:null},owner.body.id);
    const label=evidence.classification;
    const reasonKey=label+":"+evidence.reason;
    reasonCounts.set(reasonKey,(reasonCounts.get(reasonKey)||0)+1);
    const d=safeFinancialAuditDimensions(row);
    const breakdownKey=JSON.stringify({classification:label,reason:evidence.reason,...d});
    breakdown.set(breakdownKey,(breakdown.get(breakdownKey)||0)+1);
    if(label==="producao_confirmado"){
      result.production_confirmed++;
      result.payment_ids.producao_confirmado.push(String(row.id));
      if(row.normalized_event==="payment_confirmed"){
        result.production_payment_events++;
        if(row.order_id)productionOrderIds.add(String(row.order_id));
      }else if(row.normalized_event==="refund_confirmed")result.production_refund_events++;
    }
    else if(label==="nao_existe_em_producao")result.not_in_production++;
    else if(label==="teste_certificacao")result.certification_events++;
    else{
      result.ambiguous++;result.payment_ids.ambiguo.push(String(row.id||"unknown"));
      // Diagnostic count only (does not change the 409 or its effect): how many ambiguous payments are
      // ambiguous solely because the provider lookup was unavailable (network error, 429 or 5xx).
      const lookup=row.provider==="asaas"&&row.pilot===true?null:ids.get(String(row.id));
      const st=Number(lookup?.status||0);
      if(TRANSIENT_LOOKUP_REASONS.has(evidence.reason)&&lookup&&(st===0||st===429||st>=500))result.ambiguous_transient++;
    }
  }
  result.production_paid_orders=productionOrderIds.size;
  result.payment_ids.producao_confirmado=[...new Set(result.payment_ids.producao_confirmado)];
  result.payment_ids.ambiguo=[...new Set(result.payment_ids.ambiguo)];
  result.evidence_reasons=[...reasonCounts.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count}));
  result.evidence_breakdown=[...breakdown.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([dims,count])=>({...JSON.parse(dims),count}));
  result.complete=true;
  return {code:result.ambiguous?409:200,result};
}
// Used exclusively by the scheduled reconciler; does not modify financial records.
export async function collectFinancialProvenanceReadOnly(env,{sqlFactory}={}){
  return financialClassification(env,sqlFactory);
}
// R9 (Sol 164 §4.3): identidade das credenciais do Worker por NOMES e CATEGORIAS, nunca valor, tamanho ou hash.
// stripe_key_mode vem só do prefixo documentado pela Stripe (sk_/rk_ + live_/test_):
// https://docs.stripe.com/api/authentication ("Test mode secret keys start with sk_test_", rk_live_, sk_live_). Qualquer outro formato é "unrecognized" (o readback falha fechado).
export function stripeKeyMode(value){
  const v=value===undefined||value===null?"":String(value).trim();
  if(!v)return "absent";
  if(/^(?:sk|rk)_live_/.test(v))return "live";
  if(/^(?:sk|rk)_test_/.test(v))return "test";
  return "unrecognized";
}
// presented: categoria com que ESTA requisição autenticou (primary | legacy | legacy_fallback | certification); com ela o
// readback prova que a credencial do runner autentica como a primária do Worker (--require-primary), só por categoria.
export function credentialIdentity(env,{presented=""}={}){
  return {schema:"zevanory.audit.credential-identity/v1",
    operator_token_source:operatorTokenSource(env),
    operator_token_fallback_uses_in_isolate:operatorTokenFallbackUses(),
    operator_token_presented:presented||"none",
    operator_token_migration:operatorTokenMigration(env).state,
    operator_token_auth_categories_in_isolate:operatorAuthCounts(),
    stripe_key_mode:stripeKeyMode(env?.STRIPE_SECRET_KEY),
    certification_perimeter:isCertificationPerimeter(env),
    release_sha:/^[0-9a-f]{40}$/.test(String(env?.ZEVANORY_RELEASE_SHA||""))?String(env.ZEVANORY_RELEASE_SHA):null};
}
// R9 B (auditoria Sol 174): leitura de pedidos da PRODUÇÃO para a conciliação somente leitura do Mercado Pago
// (scripts/mercadopago_readonly_payments_audit.py). Antes ela usava /api/internal/certification/e2e/status, rota do
// piloto sandbox que exige CERTIFICATION_PILOT_ENV=sandbox; sem o piloto na produção (R9 B) a rota recusa (409) e a
// conciliação caía em ORDER_LOOKUP_FAILED. Esta rota não depende do piloto: credencial de operador, só GET, uma única
// transação Postgres READ ONLY com um único SELECT, nenhuma chamada a provedor, nenhum dado simulado, nenhuma escrita.
export const ORDER_LOOKUP_PATH="/api/internal/audit/order-lookup";
export const ORDER_LOOKUP_MAX=40;
const ORDER_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ORDER_LOOKUP_SQL="select order_id::text order_id,amount::text amount,currency::text currency,status::text status,provider::text provider,certification_pilot from orders where order_id::text = any(string_to_array($1,','))";
export function parseOrderLookupIds(url){
  const ids=[...new Set(url.searchParams.getAll("order_id").flatMap(v=>String(v).split(",")).map(v=>v.trim().toLowerCase()).filter(Boolean))];
  if(!ids.length)return {error:"order_id_required"};
  if(ids.length>ORDER_LOOKUP_MAX)return {error:"order_lookup_limit_exceeded"};
  if(!ids.every(id=>ORDER_UUID.test(id)))return {error:"order_id_invalid"};
  return {ids};
}
const text48=v=>v===null||v===undefined?null:String(v).slice(0,48);
async function orderLookup(url,env,sqlFactory){
  const parsed=parseOrderLookupIds(url);
  if(parsed.error)return {code:400,result:{error:parsed.error}};
  if(!env.DATABASE_URL||!sqlFactory)return {code:503,result:{error:"database_unavailable"}};
  let rows;
  try{
    const sql=sqlFactory(env.DATABASE_URL);
    if(typeof sql?.transaction!=="function"||typeof sql?.query!=="function")return {code:503,result:{error:"read_only_transaction_unavailable"}};
    [rows]=await sql.transaction([sql.query(ORDER_LOOKUP_SQL,[parsed.ids.join(",")])],{readOnly:true});
  }catch{return {code:503,result:{error:"database_read_unavailable"}};}
  const wanted=new Set(parsed.ids),orders=new Map();
  for(const r of Array.isArray(rows)?rows:[]){
    const id=String(r?.order_id||"").toLowerCase();
    if(!wanted.has(id)||orders.has(id))continue;
    const amount=r.amount===null||r.amount===undefined||r.amount===""?NaN:Number(r.amount);
    orders.set(id,{order_id:id,amount:Number.isFinite(amount)?Math.round(amount*100)/100:null,currency:text48(r.currency),
      status:text48(r.status),provider:text48(r.provider),certification_pilot:r.certification_pilot===true||r.certification_pilot==="t"||r.certification_pilot==="true"});
  }
  return {code:200,result:{schema:"zevanory.audit.order-lookup/v1",read_only:true,requested:parsed.ids.length,
    orders:[...orders.values()].sort((a,b)=>a.order_id.localeCompare(b.order_id)),missing:parsed.ids.filter(id=>!orders.has(id)).sort()}};
}
export async function handleInternalFinancialAudit(request,env,{sqlFactory}={}){
  const url=new URL(request.url),path=url.pathname;
  if(![ORDER_LOOKUP_PATH,"/api/internal/audit/financial-classification","/api/internal/audit/runtime-identity","/api/internal/audit/credential-identity"].includes(path))return null;
  if(request.method!=="GET")return reply(405,{error:"method_not_allowed"});
  const presented=(request.headers.has("x-certification-e2e-token")?await authorized(request,env):"")||await signedAuditProbeCategory(request,env);
  if(!presented)return reply(401,{error:"unauthorized"});
  if(rateLimited(request))return reply(429,{error:"audit_rate_limited"});
  if(path===ORDER_LOOKUP_PATH){const x=await orderLookup(url,env,sqlFactory);return reply(x.code,x.result);}
  if(path.endsWith("/credential-identity"))return reply(200,credentialIdentity(env,{presented}));
  if(path.endsWith("/runtime-identity"))return reply(200,await runtimeIdentity(env,sqlFactory));
  const x=await financialClassification(env,sqlFactory);
  return reply(x.code,x.result);
}
