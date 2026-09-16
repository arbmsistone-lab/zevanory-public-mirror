const fmt=(v)=>v===null||v===undefined?'—':Number(v||0).toLocaleString('pt-BR');
const money=(v)=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const pct=(v)=>v===null||v===undefined?'SEM BASELINE':`${(Number(v)*100).toFixed(1)}%`;
const labels={approved:'APROVADO',ready:'PRONTO',active:'ATIVA',blocked:'BLOQUEADO',disabled:'DESATIVADO',true:'PRONTO',false:'BLOQUEADO','not_approved':'NÃO APROVADA','globally-blocked':'BLOQUEADO GLOBALMENTE','technical_ready_commercial_not_started':'PRONTO TÉCNICO','transactional-rollback':'ROLLBACK TESTADO','baseline_required':'BASELINE NECESSÁRIO','rules_based':'REGRAS SEGURAS',production:'PRODUÇÃO','deterministic-fallback':'FALLBACK DETERMINÍSTICO'};
const label=(v)=>labels[String(v)]||String(v??'—').replaceAll('_',' ').toUpperCase();
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
const setState=(id,value)=>{set(id,label(value));const el=document.getElementById(id);if(el)el.dataset.state=String(value);};
const sessionKey='zevanory_session_id';
const getSessionId=()=>{let id=localStorage.getItem(sessionKey);if(!/^[0-9a-f-]{36}$/i.test(id||'')){id=crypto.randomUUID();localStorage.setItem(sessionKey,id);}return id;};
async function trackPageView(){
  try{
    const q=new URLSearchParams(location.search);
    const attribution={campaign_id:(q.get('zc')||'').slice(0,32),variant_id:(q.get('zv')||'').slice(0,40),creative_id:(q.get('zi')||'').slice(0,40)};
    await fetch('/api/events/public',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_id:crypto.randomUUID(),name:'page_view',session_id:getSessionId(),channel:'central',...attribution}),keepalive:true});
  }catch{}
}

function renderPriorities(center){
  set('overdue-actions',fmt(center.work_queue?.overdue));
  set('due-24h',fmt(center.work_queue?.due_24h));
  set('blocked-actions',fmt(center.work_queue?.blocked));
  set('missing-next-action',fmt(center.risk?.missing_next_action));
  set('stale-leads',fmt(center.risk?.stale_open_leads));
  setState('nba-mode',center.execution?.next_best_action_mode);
  const hasQueue=Boolean(center.work_queue); const pressure=Number(center.work_queue?.pressure||0); set('queue-pressure',hasQueue?(pressure?`${pressure} ATENÇÕES`:'FILA SAUDÁVEL'):'PRIVADO'); set('queue-pressure-value',hasQueue?fmt(pressure):'—');
}
function renderPipeline(center,fallbackOpen){
  const f=center.pipeline?.observed_funnel||{};
  set('stage-new',fmt(f.new)); set('stage-contacted',fmt(f.contacted)); set('stage-qualified',fmt(f.qualified));
  set('stage-offer',fmt(f.offer_sent)); set('stage-checkout',fmt(f.checkout_started)); set('stage-paid',fmt(f.paid));
  const observed=['new','contacted','qualified','offer_sent','checkout_started'].reduce((sum,key)=>sum+Number(f[key]||0),0); const explicit=Number(center.pipeline?.open); const open=Number.isFinite(explicit)?explicit:(Number.isFinite(Number(fallbackOpen))?Number(fallbackOpen):observed); set('pipeline-signal',fmt(open));
  setState('forecast-mode',center.execution?.forecast_mode);
  set('predictive-forecast',center.execution?.predictive_forecast_available?'ATIVO':'BLOQUEADO SEM BASELINE');
  set('baseline-state',center.execution?.action_completion_rate===undefined?'PRIVADO':center.execution?.action_completion_rate===null?'INSUFICIENTE':'EM FORMAÇÃO');
  set('action-completion',pct(center.execution?.action_completion_rate));
}

