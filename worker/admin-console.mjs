const encoder=new TextEncoder();

function secureEqual(a,b){
  const aa=encoder.encode(String(a??""));
  const bb=encoder.encode(String(b??""));
  const n=Math.max(aa.length,bb.length);
  let diff=aa.length^bb.length;
  for(let i=0;i<n;i++) diff|=(aa[i%Math.max(aa.length,1)]??0)^(bb[i%Math.max(bb.length,1)]??0);
  return diff===0;
}

function unauthorized(){
  return new Response("Authentication required",{status:401,headers:{
    "www-authenticate":'Basic realm="ZEVANORY Administrative Control Center", charset="UTF-8"',
    "cache-control":"no-store",
    "content-type":"text/plain; charset=utf-8",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer"
  }});
}

export function isAdminAuthorized(request,env={}){
  const user=String(env.ZEVANORY_ADMIN_USERNAME??"");
  const pass=String(env.ZEVANORY_ADMIN_PASSWORD??"");
  if(!user||!pass) return false;
  const auth=request.headers.get("authorization")||"";
  if(!auth.startsWith("Basic ")) return false;
  let decoded="";
  try{decoded=atob(auth.slice(6));}catch{return false;}
  const idx=decoded.indexOf(":");
  if(idx<0) return false;
  return secureEqual(decoded.slice(0,idx),user)&&secureEqual(decoded.slice(idx+1),pass);
}

async function jsonThrough(worker,url,request,env,ctx){
  const r=await worker.fetch(new Request(url,{method:"GET",headers:{
    "accept":"application/json",
    "user-agent":"ZEVANORY-Admin-Control/1.0"
  }}),env,ctx);
  if(!r.ok) throw new Error("upstream_"+r.status);
  return r.json();
}

function esc(v){
  return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function pill(value){
  const s=String(value??"unknown");
  const low=s.toLowerCase();
  const cls=/(ready|active|approved|success|enabled|operational)/.test(low)?"ok":/(blocked|disabled|fail|error|down)/.test(low)?"bad":"warn";
  return `<span class="pill ${cls}">${esc(s)}</span>`;
}

function html(snapshot){
  const s=snapshot.status||{}, h=snapshot.health||{}, c=snapshot.control||{}, continuity=snapshot.continuity||{};
  const counts=c.policy?.counts||{};
  const zrows=(c.policy?.pillars||[]).map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>${pill(p.state)}</td><td>${p.remote_certified?"sim":"não"}</td></tr>`).join("");
  const channels=Object.entries(s.channel_readiness||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${pill(v.scope_status)}</td><td>${pill(v.release_gate)}</td><td>${pill(v.commercial_execution)}</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30"><meta name="robots" content="noindex,nofollow,noarchive">
  <title>Central Administrativa ZEVANORY</title><link rel="stylesheet" href="/admin.css"></head><body>
  <a class="skip" href="#main">Ir para o conteúdo</a><header><div><strong>ZEVANORY</strong><span>Central Administrativa</span></div><div class="meta">Atualização automática • 30s</div></header>
  <main id="main">
  <section class="hero"><div><p class="eyebrow">CONTROL PLANE</p><h1>Visão operacional executiva</h1><p>Superfície administrativa somente leitura, protegida e fail-closed.</p></div><div class="hero-state">${pill(c.global_state)}</div></section>
  <section class="grid">
    <article><span>Saúde</span><strong>${h.ready?"READY":"NOT READY"}</strong><small>DB ${h.checks?.database_reachable?"OK":"FAIL"} • schema ${h.checks?.schema_ready?"OK":"FAIL"}</small></article>
    <article><span>Vendas</span><strong>${esc(s.runtime?.sales)}</strong><small>checkout ${esc(s.runtime?.checkout)} • financeiro ${esc(s.runtime?.financial)}</small></article>
    <article><span>WhatsApp</span><strong>${esc(s.runtime?.whatsapp)}</strong><small>dependência obrigatória: ${continuity.whatsapp_dependency_required?"sim":"não"}</small></article>
    <article><span>ZEA-10 externo</span><strong>${esc(counts.proven||0)}/10</strong><small>${esc(counts.partial||0)} parciais • meta 10/10 externa</small></article>
    <article><span>Quorum técnico</span><strong>${continuity.quorum_ok?"PASS":"FAIL"}</strong><small>${esc((continuity.available_channels||[]).length)} canais técnicos disponíveis</small></article>
    <article><span>Banco</span><strong>${esc(h.schema?.required_tables||0)} tabelas</strong><small>${esc(h.schema?.required_migrations||0)} migrations • faltas ${esc((h.schema?.missing_tables_count||0)+(h.schema?.missing_migrations_count||0))}</small></article>
  </section>
  <section class="panel"><h2>Canais</h2><div class="table-wrap"><table><thead><tr><th>Canal</th><th>Escopo</th><th>Gate</th><th>Execução comercial</th></tr></thead><tbody>${channels}</tbody></table></div></section>
  <section class="panel"><h2>ZEA-10</h2><div class="table-wrap"><table><thead><tr><th>Pilar</th><th>Nome</th><th>Estado</th><th>Externo</th></tr></thead><tbody>${zrows}</tbody></table></div></section>
  <section class="panel compact"><h2>Políticas críticas</h2><dl><div><dt>Root blocker</dt><dd>${esc(c.root_blocker)}</dd></div><div><dt>Claim scope</dt><dd>${esc(c.policy?.claim_scope)}</dd></div><div><dt>Continuidade</dt><dd>${esc(continuity.mode)}</dd></div><div><dt>Comercial</dt><dd>fail-closed</dd></div></dl></section>
  </main><footer>Sem ações destrutivas • no-store • noindex • autenticação obrigatória</footer></body></html>`;
}

export async function handleAdminRequest(request,env,ctx,worker){
  if(!isAdminAuthorized(request,env)) return unauthorized();
  const base=new URL(request.url);
  try{
    const [status,health,control,continuity]=await Promise.all([
      jsonThrough(worker,new URL("/api/status",base),request,env,ctx),
      jsonThrough(worker,new URL("/api/health",base),request,env,ctx),
      jsonThrough(worker,new URL("/api/control-plane",base),request,env,ctx),
      jsonThrough(worker,new URL("/api/continuity",base),request,env,ctx)
    ]);
    const snapshot={status,health,control,continuity,generated_at:new Date().toISOString()};
    if(base.pathname==="/api/admin/snapshot"){
      return new Response(JSON.stringify(snapshot),{status:200,headers:{
        "content-type":"application/json; charset=utf-8","cache-control":"no-store",
        "content-security-policy":"default-src 'none'; frame-ancestors 'none'","x-content-type-options":"nosniff","referrer-policy":"no-referrer"
      }});
    }
    return new Response(html(snapshot),{status:200,headers:{
      "content-type":"text/html; charset=utf-8","cache-control":"no-store",
      "content-security-policy":"default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "x-frame-options":"DENY","x-content-type-options":"nosniff","referrer-policy":"no-referrer",
      "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    }});
  }catch(e){
    return new Response("Administrative snapshot unavailable",{status:503,headers:{"cache-control":"no-store","content-type":"text/plain; charset=utf-8"}});
  }
}
