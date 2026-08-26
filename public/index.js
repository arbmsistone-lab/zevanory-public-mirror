const fmt=(v)=>Number(v||0).toLocaleString('pt-BR');
const money=(v)=>Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const label=(v)=>({approved:'APROVADO',ready:'PRONTO',active:'ATIVA',blocked:'BLOQUEADO',disabled:'DESATIVADO',true:'PRONTO',false:'BLOQUEADO','not_approved':'NÃO APROVADA','globally-blocked':'BLOQUEADO GLOBALMENTE','technical_ready_commercial_not_started':'PRONTO TÉCNICO','transactional-rollback':'ROLLBACK TESTADO'})[String(v)]||String(v??'—').replaceAll('_',' ').toUpperCase();
const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
const setState=(id,value)=>{set(id,label(value));const el=document.getElementById(id);if(el)el.dataset.state=String(value);};

async function refresh(){
  const healthLabel=document.getElementById('health-label');
  try{
    const responses=await Promise.all(['/api/status','/api/health','/api/release','/api/config'].map(path=>fetch(path,{cache:'no-store'})));
    if(responses.some(r=>!r.ok)) throw new Error('state_unavailable');
    const [status,health,release,config]=await Promise.all(responses.map(r=>r.json()));
    set('gate',status.gate||'—'); set('experiment',status.experiment?.id||'—');
    setState('sales-mode',release.sales_mode||config.production_mode);
    document.querySelectorAll('[data-kpi]').forEach(el=>el.textContent=fmt(status.metrics?.[el.dataset.kpi]));
    setState('structure-ready',status.sales_machine?.structure_ready);
    setState('crm',status.sales_machine?.crm); setState('follow-up',status.sales_machine?.follow_up);
    setState('unit-economics',status.sales_machine?.unit_economics); setState('learning',status.sales_machine?.learning);
    setState('outbound',status.sales_machine?.outbound_execution); setState('engine-auto',status.engine?.commercial_autonomy);    setState('health-ready',health.ready); setState('db-state',health.checks?.database_reachable);
    setState('schema-state',health.schema?.ready); set('schema-tables',`${health.schema?.required_tables||0}/7`); set('schema-migrations',`${health.schema?.required_migrations||0}/6`);
    setState('telemetry',status.runtime?.telemetry); setState('domain-state',health.checks?.public_base_url_valid);
    const economics=status.economics;
    set('economics-state',economics?'DADOS REAIS':'SEM BASELINE'); set('gross-revenue',economics?money(economics.gross_revenue_brl):'—');
    set('refunds-value',economics?money(economics.refunds_brl):'—'); set('paid-orders',economics?fmt(economics.paid_orders):'—');
    setState('checkout',status.runtime?.checkout); setState('financial',status.runtime?.financial); setState('whatsapp',config.whatsapp_enabled);
    set('release-id',release.release_id||'—'); set('branch',release.deployment?.branch||'—');
    set('commit',release.deployment?.commit_sha?release.deployment.commit_sha.slice(0,10):'—'); set('environment',label(release.deployment?.environment));
    set('dr-mode',label(release.recovery?.mode)); set('dr-persistent',release.recovery?.persistent_changes===false?'NÃO':'—');
    setState('quality-gate',release.assurance?.quality_gate);
    const grid=document.getElementById('audit-grid'); grid.replaceChildren();
    Object.entries(release.assurance||{}).filter(([k])=>k!=='quality_gate').forEach(([k,v])=>{const x=document.createElement('div');x.innerHTML=`<span>${k.replaceAll('_',' ')}</span><b>${label(v)}</b>`;grid.appendChild(x);});
    const switches=document.getElementById('switches'); switches.replaceChildren();
    Object.entries(health.commercial_switches||{}).forEach(([k,v])=>{const x=document.createElement('div');x.innerHTML=`<span>${k.replaceAll('_',' ')}</span><b>${v?'ON':'OFF'}</b>`;x.dataset.enabled=String(v);switches.appendChild(x);});
    set('last-event',status.last_event_at?new Date(status.last_event_at).toLocaleString('pt-BR'):'sem evento'); set('updated-at',new Date().toLocaleTimeString('pt-BR'));
    healthLabel.textContent='Operação conectada'; document.getElementById('health-dot').classList.add('healthy');
  }catch{
    healthLabel.textContent='Estado indisponível'; document.getElementById('health-dot').classList.remove('healthy');
  }
}
refresh(); setInterval(refresh,30000);