function renderAssurance(release){
  setState('quality-gate',release.assurance?.quality_gate);
  const grid=document.getElementById('audit-grid'); grid.replaceChildren();
  const assurance=release.assurance||{};
  const preferred=['security_10x','observability_10x','architecture_20x','official_brand']; const assuranceLabels={security_10x:'Segurança 10X',observability_10x:'Observabilidade 10X',architecture_20x:'Arquitetura 20X',official_brand:'Marca oficial'};
  for(const k of preferred){ if(!(k in assurance)) continue; const x=document.createElement('div'); const s=document.createElement('span'); const b=document.createElement('b'); s.textContent=assuranceLabels[k]||k.replaceAll('_',' '); b.textContent=label(assurance[k]); x.append(s,b); grid.appendChild(x); }
  const entries=Object.entries(assurance).filter(([k])=>k!=='quality_gate'); const approved=entries.filter(([,v])=>String(v).toLowerCase()==='approved').length;
  const summary=document.createElement('div'); summary.className='assurance-summary'; const s=document.createElement('span'); const b=document.createElement('b'); s.textContent='GARANTIAS'; b.textContent=approved+'/'+entries.length+' APROVADAS'; summary.append(s,b); grid.appendChild(summary); set('assurance-score',approved+'/'+entries.length);
  const rail=grid.closest('.risk-rail'); if(rail) rail.title=entries.map(([k,v])=>k.replaceAll('_',' ')+': '+label(v)).join(' | ');
}
const sourcePaths={status:'/private-api/status',health:'/private-api/health',release:'/private-api/release',config:'/private-api/config?view=closure_status',agent:'/private-api/agent/status?summary=1'};
async function fetchSource(path){
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),7000);
  try{const r=await fetch(path,{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error(String(r.status));return await r.json();}finally{clearTimeout(timer);}
}
const channelLabels={whatsapp:'WhatsApp',tik_tok:'TikTok',tiktok:'TikTok',youtube:'YouTube',linked_in:'LinkedIn',linkedin:'LinkedIn'};
function channelLabel(name){const key=String(name||'').toLowerCase();return channelLabels[key]||String(name||'').replaceAll('_',' ');}
function renderChannels(config={}){
  const fronts=config.distribution?.fronts||config.channels||{}; const entries=Object.entries(fronts); const grid=document.getElementById('channel-grid'); if(grid)grid.replaceChildren();
  let operational=0,automated=0,assisted=0;
  for(const [name,data] of entries){
    const ready=data.operational_ready!==false; if(ready)operational++; const direct=Boolean(data.automation_ready||data.api_configured); if(ready&&direct)automated++; else if(ready)assisted++;
    if(grid){const row=document.createElement('div');const n=document.createElement('span');const b=document.createElement('b');const direct=Boolean(data.automation_ready||data.api_configured);n.textContent=channelLabel(name);b.textContent=!ready?'OPERAÇÃO INDISPONÍVEL':direct?'OPERAÇÃO ATIVA · DIRETA':'OPERAÇÃO ATIVA · ASSISTIDA';b.dataset.state=ready?'ready':'blocked';row.title=ready?(direct?'Operacional com automação direta de provider/API.':'Operacional por rota assistida/contingência; não representa bloqueio da frente.'):'Frente operacional indisponível.';row.append(n,b);grid.appendChild(row);}
  }
  return {total:entries.length,operational,automated,assisted};
}
function renderCoverage(config,ok,total){
  const c=renderChannels(config||{}); const complete=c.total>0&&c.operational===c.total;
  set('coverage-score',c.total?c.operational+'/'+c.total:'—'); set('coverage-state',complete?'TOTAL':'PARCIAL');
  const state=document.getElementById('coverage-state');if(state)state.dataset.state=complete?'ready':'blocked';
  set('coverage-copy',c.total?c.operational+'/'+c.total+' frentes operacionais · '+c.automated+' diretas · '+c.assisted+' assistidas':'Cobertura ainda não carregada.');
  set('source-health',ok+'/'+total+' fontes de telemetria online');
}
function renderPublicOperations(status={},config={},agent={}){
  const root=document.getElementById('live-operations'); if(!root)return; root.replaceChildren();
  const rows=[]; const when=status.last_event_at||new Date().toISOString(); const metrics=status.metrics||{}; const pipe=status.command_center?.pipeline?.open??metrics.pipeline_open??0;
  const auto=agent.autopilot||{}; rows.push({time:auto.last_cycle_at||when,title:'Autopilot não comercial',sub:(auto.cycles_24h||0)+' ciclo(s) 24h · '+(auto.program_drafts||0)+' programa(s) em rascunho · vendas OFF',state:Number(auto.cycles_24h)>0?'done':'waiting'});
  rows.push({time:new Date().toISOString(),title:'Pipeline monitorado',sub:fmt(pipe)+' oportunidade(s) aberta(s) · '+fmt(metrics.checkouts_started)+' checkout(s)',state:Number(pipe)>0?'running':'done'});
  rows.push({time:new Date().toISOString(),title:'Motor de IA',sub:fmt(agent.running)+' executando · '+fmt(agent.queued)+' na fila · '+fmt(agent.failed)+' falha(s)',state:Number(agent.failed)>0?'failed':Number(agent.running)>0?'running':'done'});
  const fronts=config.distribution?.fronts||{}; const total=Object.keys(fronts).length; const ready=Object.values(fronts).filter(x=>x.operational_ready!==false).length;
  if(total)rows.push({time:new Date().toISOString(),title:'Frentes comerciais',sub:ready+'/'+total+' operacionais · vendas permanecem sob governança',state:ready===total?'done':'waiting'});
  for(const r of rows.slice(0,4)){const row=document.createElement('article');row.className='live-op-row';row.dataset.liveState=r.state;const time=document.createElement('time');time.textContent=liveTime(r.time);const body=document.createElement('div');const b=document.createElement('b');const small=document.createElement('small');b.textContent=r.title;small.textContent=r.sub;body.append(b,small);const badge=document.createElement('span');badge.className='live-state';badge.textContent=r.state==='done'?'OK':r.state==='running'?'ATIVO':r.state==='failed'?'ATENÇÃO':'AGUARDA';row.append(time,body,badge);root.appendChild(row);}
  const hasProof=(Array.isArray(agent.autopilot?.timeline)&&agent.autopilot.timeline.length)||(Array.isArray(agent.activity_timeline)&&agent.activity_timeline.length); set('live-connection-state',hasProof?'PROVA REAL':'SEM PROVA'); const x=document.getElementById('live-connection-state');if(x)x.dataset.state=hasProof?'ready':'blocked';
  set('live-awaiting',fmt((config.commercial_blockers||[]).length)); const button=document.getElementById('connect-live');if(button)button.textContent='Detalhar';
}

const stageLabels={cycle_started:'Ciclo iniciado',subject_selected:'Tema selecionado',market_collected:'Pesquisa consolidada',program_candidate_created:'Programa candidato criado',creatives_evaluated:'Criativos avaliados',cycle_completed:'Ciclo concluído'};
function renderLiveProof(agent={}){
  const auto=agent.autopilot||{}, traces=Array.isArray(auto.timeline)?auto.timeline:[], activity=Array.isArray(agent.activity_timeline)?agent.activity_timeline:[], timeline=[...traces.map(x=>({...x,kind:'autopilot_trace'})),...activity].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const latest=timeline[0]||null;
  const marketEvents=timeline.filter(x=>x.stage==='market_collected'||x.title==='market_research'||x.kind==='intelligence');
  const creativeEvents=timeline.filter(x=>x.stage==='creatives_evaluated'||x.stage==='program_candidate_created'||String(x.title||'').toLowerCase().includes('creative'));
  const evidenceTotal=marketEvents.reduce((sum,x)=>sum+Number(x.evidence_count??x.details?.verified_sources??0),0);
  setState('engine-auto',auto.enabled&&Number(auto.cycles_24h||0)>0?'active':'not_approved');
  setState('market-monitor',marketEvents.length?'active':'blocked');
  setState('creative-monitor',creativeEvents.length?'active':'blocked');
  set('evidence-monitor',marketEvents.length?fmt(evidenceTotal)+' provas':'SEM PROVA');
  set('live-proof-routine',auto.enabled?'ATIVA · '+fmt(auto.cadence_minutes)+' MIN':'SEM PROVA');
  set('live-proof-cycle',latest?.cycle_id||auto.latest?.cycle_id||'HISTÓRICO REAL'); set('live-proof-trace',latest?.trace_id?String(latest.trace_id).slice(0,13)+'…':latest?.id?String(latest.id).slice(0,13)+'…':'SEM PROVA');
  const next=new Date(); next.setMinutes(0,0,0); next.setHours(next.getHours()+1); set('live-proof-next',next.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}));
  const routine=document.getElementById('routine-24h'); if(routine){routine.replaceChildren(); const now=new Date(); const completed=new Set(timeline.filter(x=>x.stage==='cycle_completed').map(x=>new Date(x.created_at).getHours())); for(let i=23;i>=0;i--){const d=new Date(now.getTime()-i*3600000), cell=document.createElement('div');cell.className='routine-slot';cell.dataset.done=String(completed.has(d.getHours()));cell.title=(completed.has(d.getHours())?'Ciclo comprovado · ':'Sem ciclo concluído neste recorte · ')+d.toLocaleString('pt-BR');cell.innerHTML='<span>'+String(d.getHours()).padStart(2,'0')+'h</span><b>'+(completed.has(d.getHours())?'✓':'·')+'</b>';routine.appendChild(cell);}}
  const root=document.getElementById('proof-timeline'); if(!root)return; root.replaceChildren(); if(!timeline.length){const e=document.createElement('div');e.className='live-empty';e.textContent='SEM PROVA — nenhum trace real retornado';root.appendChild(e);return;}
  const kindLabels={agent_run:'Execução de agente',intelligence:'Inteligência / pesquisa',channel_outbox:'Canal / provider',autopilot_trace:'Autopilot'};
  for(const x of timeline.slice(0,18)){const row=document.createElement('article');row.className='proof-row';const t=document.createElement('time');t.textContent=liveTime(x.created_at);const body=document.createElement('div');const b=document.createElement('b');b.textContent=stageLabels[x.stage]||x.title||kindLabels[x.kind]||'Evento comprovado';const small=document.createElement('small');const d=x.details||{};small.textContent=[x.cycle_id,d.subject||x.subject,d.verified_sources!=null?d.verified_sources+' fontes':x.evidence_count!=null?x.evidence_count+' evidências':null,d.candidate_id,x.destination,x.provider,x.confirmation_status,x.state,x.attempts?x.attempts+' tentativa(s)':null,d.best_channel,d.accepted_channels!=null?d.accepted_channels+'/5 canais elite':null,d.rejected_channels?d.rejected_channels+' em revisão':null,d.quality_score!=null?'Q '+Number(d.quality_score).toFixed(2):x.score!=null?'score '+Number(x.score).toFixed(2):null].filter(Boolean).join(' · ');body.append(b,small);const proof=document.createElement('span');proof.className='proof-id';const pid=x.run_id||x.id;proof.textContent=pid?String(pid).slice(0,8):'SEM ID';row.append(t,body,proof);root.appendChild(row);}
}

