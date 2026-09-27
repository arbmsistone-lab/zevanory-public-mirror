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
  const s=snapshot.status||{}, h=snapshot.health||{}, c=snapshot.control||{}, continuity=snapshot.continuity||{}, zees=snapshot.zees16||{}, zea=snapshot.zea10||{};
  const counts=zea.counts||{};
  const z16=zees.counts||{};
  const zeesCards=(zees.pillars||[]).map(p=>{
    const cls=p.state==="PROVADO"?"ok":p.state==="PARTIAL"?"warn":"bad";
    const title=(p.blockers||[]).length?("Bloqueadores: "+p.blockers.join(", ")):"Prova integral reproduzível";
    return `<article class="zees-card ${cls}" title="${esc(title)}"><b>${esc(p.id)}</b><span>${esc(p.state)}</span><small>${esc(p.name)}</small></article>`;
  }).join("");
  const zrows=(zea.pillars||[]).map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>${pill(p.state)}</td><td>${esc((p.requires||[]).join(", "))}</td></tr>`).join("");
  const channels=Object.entries(s.channel_readiness||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${pill(v.scope_status)}</td><td>${pill(v.release_gate)}</td><td>${pill(v.commercial_execution)}</td></tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30"><meta name="robots" content="noindex,nofollow,noarchive">
  <title>Central Administrativa ZEVANORY</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#07101f;color:#f4f7fb;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}body{display:grid;grid-template-rows:52px 1fr 28px}header{display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid #24324a;background:#0a1425}header>div:first-child{display:flex;align-items:baseline;gap:12px}header strong{letter-spacing:.16em}header span,.meta,small{color:#9fb0c8}main{min-height:0;padding:12px 18px;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:10px;overflow:hidden}.hero{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 16px;border:1px solid #263754;border-radius:16px;background:linear-gradient(135deg,#0e1b31,#0a1425)}.hero h1{font-size:clamp(20px,2vw,30px);margin:2px 0}.hero p{margin:3px 0}.eyebrow{font-size:11px;letter-spacing:.18em;color:#8fa6c8}.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}.grid article,.panel{min-width:0;border:1px solid #263754;border-radius:14px;background:#0b1729}.grid article{padding:9px 11px;display:flex;flex-direction:column;gap:2px}.grid article>span{font-size:11px;color:#9fb0c8}.grid article strong{font-size:17px;white-space:normal;overflow-wrap:anywhere}.grid article small{font-size:10px}.panel{padding:10px 12px;min-height:0;overflow:hidden}.panel-title{display:flex;justify-content:space-between;align-items:center;gap:12px}.panel h2{font-size:14px;margin:0 0 7px}.zees-board{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:5px}.zees-card{min-width:0;padding:6px;border:1px solid #30415e;border-radius:9px;display:grid;gap:1px}.zees-card b,.zees-card span{font-size:10px}.zees-card small{font-size:9px;white-space:normal;overflow-wrap:anywhere}.decision-meta{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:10px}.table-wrap{max-height:18vh;overflow:hidden}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #1d2a40;white-space:normal;overflow-wrap:anywhere}.pill{display:inline-flex;align-items:center;max-width:100%;padding:3px 7px;border-radius:999px;font-size:10px;text-decoration:none;white-space:normal;overflow-wrap:anywhere}.ok{background:#123a2e;color:#8ef0c1}.warn{background:#403418;color:#f5d77c}.bad{background:#411e29;color:#ff9caf}.compact{display:none}main>.panel:nth-of-type(3),main>.panel:nth-of-type(4){display:none}footer{display:flex;align-items:center;justify-content:center;border-top:1px solid #1c2940;color:#8293ac;font-size:10px}.skip{position:absolute;left:-9999px}@media(max-width:1500px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}.grid article:nth-child(n+5){display:none}.zees-board{grid-template-columns:repeat(8,minmax(0,1fr))}}@media(max-width:900px){body{grid-template-rows:46px 1fr 24px}header{padding:0 10px}.meta{display:none}main{padding:8px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.grid article:nth-child(n+5){display:none}.zees-board{grid-template-columns:repeat(4,minmax(0,1fr))}.hero p:not(.eyebrow){display:none}.panel-title small{display:none}}@media(max-height:760px){main{padding:7px 12px;gap:6px}.hero{padding:7px 12px}.hero h1{font-size:20px}.grid article{padding:6px 8px}.panel{padding:7px 9px}.zees-card{padding:4px}.decision-meta{margin-top:4px}}
</style></head><body>
  <a class="skip" href="#main">Ir para o conteúdo</a><header><div><strong>ZEVANORY</strong><span>Central Administrativa</span></div><div class="meta">Atualização automática • 30s</div></header>
  <main id="main">
  <section class="hero"><div><p class="eyebrow">ZEVANORY CONTROL CORE</p><h1>Visão operacional executiva</h1><p>Superfície administrativa governada pelo core canônico. A UI nunca autoriza mudanças críticas de estado.</p><p><a class="pill ok" href="https://zevanory.api.br/solucoes" rel="noopener">Abrir Página de Vendas →</a></p></div><div class="hero-state">${pill(c.global_state)}</div></section>
  <section class="grid">
    <article><span>Saúde</span><strong>${h.ready?"READY":"NOT READY"}</strong><small>DB ${h.checks?.database_reachable?"OK":"FAIL"} • schema ${h.checks?.schema_ready?"OK":"FAIL"}</small></article>
    <article><span>Vendas</span><strong>${esc(s.runtime?.sales)}</strong><small>checkout ${esc(s.runtime?.checkout)} • financeiro ${esc(s.runtime?.financial)}</small></article>
    <article><span>WhatsApp</span><strong>${esc(s.runtime?.whatsapp)}</strong><small>dependência obrigatória: ${continuity.whatsapp_dependency_required?"sim":"não"}</small></article>
    <article><span>ZEA-10 avaliação</span><strong>${esc(counts.proven||0)}/10</strong><small>${esc(counts.partial||0)} parciais • ${esc(counts.blocked||0)} bloqueados</small></article>
    <article><span>ZEES-16 automático</span><strong>${esc(z16.proven||0)}/16</strong><small>${esc(z16.partial||0)} parciais • ${esc(z16.blocked||0)} bloqueados</small></article>
    <article><span>Quorum técnico</span><strong>${continuity.quorum_ok?"PASS":"FAIL"}</strong><small>${esc((continuity.available_channels||[]).length)} canais técnicos disponíveis</small></article>
    <article><span>Banco</span><strong>${esc(h.schema?.required_tables||0)} tabelas</strong><small>${esc(h.schema?.required_migrations||0)} migrations • faltas ${esc((h.schema?.missing_tables_count||0)+(h.schema?.missing_migrations_count||0))}</small></article>
  </section>
  <section class="panel"><div class="panel-title"><h2>ZEES-16 · Evidence Control Plane</h2><small>Atualização por evidência, SHA e validade. A UI não promove estados.</small></div><div class="zees-board">${zeesCards||'<p class="empty">Estado ZEES-16 ainda não materializado.</p>'}</div><div class="decision-meta"><span>Policy <b>${esc(zees.policy_version||"—")}</b></span><span>SHA <b>${esc((zees.release_sha||"").slice(0,12)||"—")}</b></span><span>Decisão <b>${esc((zees.decision_hash||"").slice(0,16)||"—")}</b></span><span>Persistência <b>${esc(zees.persistence||"—")}</b></span></div></section>
  <section class="panel"><h2>Canais</h2><div class="table-wrap"><table><thead><tr><th>Canal</th><th>Escopo</th><th>Gate</th><th>Execução comercial</th></tr></thead><tbody>${channels}</tbody></table></div></section>
  <section class="panel"><h2>ZEA-10 · Evaluation Plane</h2><div class="table-wrap"><table><thead><tr><th>Pilar</th><th>Nome</th><th>Estado</th><th>Provas ZEES-16</th></tr></thead><tbody>${zrows}</tbody></table></div></section>
  <section class="panel compact"><h2>Políticas críticas</h2><dl><div><dt>Root blocker</dt><dd>${esc(c.root_blocker)}</dd></div><div><dt>Claim scope</dt><dd>${esc(c.policy?.claim_scope)}</dd></div><div><dt>Continuidade</dt><dd>${esc(continuity.mode)}</dd></div><div><dt>Comercial</dt><dd>fail-closed</dd></div></dl></section>
  </main><footer>Sem ações destrutivas • no-store • noindex • autenticação obrigatória</footer></body></html>`;
}

