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
function renderPipeline(center){
  const f=center.pipeline?.observed_funnel||{};
  set('stage-new',fmt(f.new)); set('stage-contacted',fmt(f.contacted)); set('stage-qualified',fmt(f.qualified));
  set('stage-offer',fmt(f.offer_sent)); set('stage-checkout',fmt(f.checkout_started)); set('stage-paid',fmt(f.paid));
  const open=['new','contacted','qualified','offer_sent','checkout_started'].reduce((sum,key)=>sum+Number(f[key]||0),0); set('pipeline-signal',fmt(open));
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
async function refresh(){
  const healthLabel=document.getElementById('health-label');
  try{
    const responses=await Promise.all(['/api/status','/api/health','/api/release','/api/config','/api/agent/status'].map(path=>fetch(path,{cache:'no-store'})));
    if(responses.some(r=>!r.ok)) throw new Error('state_unavailable');
    const [status,health,release,config,agent]=await Promise.all(responses.map(r=>r.json()));
    set('gate',status.gate||'—'); set('experiment',status.experiment?.id||'—'); setState('sales-mode',release.sales_mode||config.production_mode);
    document.querySelectorAll('[data-kpi]').forEach(el=>el.textContent=fmt(status.metrics?.[el.dataset.kpi]));
    renderPriorities(status.command_center||{}); renderPipeline(status.command_center||{});
    setState('structure-ready',status.sales_machine?.structure_ready); setState('crm',status.sales_machine?.crm); setState('follow-up',status.sales_machine?.follow_up);
    setState('unit-economics',status.sales_machine?.unit_economics); setState('learning',status.sales_machine?.learning); setState('outbound',status.sales_machine?.outbound_execution); setState('engine-auto',status.engine?.commercial_autonomy);
    setState('health-ready',health.ready); setState('db-state',health.checks?.database_reachable); setState('schema-state',health.schema?.ready);
    const requiredTables=Number(health.schema?.required_tables)||15; const requiredMigrations=Number(health.schema?.required_migrations)||9; const missingTables=Array.isArray(health.schema?.missing_tables)?health.schema.missing_tables.length:Number.isFinite(Number(health.schema?.missing_tables_count))?Number(health.schema.missing_tables_count):requiredTables; const missingMigrations=Array.isArray(health.schema?.missing_migrations)?health.schema.missing_migrations.length:Number.isFinite(Number(health.schema?.missing_migrations_count))?Number(health.schema.missing_migrations_count):requiredMigrations;
    set('schema-tables',`${Math.max(0,requiredTables-missingTables)}/${requiredTables}`); set('schema-migrations',`${Math.max(0,requiredMigrations-missingMigrations)}/${requiredMigrations}`); setState('telemetry',status.runtime?.telemetry); setState('domain-state',health.checks?.public_base_url_valid);
    const economics=status.economics; set('economics-state',economics===undefined?'PRIVADO':economics?'DADOS REAIS':'SEM BASELINE'); set('gross-revenue',economics===undefined?'PRIVADO':economics?money(economics.gross_revenue_brl):'—');
    set('refunds-value',economics===undefined?'PRIVADO':economics?money(economics.refunds_brl):'—'); set('paid-orders',economics===undefined?'PRIVADO':economics?fmt(economics.paid_orders):'—');
    setState('checkout',status.runtime?.checkout); setState('financial',status.runtime?.financial); setState('whatsapp',config.whatsapp_enabled);
    const blockers=Array.isArray(config.commercial_blockers)?config.commercial_blockers:[]; set('blocker-count',fmt(blockers.length)); set('readiness-state',blockers.length?'BLOQUEADA':'PRONTA'); set('commercial-summary',blockers.length?'BLOQUEADA':'PRONTA');
    set('release-id',release.release_id||'—'); set('branch',release.deployment?.branch||'PRIVADO'); set('commit',release.deployment?.commit_sha?release.deployment.commit_sha.slice(0,10):'PRIVADO'); set('environment',release.deployment?.environment?label(release.deployment.environment):'PRIVADO');
    set('dr-mode',release.recovery?.mode?label(release.recovery.mode):'PRIVADO'); set('dr-persistent',release.recovery?.persistent_changes===false?'NÃO':'PRIVADO'); set('agent-provider',agent.ai_provider?label(agent.ai_provider):'PRIVADO'); set('agent-queued',fmt(agent.queued)); set('agent-running',fmt(agent.running)); set('agent-blocked',fmt(agent.blocked)); set('agent-failed',fmt(agent.failed)); set('agent-runs',fmt(agent.runs_24h)); setState('agent-commercial',agent.commercial_execution); renderAssurance(release);
    const switches=document.getElementById('switches'); switches.replaceChildren();
    const switchLabels={SALE_GLOBALLY_ENABLED:'Vendas globais',PRE_SALE_GATES_APPROVED:'Gates pré-venda',CHECKOUT_ENABLED:'Checkout',WHATSAPP_SALES_ENABLED:'Vendas WhatsApp',FINANCIAL_EVENTS_ENABLED:'Eventos financeiros'}; const switchEntries=Object.entries(health.commercial_switches||{}); const controls=health.commercial_controls; set('commercial-score',switchEntries.length?switchEntries.filter(([,v])=>v===true).length+'/'+switchEntries.length:controls?controls.enabled+'/'+controls.total:'—'); if(!switchEntries.length&&controls){const x=document.createElement('div');const a=document.createElement('span');const b=document.createElement('b');a.textContent='Controles públicos';b.textContent='PROTEGIDOS';x.append(a,b);switches.appendChild(x);} switchEntries.forEach(([k,v])=>{const x=document.createElement('div');const s=document.createElement('span');const b=document.createElement('b');s.textContent=switchLabels[k]||k.replaceAll('_',' ');b.textContent=v?'ON':'OFF';x.dataset.enabled=String(v);x.append(s,b);switches.appendChild(x);});
    const engineRail=document.querySelector('.engine-rail'); if(engineRail) engineRail.title='Outbound: '+label(status.sales_machine?.outbound_execution)+' | Autonomia: '+label(status.engine?.commercial_autonomy)+' | Fila: '+fmt(agent.queued)+' | Bloqueados: '+fmt(agent.blocked)+' | Falhas: '+fmt(agent.failed)+' | Runs 24h: '+fmt(agent.runs_24h);
    const infraRail=document.querySelector('.infra-rail'); if(infraRail) infraRail.title='Telemetria: '+label(status.runtime?.telemetry)+' | Domínio: '+label(health.checks?.public_base_url_valid)+' | Branch: '+(release.deployment?.branch||'—')+' | DR: '+label(release.recovery?.mode)+' | Persistência rollback: '+(release.recovery?.persistent_changes===false?'NÃO':'—');
    set('last-event',status.last_event_at===undefined?'PRIVADO':status.last_event_at?new Date(status.last_event_at).toLocaleString('pt-BR'):'sem evento'); set('updated-at',new Date().toLocaleTimeString('pt-BR'));
    set('surface-host',location.host+' · produção'); healthLabel.textContent='Operação conectada'; document.getElementById('health-dot').classList.add('healthy');
  }catch{
    healthLabel.textContent='Estado indisponível'; document.getElementById('health-dot').classList.remove('healthy');
  }
}

let liveOperatorToken='';
const liveStateLabel=(state)=>({planned:'PLANEJADO',awaiting_approval:'AGUARDANDO',executed:'EXECUTADO',failed:'FALHOU',blocked:'BLOQUEADO',canceled:'CANCELADO',running:'EXECUTANDO'}[String(state)]||String(state||'—').replaceAll('_',' ').toUpperCase());
const liveStateClass=(state)=>['executed','completed','internal_completed','external_effect_confirmed'].includes(String(state))?'done':['failed'].includes(String(state))?'failed':['blocked','canceled'].includes(String(state))?'blocked':['awaiting_approval','planned'].includes(String(state))?'waiting':'running';
const liveTime=(iso)=>{try{return new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}catch{return '—';}};
function renderLiveOperations(data={}){
  const root=document.getElementById('live-operations'); if(!root)return; root.replaceChildren();
  const plans=(data.live_action_plans||[]).slice().sort((a,b)=>new Date(b.updated_at||b.created_at||0)-new Date(a.updated_at||a.created_at||0)).slice(0,4);
  const rows=plans.length?plans:(data.runs||[]).slice(0,4).map(r=>({state:r.outcome,updated_at:r.created_at,what:r.action||r.job_type,where:r.tool||'interno',channel:null,objective:r.rationale,result:r.result}));
  if(!rows.length){const e=document.createElement('div');e.className='live-empty';e.textContent='Nenhuma execução registrada neste momento.';root.appendChild(e);}
  for(const p of rows){
    const row=document.createElement('article'); row.className='live-op-row'; row.dataset.liveState=liveStateClass(p.state);
    const time=document.createElement('time');time.textContent=liveTime(p.updated_at||p.created_at);
    const body=document.createElement('div');const title=document.createElement('b');const sub=document.createElement('small');
    title.textContent=`${String(p.what||'ação').replaceAll('_',' ')} · ${String(p.channel||p.where||'interno').replace('channel:','')}`;
    sub.textContent=String(p.objective||p.why||'Execução registrada sem descrição adicional.').slice(0,120);body.append(title,sub);
    const state=document.createElement('span');state.className='live-state';state.textContent=liveStateLabel(p.state);row.append(time,body,state);root.appendChild(row);
  }
  const jobs=data.jobs||[];const running=jobs.filter(x=>x.status==='running').length;const awaiting=(data.live_action_plans||[]).filter(x=>x.state==='awaiting_approval').length;
  set('live-running',fmt(running));set('live-awaiting',fmt(awaiting));
  const latest=rows[0];set('live-last-result',latest?liveStateLabel(latest.state):'SEM EXECUÇÃO');
  set('live-connection-state','AO VIVO');const state=document.getElementById('live-connection-state');if(state)state.dataset.state='ready';
  const button=document.getElementById('connect-live');if(button)button.textContent='Reconectar';
}
async function fetchLiveOperations(token=liveOperatorToken){
  const r=await fetch('/api/robot-control?limit=24',{headers:{authorization:`Bearer ${token}`},cache:'no-store'});
  if(!r.ok)throw new Error(r.status===401?'Token inválido ou ausente.':'Telemetria operacional indisponível.');
  return r.json();
}
async function refreshLiveOperations(){if(!liveOperatorToken)return;try{renderLiveOperations(await fetchLiveOperations());}catch{set('live-connection-state','RECONEXÃO');}}
const liveAuth=document.getElementById('live-auth-dialog');
document.getElementById('connect-live')?.addEventListener('click',()=>{set('live-auth-error','');liveAuth?.showModal();});
document.getElementById('live-auth-submit')?.addEventListener('click',async e=>{e.preventDefault();const input=document.getElementById('live-operator-token');const token=String(input?.value||'').trim();if(!token){set('live-auth-error','Informe o token do operador.');return;}try{const data=await fetchLiveOperations(token);liveOperatorToken=token;if(input)input.value='';renderLiveOperations(data);liveAuth?.close();}catch(error){set('live-auth-error',String(error?.message||'Falha de autenticação.'));}});
setInterval(refreshLiveOperations,5000);

const details=document.getElementById('details-dialog'); document.getElementById('open-details')?.addEventListener('click',()=>details?.showModal()); document.getElementById('close-details')?.addEventListener('click',()=>details?.close()); details?.addEventListener('click',(e)=>{if(e.target===details)details.close();}); trackPageView(); refresh(); setInterval(refresh,30000);
