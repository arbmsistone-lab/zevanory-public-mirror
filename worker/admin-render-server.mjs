import { buildContinuityPlan } from "./continuity-router.mjs";
import http from "node:http";
import fs from "node:fs";

const encoder=new TextEncoder();
const PORT=Number(process.env.PORT||10000);
const ADMIN_USER=String(process.env.ZEVANORY_ADMIN_USERNAME||"");
const ADMIN_PASS=String(process.env.ZEVANORY_ADMIN_PASSWORD||"");
const PUBLIC_BASE_URL=String(process.env.ZEVANORY_PUBLIC_BASE_URL||"https://zevanory.api.br");
const CSS=fs.readFileSync(new URL("../admin.css",import.meta.url),"utf8");

const AUTH_WINDOW_MS=15*60*1000;
const AUTH_LOCK_MS=30*60*1000;
const AUTH_MAX_FAILURES_PER_CLIENT=5;
const AUTH_MAX_FAILURES_GLOBAL=10;
const REQUEST_WINDOW_MS=60*1000;
const REQUEST_MAX_PER_CLIENT=120;
const STATE_MAX_KEYS=10000;
const authFailures=new Map();
const requestHits=new Map();
let globalAuthFailures=[];
let globalLockedUntil=0;
let lastPruneAt=0;

function nowMs(){ return Date.now(); }
function normalizeIp(value){
  const raw=String(value||"").trim();
  if(!raw) return "unknown";
  return raw.replace(/^::ffff:/,"").slice(0,128);
}
function clientKey(req){
  const real=normalizeIp(req.headers["x-real-ip"]);
  if(real!=="unknown") return real;
  const cf=normalizeIp(req.headers["cf-connecting-ip"]);
  if(cf!=="unknown") return cf;
  const forwarded=String(req.headers["x-forwarded-for"]||"").split(",").map(s=>normalizeIp(s)).filter(v=>v!=="unknown");
  if(forwarded.length) return forwarded[forwarded.length-1];
  return normalizeIp(req.socket?.remoteAddress);
}
function pruneState(now=nowMs()){
  if(now-lastPruneAt<60_000) return;
  lastPruneAt=now;
  for(const [key,state] of authFailures){
    state.failures=state.failures.filter(ts=>now-ts<AUTH_WINDOW_MS);
    if(state.lockedUntil<=now && state.failures.length===0) authFailures.delete(key);
  }
  for(const [key,hits] of requestHits){
    const next=hits.filter(ts=>now-ts<REQUEST_WINDOW_MS);
    if(next.length) requestHits.set(key,next); else requestHits.delete(key);
  }
  globalAuthFailures=globalAuthFailures.filter(ts=>now-ts<AUTH_WINDOW_MS);
  if(authFailures.size>STATE_MAX_KEYS){
    for(const key of authFailures.keys()){authFailures.delete(key); if(authFailures.size<=STATE_MAX_KEYS) break;}
  }
  if(requestHits.size>STATE_MAX_KEYS){
    for(const key of requestHits.keys()){requestHits.delete(key); if(requestHits.size<=STATE_MAX_KEYS) break;}
  }
}
function retryAfterSeconds(until,now=nowMs()){ return Math.max(1,Math.ceil((until-now)/1000)); }
function requestRateLimit(req){
  const now=nowMs(); pruneState(now);
  const key=clientKey(req);
  const hits=(requestHits.get(key)||[]).filter(ts=>now-ts<REQUEST_WINDOW_MS);
  if(hits.length>=REQUEST_MAX_PER_CLIENT){
    const until=hits[0]+REQUEST_WINDOW_MS;
    requestHits.set(key,hits);
    return {limited:true,retryAfter:retryAfterSeconds(until,now),key};
  }
  hits.push(now); requestHits.set(key,hits);
  return {limited:false,key};
}
function authLockState(req){
  const now=nowMs(); pruneState(now);
  const key=clientKey(req);
  if(globalLockedUntil>now) return {locked:true,retryAfter:retryAfterSeconds(globalLockedUntil,now),key,scope:"global"};
  const state=authFailures.get(key);
  if(state?.lockedUntil>now) return {locked:true,retryAfter:retryAfterSeconds(state.lockedUntil,now),key,scope:"client"};
  return {locked:false,key};
}
function recordAuthFailure(key){
  const now=nowMs(); pruneState(now);
  const state=authFailures.get(key)||{failures:[],lockedUntil:0};
  state.failures=state.failures.filter(ts=>now-ts<AUTH_WINDOW_MS);
  state.failures.push(now);
  if(state.failures.length>=AUTH_MAX_FAILURES_PER_CLIENT) state.lockedUntil=now+AUTH_LOCK_MS;
  authFailures.set(key,state);
  globalAuthFailures=globalAuthFailures.filter(ts=>now-ts<AUTH_WINDOW_MS);
  globalAuthFailures.push(now);
  if(globalAuthFailures.length>=AUTH_MAX_FAILURES_GLOBAL) globalLockedUntil=now+AUTH_LOCK_MS;
}
function clearClientAuthFailures(key){ authFailures.delete(key); }