export async function handleAdminRequest(request,env,ctx,worker){
  if(!isAdminAuthorized(request,env)) return unauthorized();
  const base=new URL(request.url);

  // First-paint fast path: authentication must not wait for the full Core snapshot.
  // Serve an authenticated fail-closed shell immediately; telemetry hydrates through
  // the protected JSON endpoint on the next refresh/request.
  if(base.pathname==="/admin" && request.method==="GET"){
    const shell={
      status:{runtime:{sales:"globally-blocked",checkout:"loading",financial:"loading",whatsapp:"loading"},channel_readiness:{}},
      health:{ready:false,checks:{database_reachable:false,schema_ready:false},schema:{}},
      control:{global_state:"operational_commercial_blocked",root_blocker:"loading_canonical_snapshot",policy:{}},
      continuity:{quorum_ok:false,available_channels:[],whatsapp_dependency_required:false,mode:"loading"},
      zees16:{counts:{proven:0,partial:0,blocked:0},pillars:[],persistence:"loading"},
      zea10:{counts:{proven:0,partial:0,blocked:0},pillars:[]}
    };
    const body=html(shell)
      .replace('<meta http-equiv="refresh" content="30">','<meta http-equiv="refresh" content="1">');
    return new Response(body,{status:200,headers:{
      "content-type":"text/html; charset=utf-8","cache-control":"no-store",
      "content-security-policy":"default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "x-frame-options":"DENY","x-content-type-options":"nosniff","referrer-policy":"no-referrer",
      "permissions-policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
      "server-timing":"admin-auth;dur=0"
    }});
  }
  try{
    const core=await jsonThrough(worker,new URL("/api/core/v1/snapshot",base),request,env,ctx);
    const {status,health,control,continuity,zees16}=core;
    const snapshot={
      status,health,control,continuity,zees16,
      core:{
        schema:core.schema,
        authority:core.authority,
        fail_closed:core.fail_closed,
        ui_can_authorize:core.ui_can_authorize,
        source_of_truth:core.source_of_truth,
        release_sha:core.release_sha,
        invariants:core.invariants,
        architecture:core.architecture
      },
      zea10:core.zea10,
      generated_at:core.generated_at||new Date().toISOString()
    };
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