async function refresh(){
  const healthLabel=document.getElementById('health-label'); const entries=Object.entries(sourcePaths); const settled=await Promise.allSettled(entries.map(([,path])=>fetchSource(path)));
  const data={}; let ok=0; settled.forEach((r,i)=>{if(r.status==='fulfilled'){data[entries[i][0]]=r.value;ok++;}}); const {status,health,release,config,agent}=data;
  if(status){
    set('gate',status.gate||'SEM GATE');set('experiment',status.experiment?.id||'SEM EXPERIMENTO');document.querySelectorAll('[data-kpi]').forEach(el=>el.textContent=fmt(status.metrics?.[el.dataset.kpi]));
    renderPriorities(status.command_center||{});renderPipeline(status.command_center||{},status.metrics?.pipeline_open);setState('structure-ready',status.sales_machine?.structure_ready);setState('crm',status.sales_machine?.crm);setState('follow-up',status.sales_machine?.follow_up);setState('unit-economics',status.sales_machine?.unit_economics);setState('learning',status.sales_machine?.learning);setState('outbound',status.sales_machine?.outbound_execution);setState('engine-auto',status.engine?.commercial_autonomy);setState('telemetry',status.runtime?.telemetry);
    const economics=status.economics;set('economics-state',economics?'DADOS REAIS':'SEM BASELINE');set('gross-revenue',economics?money(economics.gross_revenue_brl):'SEM BASELINE');set('refunds-value',economics?money(economics.refunds_brl):'SEM BASELINE');set('paid-orders',economics?fmt(economics.paid_orders):fmt(status.metrics?.payments_confirmed));setState('checkout',status.runtime?.checkout);setState('financial',status.runtime?.financial);set('last-event',status.last_event_at?new Date(status.last_event_at).toLocaleString('pt-BR'):'SEM EVENTO');
  }
  if(health){setState('health-ready',health.ready);setState('db-state',health.checks?.database_reachable);setState('schema-state',health.schema?.ready);setState('domain-state',health.checks?.public_base_url_valid);const rt=Number(health.schema?.required_tables)||0,rm=Number(health.schema?.required_migrations)||0,mt=Array.isArray(health.schema?.missing_tables)?health.schema.missing_tables.length:Number(health.schema?.missing_tables_count||0),mm=Array.isArray(health.schema?.missing_migrations)?health.schema.missing_migrations.length:Number(health.schema?.missing_migrations_count||0);set('schema-tables',rt?Math.max(0,rt-mt)+'/'+rt:'NÃO EXPOSTO');set('schema-migrations',rm?Math.max(0,rm-mm)+'/'+rm:'NÃO EXPOSTO');const switches=document.getElementById('switches');switches.replaceChildren();const switchLabels={SALE_GLOBALLY_ENABLED:'Vendas globais',PRE_SALE_GATES_APPROVED:'Gates pré-venda',CHECKOUT_ENABLED:'Checkout',WHATSAPP_SALES_ENABLED:'Vendas WhatsApp',FINANCIAL_EVENTS_ENABLED:'Eventos financeiros'};const switchEntries=Object.entries(health.commercial_switches||{});const controls=health.commercial_controls;set('commercial-score',switchEntries.length?switchEntries.filter(([,v])=>v===true).length+'/'+switchEntries.length:controls?controls.enabled+'/'+controls.total:'0/5');if(!switchEntries.length&&controls){const x=document.createElement('div'),a=document.createElement('span'),b=document.createElement('b');a.textContent='Controles públicos';b.textContent='PROTEGIDOS';x.append(a,b);switches.appendChild(x);}switchEntries.forEach(([k,v])=>{const x=document.createElement('div'),a=document.createElement('span'),b=document.createElement('b');a.textContent=switchLabels[k]||k.replaceAll('_',' ');b.textContent=v?'ON':'OFF';x.dataset.enabled=String(v);x.append(a,b);switches.appendChild(x);});}
  if(release){setState('sales-mode',release.sales_mode);set('release-id',release.release_id||'NÃO EXPOSTO');set('branch',release.deployment?.branch||'EDGE');set('commit',release.deployment?.commit_sha?release.deployment.commit_sha.slice(0,10):'NÃO EXPOSTO');set('environment',release.deployment?.environment?label(release.deployment.environment):'EDGE');set('dr-mode',release.recovery?.mode?label(release.recovery.mode):'NÃO EXPOSTO');set('dr-persistent',release.recovery?.persistent_changes===false?'NÃO':'NÃO EXPOSTO');renderAssurance(release);}
  if(config){const blockers=Array.isArray(config.commercial_blockers)?config.commercial_blockers:[];const commercialReady=config.commercial_enabled===true&&release?.sales_mode!=='globally-blocked';set('blocker-count',fmt(blockers.length));set('readiness-state',commercialReady?'PRONTA':'BLOQUEADA');set('commercial-summary',commercialReady?'PRONTA':'BLOQUEADA');setState('whatsapp',config.whatsapp_enabled);}
  if(agent){set('agent-provider',agent.ai_provider?label(agent.ai_provider):'NÃO EXPOSTO');set('agent-queued',fmt(agent.queued));set('agent-running',fmt(agent.autopilot?.cycles_24h??agent.runs_24h));set('agent-activity-label',agent.autopilot?'ciclos autônomos 24h':'execuções 24h');set('agent-blocked',fmt(agent.blocked));set('agent-failed',fmt(agent.failed));set('agent-runs',fmt(agent.runs_24h));setState('agent-commercial',agent.commercial_execution);}
  renderCoverage(config,ok,entries.length);renderPublicOperations(status,config,agent);set('updated-at',new Date().toLocaleTimeString('pt-BR'));set('surface-host',location.host+' · produção');
  const market=(agent?.activity_timeline||[]).find(x=>x.kind==='intelligence'&&x.title==='market_research');
  const marketSummary=agent?.market_research_summary||market;
  const releaseProof=/^[0-9a-f]{40}$/i.test(release?.deployment?.commit_sha||'')&&release?.deployment?.environment==='production'&&release?.deployment?.branch==='main';
  const evidenceProof=Number(marketSummary?.evidence_count||0)>=5&&Number(marketSummary?.organization_count||0)>=4;
  const platformProof=Boolean(health?.checks?.database_reachable&&health?.schema?.ready&&health?.checks?.public_base_url_valid);
  const autonomyProof=Boolean(agent?.autopilot?.enabled&&agent?.autopilot?.health==='HEALTHY'&&Number(agent?.autopilot?.cycles_24h||0)>0&&Number(agent?.failed||0)===0);
  const telemetryProof=ok===entries.length; const proofs=[releaseProof,evidenceProof,platformProof,autonomyProof,telemetryProof]; const passed=proofs.filter(Boolean).length; const elite=passed===proofs.length;
  healthLabel.textContent=elite?'100% SENIOR ELITE':passed+'/'+proofs.length+' PROVAS';
  healthLabel.dataset.certified=elite?'true':'false';
  healthLabel.setAttribute('aria-label',elite?'99%+ confiável, 100% Senior Elite':`Não certificado, ${passed} de ${proofs.length} provas`);
  healthLabel.title=elite?'99%+ confiável · 100% Senior Elite':`Não certificado · ${passed}/${proofs.length} provas`;
  document.getElementById('health-dot').classList.toggle('healthy',elite);document.getElementById('health-dot').classList.toggle('degraded',!elite);
}
const liveTime=(iso)=>{try{return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}catch{return '—';}};

