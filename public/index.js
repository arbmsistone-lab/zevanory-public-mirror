const fmt=(v)=>Number(v||0).toLocaleString('pt-BR');
const money=(v)=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const pct=(v)=>v===null||v===undefined?'SEM BASELINE':`${(Number(v)*100).toFixed(1)}%`;
const labels={approved:'APROVADO',ready:'PRONTO',active:'ATIVA',blocked:'BLOQUEADO',disabled:'DESATIVADO',true:'PRONTO',false:'BLOQUEADO','not_approved':'NÃO APROVADA','globally-blocked':'BLOQUEADO GLOBALMENTE','technical_ready_commercial_not_started':'PRONTO TÉCNICO','transactional-rollback':'ROLLBACK TESTADO','baseline_required':'BASELINE NECESSÁRIO','rules_based':'REGRAS SEGURAS'};
const label=(v)=>labels[String(v)]||String(v??'—').replaceAll('_',' ').toUpperCase();
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
const setState=(id,value)=>{set(id,label(value));const el=document.getElementById(id);if(el)el.dataset.state=String(value);};

function renderPriorities(center){
  set('overdue-actions',fmt(center.work_queue?.overdue));
  set('due-24h',fmt(center.work_queue?.due_24h));
  set('blocked-actions',fmt(center.work_queue?.blocked));
  set('missing-next-action',fmt(center.risk?.missing_next_action));
  set('stale-leads',fmt(center.risk?.stale_open_leads));
  setState('nba-mode',center.execution?.next_best_action_mode);
  const pressure=Number(center.work_queue?.pressure||0); set('queue-pressure',pressure?`${pressure} ATENÇÕES`:'FILA SAUDÁVEL'); set('queue-pressure-value',fmt(pressure));
}
function renderPipeline(center){
  const f=center.pipeline?.observed_funnel||{};
  set('stage-new',fmt(f.new)); set('stage-contacted',fmt(f.contacted)); set('stage-qualified',fmt(f.qualified));
  set('stage-offer',fmt(f.offer_sent)); set('stage-checkout',fmt(f.checkout_started)); set('stage-paid',fmt(f.paid));
  const open=['new','contacted','qualified','offer_sent','checkout_started'].reduce((sum,key)=>sum+Number(f[key]||0),0); set('pipeline-signal',fmt(open));
  setState('forecast-mode',center.execution?.forecast_mode);
  set('predictive-forecast',center.execution?.predictive_forecast_available?'ATIVO':'BLOQUEADO SEM BASELINE');
  set('baseline-state',center.execution?.action_completion_rate===null?'INSUFICIENTE':'EM FORMAÇÃO');
  set('action-completion',pct(center.execution?.action_completion_rate));
}

function renderAssurance(release){
  setState('quality-gate',release.assurance?.quality_gate);
  const grid=document.getElementById('audit-grid'); grid.replaceChildren();
  const assurance=release.assurance||{};
  const preferred=['security_10x','observability_10x','dr_10x','architecture_20x','official_brand','rules_audit_20x'];
  for(const k of preferred){ if(!(k in assurance)) continue; const x=document.createElement('div'); const s=document.createElement('span'); const b=document.createElement('b'); s.textContent=k.replaceAll('_',' '); b.textContent=label(assurance[k]); x.append(s,b); grid.appendChild(x); }
  const entries=Object.entries(assurance).filter(([k])=>k!=='quality_gate'); const approved=entries.filter(([,v])=>String(v).toLowerCase()==='approved').length;
  const summary=document.createElement('div'); summary.className='assurance-summary'; const s=document.createElement('span'); const b=document.createElement('b'); s.textContent='GARANTIAS'; b.textContent=approved+'/'+entries.length+' APROVADAS'; summary.append(s,b); grid.appendChild(summary);
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
    const requiredTables=Number(health.schema?.required_tables)||15; const requiredMigrations=Number(health.schema?.required_migrations)||9; const missingTables=Array.isArray(health.schema?.missing_tables)?health.schema.missing_tables.length:requiredTables; const missingMigrations=Array.isArray(health.schema?.missing_migrations)?health.schema.missing_migrations.length:requiredMigrations;
    set('schema-tables',`${Math.max(0,requiredTables-missingTables)}/${requiredTables}`); set('schema-migrations',`${Math.max(0,requiredMigrations-missingMigrations)}/${requiredMigrations}`); setState('telemetry',status.runtime?.telemetry); setState('domain-state',health.checks?.public_base_url_valid);
    const economics=status.economics; set('economics-state',economics?'DADOS REAIS':'SEM BASELINE'); set('gross-revenue',economics?money(economics.gross_revenue_brl):'—');
    set('refunds-value',economics?money(economics.refunds_brl):'—'); set('paid-orders',economics?fmt(economics.paid_orders):'—');
    setState('checkout',status.runtime?.checkout); setState('financial',status.runtime?.financial); setState('whatsapp',config.whatsapp_enabled);
    const blockers=Array.isArray(config.commercial_blockers)?config.commercial_blockers:[]; set('blocker-count',fmt(blockers.length)); set('readiness-state',blockers.length?'BLOQUEADA':'PRONTA');
    set('release-id',release.release_id||'—'); set('branch',release.deployment?.branch||'—'); set('commit',release.deployment?.commit_sha?release.deployment.commit_sha.slice(0,10):'—'); set('environment',label(release.deployment?.environment));
    set('dr-mode',label(release.recovery?.mode)); set('dr-persistent',release.recovery?.persistent_changes===false?'NÃO':'—'); set('agent-provider',label(agent.ai_provider)); set('agent-queued',fmt(agent.queued)); set('agent-running',fmt(agent.running)); set('agent-blocked',fmt(agent.blocked)); set('agent-failed',fmt(agent.failed)); set('agent-runs',fmt(agent.runs_24h)); setState('agent-commercial',agent.commercial_execution); renderAssurance(release);
    const switches=document.getElementById('switches'); switches.replaceChildren();
    Object.entries(health.commercial_switches||{}).forEach(([k,v])=>{const x=document.createElement('div');const s=document.createElement('span');const b=document.createElement('b');s.textContent=k.replaceAll('_',' ');b.textContent=v?'ON':'OFF';x.dataset.enabled=String(v);x.append(s,b);switches.appendChild(x);});
    set('last-event',status.last_event_at?new Date(status.last_event_at).toLocaleString('pt-BR'):'sem evento'); set('updated-at',new Date().toLocaleTimeString('pt-BR'));
    healthLabel.textContent='Operação conectada'; document.getElementById('health-dot').classList.add('healthy');
  }catch{
    healthLabel.textContent='Estado indisponível'; document.getElementById('health-dot').classList.remove('healthy');
  }
}
refresh(); setInterval(refresh,30000);