function secureEqual(a,b){
  const aa=encoder.encode(String(a??"")),bb=encoder.encode(String(b??""));
  const n=Math.max(aa.length,bb.length);
  let diff=aa.length^bb.length;
  for(let i=0;i<n;i++) diff|=(aa[i%Math.max(aa.length,1)]??0)^(bb[i%Math.max(bb.length,1)]??0);
  return diff===0;
}
function authorized(req){
  if(!ADMIN_USER||!ADMIN_PASS) return false;
  const auth=String(req.headers.authorization||"");
  if(!auth.startsWith("Basic ")) return false;
  let raw="";
  try{raw=Buffer.from(auth.slice(6),"base64").toString("utf8");}catch{return false;}
  const i=raw.indexOf(":"); if(i<0) return false;
  return secureEqual(raw.slice(0,i),ADMIN_USER)&&secureEqual(raw.slice(i+1),ADMIN_PASS);
}
function headers(type){
  return {
    "content-type":type,
    "cache-control":"no-store, max-age=0",
    "content-security-policy":"default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "x-frame-options":"DENY",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
    "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-opener-policy":"same-origin",
    "cross-origin-resource-policy":"same-origin"
  };
}
function reply(res,status,body,type="text/plain; charset=utf-8",extra={}){
  res.writeHead(status,{...headers(type),...extra});
  res.end(body);
}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function pill(v){
  const s=String(v??"unknown"),l=s.toLowerCase();
  const cls=/(ready|active|approved|success|enabled|operational|pass)/.test(l)?"ok":/(blocked|disabled|fail|error|down)/.test(l)?"bad":"warn";
  return `<span class="pill ${cls}">${esc(s)}</span>`;
}
async function getJson(url){
  const controller=new AbortController(); const t=setTimeout(()=>controller.abort(),8000);
  try{
    const r=await fetch(url,{headers:{"accept":"application/json","user-agent":"ZEVANORY-Admin-Render/1.0","cache-control":"no-cache"},signal:controller.signal});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function snapshot(){
  const [status,health,control]=await Promise.all([
    getJson(new URL("/api/status",PUBLIC_BASE_URL).toString()),
    getJson(new URL("/api/health",PUBLIC_BASE_URL).toString()),
    getJson(new URL("/api/control-plane",PUBLIC_BASE_URL).toString())
  ]);
  const continuity=buildContinuityPlan(status,{minQuorum:3});
  return {status,health,control,continuity,generated_at:new Date().toISOString()};
}
function render(x){
  const s=x.status||{},h=x.health||{},c=x.control||{},ct=x.continuity||{},counts=c.policy?.counts||{};
  const channels=Object.entries(s.channel_readiness||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${pill(v.scope_status)}</td><td>${pill(v.release_gate)}</td><td>${pill(v.commercial_execution)}</td></tr>`).join("");
  const pillars=(c.policy?.pillars||[]).map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>${pill(p.state)}</td><td>${p.remote_certified?"sim":"não"}</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><meta name="robots" content="noindex,nofollow,noarchive"><title>Central Administrativa ZEVANORY</title><link rel="stylesheet" href="/admin.css"></head><body><a class="skip" href="#main">Ir para o conteúdo</a><header><div><strong>ZEVANORY</strong><span>Central Administrativa</span></div><div class="meta">Atualização automática • 30s</div></header><main id="main"><section class="hero"><div><p class="eyebrow">CONTROL PLANE</p><h1>Visão operacional executiva</h1><p>Superfície administrativa protegida, somente leitura e fail-closed.</p></div><div class="hero-state">${pill(c.global_state)}</div></section><section class="grid"><article><span>Saúde</span><strong>${h.ready?"READY":"NOT READY"}</strong><small>DB ${h.checks?.database_reachable?"OK":"FAIL"} • schema ${h.checks?.schema_ready?"OK":"FAIL"}</small></article><article><span>Vendas</span><strong>${esc(s.runtime?.sales)}</strong><small>checkout ${esc(s.runtime?.checkout)} • financeiro ${esc(s.runtime?.financial)}</small></article><article><span>WhatsApp</span><strong>${esc(s.runtime?.whatsapp)}</strong><small>dependência obrigatória: ${ct.whatsapp_dependency_required?"sim":"não"}</small></article><article><span>ZEA-10 externo</span><strong>${esc(counts.proven||0)}/10</strong><small>${esc(counts.partial||0)} parciais • meta 10/10 externa</small></article><article><span>Quorum técnico</span><strong>${ct.quorum_ok?"PASS":"FAIL"}</strong><small>${esc((ct.available_channels||[]).length)} canais técnicos disponíveis</small></article><article><span>Banco</span><strong>${esc(h.schema?.required_tables||0)} tabelas</strong><small>${esc(h.schema?.required_migrations||0)} migrations • faltas ${esc((h.schema?.missing_tables_count||0)+(h.schema?.missing_migrations_count||0))}</small></article></section><section class="panel"><h2>Canais</h2><div class="table-wrap"><table><thead><tr><th>Canal</th><th>Escopo</th><th>Gate</th><th>Execução comercial</th></tr></thead><tbody>${channels}</tbody></table></div></section><section class="panel"><h2>ZEA-10</h2><div class="table-wrap"><table><thead><tr><th>Pilar</th><th>Nome</th><th>Estado</th><th>Externo</th></tr></thead><tbody>${pillars}</tbody></table></div></section><section class="panel compact"><h2>Políticas críticas</h2><dl><div><dt>Root blocker</dt><dd>${esc(c.root_blocker)}</dd></div><div><dt>Claim scope</dt><dd>${esc(c.policy?.claim_scope)}</dd></div><div><dt>Continuidade</dt><dd>${esc(ct.mode)}</dd></div><div><dt>Comercial</dt><dd>fail-closed</dd></div></dl></section></main><footer>Somente leitura • no-store • noindex • autenticação obrigatória</footer></body></html>`;
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url||"/","http://localhost");
  if(u.pathname==="/healthz") return reply(res,200,JSON.stringify({service:"zevanory-admin-control",live:true}),"application/json; charset=utf-8");

  const rate=requestRateLimit(req);
  if(rate.limited) return reply(res,429,"Too many requests","text/plain; charset=utf-8",{"retry-after":String(rate.retryAfter)});

  const lock=authLockState(req);
  if(lock.locked) return reply(res,429,"Authentication temporarily locked","text/plain; charset=utf-8",{"retry-after":String(lock.retryAfter)});

  if(!authorized(req)){
    recordAuthFailure(lock.key);
    const after=authLockState(req);
    if(after.locked) return reply(res,429,"Authentication temporarily locked","text/plain; charset=utf-8",{"retry-after":String(after.retryAfter)});
    return reply(res,401,"Authentication required","text/plain; charset=utf-8",{"www-authenticate":'Basic realm="ZEVANORY Administrative Control Center", charset="UTF-8"'});
  }

  clearClientAuthFailures(lock.key);
  if(req.method!=="GET"&&req.method!=="HEAD") return reply(res,405,"Method not allowed");
  if(u.pathname==="/admin.css") return reply(res,200,CSS,"text/css; charset=utf-8");
  try{
    const snap=await snapshot();
    if(u.pathname==="/api/admin/snapshot") return reply(res,200,JSON.stringify(snap),"application/json; charset=utf-8");
    if(u.pathname==="/"||u.pathname==="/admin") return reply(res,200,render(snap),"text/html; charset=utf-8");
    return reply(res,404,"Not found");
  }catch(error){
    console.error("admin_snapshot_error",error?.message||String(error));
    return reply(res,503,"Administrative snapshot unavailable");
  }
});
server.listen(PORT,"0.0.0.0",()=>console.log("ZEVANORY admin control listening on",PORT));