async function resilientPrivateNavigation(anchor){
  if(!anchor)return;
  const target=anchor.getAttribute('href')||'/criativos',original=anchor.innerHTML;
  const resetNavigationState=()=>{anchor.dataset.navBusy='false';anchor.removeAttribute('aria-busy');anchor.innerHTML=original;};
  window.addEventListener('pageshow',resetNavigationState);
  anchor.addEventListener('click',async(event)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    if(anchor.dataset.navBusy==='true')return;
    anchor.dataset.navBusy='true';anchor.setAttribute('aria-busy','true');anchor.innerHTML='Conectando… <span>→</span>';
    let response=null;
    for(let attempt=0;attempt<3;attempt++){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2500);
      try{response=await fetch(target,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});if(response.ok||response.redirected)break;}catch{}
      finally{clearTimeout(timer);}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,350*(attempt+1)));
    }
    if(response?.redirected&&new URL(response.url).pathname==='/acesso'){location.assign('/acesso');return;}
    if(response?.ok){location.assign(target);return;}
    resetNavigationState();
    anchor.title='Conexão instável detectada. O painel foi preservado; tente novamente.';
    anchor.focus();
  });
}

resilientPrivateNavigation(document.getElementById('open-creative-center'));
const details=document.getElementById('details-dialog');
let proofCache=null,proofCacheAt=0,proofLoading=false;
async function loadLiveProof(){
  if(proofLoading)return; if(proofCache&&Date.now()-proofCacheAt<30000){renderLiveProof(proofCache);return;}
  proofLoading=true;set('live-proof-routine','CARREGANDO');
  try{proofCache=await fetchSource('/private-api/agent/status');proofCacheAt=Date.now();renderLiveProof(proofCache);}catch{set('live-proof-routine','INDISPONÍVEL');}finally{proofLoading=false;}
}
function openProof(){details?.showModal();requestAnimationFrame(()=>loadLiveProof());}
document.getElementById('open-details')?.addEventListener('click',openProof); document.getElementById('open-live-proof')?.addEventListener('click',openProof); document.getElementById('connect-live')?.addEventListener('click',openProof); document.getElementById('close-details')?.addEventListener('click',()=>details?.close()); details?.addEventListener('click',(e)=>{if(e.target===details)details.close();}); trackPageView(); refresh(); setInterval(refresh,45000);
