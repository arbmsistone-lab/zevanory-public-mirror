const label=(v)=>({approved:'APROVADO',not_approved:'NÃO APROVADA',active:'ATIVA',disabled:'DESATIVADO','sandbox-disabled':'SANDBOX DESATIVADO','globally-blocked':'BLOQUEADO GLOBALMENTE','pre-sale-blocked':'PRÉ-VENDA BLOQUEADA','technical_ready_commercial_not_started':'PRONTO TÉCNICO'})[v]||String(v??'—').replaceAll('_',' ').toUpperCase();
async function refreshStatus(){
  const health=document.getElementById('health-label');
  try{
    const [r,releaseResponse,configResponse]=await Promise.all([fetch('/api/status',{cache:'no-store'}),fetch('/api/release',{cache:'no-store'}),fetch('/api/config',{cache:'no-store'})]);
    if(!r.ok||!releaseResponse.ok||!configResponse.ok) throw new Error('operational_state_unavailable');
    const [s,release,config]=await Promise.all([r.json(),releaseResponse.json(),configResponse.json()]);
    document.getElementById('gate').textContent=s.gate||'—';
    document.getElementById('experiment').textContent=s.experiment?.id||'—';
    document.getElementById('engine-tech').textContent=label(s.engine?.technical_infrastructure);
    document.getElementById('engine-auto').textContent=label(s.engine?.commercial_autonomy);
    document.getElementById('telemetry').textContent=label(s.runtime?.telemetry);
    document.getElementById('financial').textContent=label(s.runtime?.financial);
    document.getElementById('checkout').textContent=label(s.runtime?.checkout);
    document.querySelectorAll('[data-kpi]').forEach(el=>el.textContent=Number(s.metrics?.[el.dataset.kpi]||0).toLocaleString('pt-BR'));
    document.getElementById('last-event').textContent=s.last_event_at?new Date(s.last_event_at).toLocaleString('pt-BR'):'sem evento';
    document.getElementById('release-id').textContent=release.release_id||'—';
    document.getElementById('sales-mode').textContent=config.commercial_enabled?'HABILITADAS':label(release.sales_mode||config.production_mode);
    health.textContent='Estado operacional conectado';
    document.getElementById('health-dot').classList.add('healthy');
  }catch(e){
    health.textContent='Estado operacional indisponível';
    document.getElementById('health-dot').classList.remove('healthy');
  }
}
refreshStatus(); setInterval(refreshStatus,30000);
