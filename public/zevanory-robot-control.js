const demo={mode:'demo',live_action_plans:[{manifest_id:'demo-plan',state:'planned',what:'publish_content',where:'channel:instagram',why:'DemonstraÃ§Ã£o de transparÃªncia prÃ©-execuÃ§Ã£o.',objective:'Mostrar intenÃ§Ã£o antes de qualquer efeito externo.',channel:'instagram',account_ref:'channel_account:instagram',content_or_offer:{kind:'content_preview',preview:'Exemplo de conteÃºdo; nÃ£o serÃ¡ publicado.'},risk:'commercial',cost:{currency:'USD',estimated_amount:null,mode:'not_estimated'},approval:{required:true,status:'pending'},expected_result:'PublicaÃ§Ã£o aceita pelo provedor apÃ³s aprovaÃ§Ã£o.',created_at:new Date().toISOString()}],generated_at:new Date().toISOString(),control:{paused:true,reason:'demo_safe_default'},gates:{sale:false,pre_sale:false,checkout:false,financial:false,whatsapp:false},channels:{zevanory:{configured:true},google:{configured:true},youtube:{configured:true},instagram:{configured:false},facebook:{configured:false},tiktok:{configured:false},whatsapp:{configured:false},email:{configured:false}},approvals:[],runs:[
{created_at:new Date(Date.now()-20e3).toISOString(),outcome:'completed',job_type:'knowledge_refresh',action:'review',tool:'search_knowledge',rationale:'Atualizou contexto para revisar posicionamento e evidÃªncias.',latency_ms:420,mode:'ai_assisted'},
{created_at:new Date(Date.now()-65e3).toISOString(),outcome:'completed',job_type:'lead_review',action:'qualify',tool:'remember_fact',rationale:'Classificou intenÃ§Ã£o sem executar aÃ§Ã£o externa.',latency_ms:180,mode:'deterministic'},
{created_at:new Date(Date.now()-120e3).toISOString(),outcome:'awaiting_approval',job_type:'offer_review',action:'publish_content',tool:'publish_content',rationale:'ConteÃºdo preparado; aÃ§Ã£o externa aguarda aprovaÃ§Ã£o humana.',latency_ms:91,mode:'ai_assisted'},
{created_at:new Date(Date.now()-210e3).toISOString(),outcome:'completed',job_type:'follow_up_plan',action:'follow_up',tool:'schedule_follow_up',rationale:'Agendou prÃ³xima aÃ§Ã£o reversÃ­vel no CRM.',latency_ms:133,mode:'deterministic'}],tools:[],jobs:[],outbox:[],actions:[]};
let operatorToken=''; let lastData=demo;
const $=(id)=>document.getElementById(id);
const stateClass=(s)=>s==='planned'?'planned':['completed','executed','internal_completed','external_effect_confirmed'].includes(s)?'completed':['failed','external_request_failed','external_effect_failed'].includes(s)?'failed':['running','external_request_pending','external_request_retry','external_request_unobserved','external_request_accepted'].includes(s)?'running':'blocked';
const fmtTime=(iso)=>new Date(iso).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});

function renderLiveActionPlans(data){
  const root=$('live-action-plans');root.replaceChildren();const plans=(data.live_action_plans||[]).slice(0,3);
  if(!plans.length){root.textContent='Nenhuma aÃ§Ã£o planejada neste momento.';return;}
  for(const p of plans){const card=document.createElement('div');card.className='live-plan';card.dataset.state=stateClass(p.state);const head=document.createElement('div');const title=document.createElement('b');const badge=document.createElement('span');title.textContent=`${String(p.what||'aÃ§Ã£o').replaceAll('_',' ')} â†’ ${p.where||'destino nÃ£o resolvido'}`;badge.className=`state ${stateClass(p.state)}`;badge.textContent=String(p.state||'planned').replaceAll('_',' ').toUpperCase();head.append(title,badge);const grid=document.createElement('div');grid.className='plan-grid';const fields=[['POR QUÃŠ',p.why],['OBJETIVO',p.objective],['CANAL',p.channel||'interno'],['CONTA',p.account_ref],['CONTEÃšDO/OFERTA',p.content_or_offer?.preview||p.content_or_offer?.offer_ref||p.content_or_offer?.order_ref||'â€”'],['RISCO',p.risk],['CUSTO',p.cost?.estimated_amount==null?'nÃ£o estimado':`${p.cost.currency||'USD'} ${p.cost.estimated_amount}`],['APROVAÃ‡ÃƒO',p.approval?.required?String(p.approval?.status||'required'):'nÃ£o exigida'],['RESULTADO ESPERADO',p.expected_result],['RESULTADO REAL',p.result?.reason||p.result?.status||(p.state==='executed'?'executado':'â€”')]];for(const [k,v] of fields){const x=document.createElement('div');const label=document.createElement('small');const val=document.createElement('span');label.textContent=k;val.textContent=String(v??'â€”');x.append(label,val);grid.appendChild(x);}card.append(head,grid);root.appendChild(card);}
}
function renderTimeline(data){
  const root=$('timeline'); root.replaceChildren();
  for(const r of data.runs||[]){
    const row=document.createElement('div'); row.className='event'; row.dataset.state=stateClass(r.execution_state||r.outcome);
    const t=document.createElement('time'); t.textContent=fmtTime(r.created_at);
    const dot=document.createElement('i'); dot.className='dot';
    const body=document.createElement('div'); const b=document.createElement('b'); const p=document.createElement('p');
    b.textContent=`${String(r.action||r.job_type||'aÃ§Ã£o').replaceAll('_',' ')} Â· ${r.tool||'sem ferramenta'}`;
    p.textContent=r.rationale||'Sem justificativa registrada.'; body.append(b,p);
    const meta=document.createElement('em'); meta.textContent=`${String(r.mode||'â€”').replaceAll('_',' ')} Â· ${Number(r.latency_ms||0)} ms`;
    row.append(t,dot,body,meta); root.appendChild(row);
  }
  if(!root.children.length) root.textContent='Nenhuma execuÃ§Ã£o registrada.';
}
const capabilityDefs=[['Pesquisar e analisar','knowledge_refresh'],['Criar estratÃ©gia e oferta','create_offer_draft'],['Criar criativos','creative_generation'],['Publicar conteÃºdo','publish_content'],['Captar e qualificar','lead_review'],['Responder clientes','send_message'],['Follow-up','schedule_follow_up'],['Checkout e pagamento','start_checkout'],['Entrega e pÃ³s-venda','fulfillment']];
function renderCapabilities(data){
  const root=$('capabilities'); root.replaceChildren(); const channels=data.channels||{};
  for(const [label,key] of capabilityDefs){
    let state='prepared',detail='Arquitetura preparada';
    if(['knowledge_refresh','create_offer_draft','lead_review','schedule_follow_up'].includes(key)){state='ready';detail='ExecuÃ§Ã£o interna disponÃ­vel';}
    if(key==='publish_content'){const connected=Object.entries(channels).some(([name,x])=>!['zevanory','google'].includes(name)&&x?.configured);state=connected?'prepared':'blocked';detail=connected?'Adapter disponÃ­vel; aprovaÃ§Ã£o e gate decidem':'Canais sociais nÃ£o conectados';}
    if(key==='send_message'){state=(channels.whatsapp?.configured||channels.email?.configured)?'prepared':'blocked';detail=state==='blocked'?'WhatsApp/e-mail nÃ£o conectados':'Destino + aprovaÃ§Ã£o + gate exigidos';}
    if(key==='start_checkout'){state=data.gates?.checkout?'prepared':'blocked';detail=data.gates?.checkout?'Comando financeiro exige aprovaÃ§Ã£o':'Checkout permanece bloqueado';}
    if(key==='fulfillment'){state='prepared';detail='Exige pagamento reconciliado antes da entrega';}
    if(key==='creative_generation'){state='prepared';detail='GeraÃ§Ã£o separada da publicaÃ§Ã£o';}
    const row=document.createElement('div'); row.className='cap';
    const box=document.createElement('div'); const b=document.createElement('b'); const small=document.createElement('small'); const badge=document.createElement('span');
    b.textContent=label; small.textContent=detail; box.append(b,small); badge.className=`state ${state}`; badge.textContent=state==='ready'?'ATIVO':state==='blocked'?'BLOQUEADO':'PREPARADO'; row.append(box,badge); root.appendChild(row);
  }
}
function renderGates(data){
  const root=$('gates'); root.replaceChildren(); const defs=[['Venda global','sale'],['PrÃ©-venda aprovada','pre_sale'],['Checkout','checkout'],['Eventos financeiros','financial'],['WhatsApp comercial','whatsapp']];
  for(const [label,key] of defs){const on=Boolean(data.gates?.[key]);const row=document.createElement('div');row.className='gate';const box=document.createElement('div');const b=document.createElement('b');const small=document.createElement('small');const badge=document.createElement('span');b.textContent=label;small.textContent=on?'Runtime autoriza; polÃ­ticas adicionais continuam vÃ¡lidas':'Fail-closed; aÃ§Ã£o externa nÃ£o pode avanÃ§ar';box.append(b,small);badge.className=`state ${on?'ready':'blocked'}`;badge.textContent=on?'ABERTO':'FECHADO';row.append(box,badge);root.appendChild(row);}
}
function renderJourney(){
  const root=$('journey');root.replaceChildren();const steps=[['01','Pesquisa','observa'],['02','EstratÃ©gia','decide'],['03','Criativo','produz'],['04','PublicaÃ§Ã£o','distribui'],['05','Lead','qualifica'],['06','Conversa','responde'],['07','Checkout','cobra'],['08','Entrega','cumpre'],['09','Aprendizado','ajusta']];
  for(const [n,name,verb] of steps){const x=document.createElement('div');x.className='step';const s=document.createElement('span');const b=document.createElement('b');const small=document.createElement('small');s.textContent=n;b.textContent=name;small.textContent=verb;x.append(s,b,small);root.appendChild(x);}
}
function renderHealth(data){
  const root=$('health');root.replaceChildren();const out=data.outbox||[];const retry=out.filter(x=>x.status==='retry').length,dead=out.filter(x=>x.status==='dead_letter').length,pending=out.filter(x=>['pending','processing'].includes(x.status)).length,failed=(data.runs||[]).filter(x=>x.outcome==='failed').length;
  const rows=[['Outbox pendente',pending,pending?'running':'ready'],['Retries',retry,retry?'blocked':'ready'],['Dead-letter',dead,dead?'failed':'ready'],['Runs com falha',failed,failed?'failed':'ready']];
  for(const [label,val,state] of rows){const row=document.createElement('div');row.className='health-row';const box=document.createElement('div');const b=document.createElement('b');const small=document.createElement('small');const badge=document.createElement('span');b.textContent=label;small.textContent=val?`${val} ocorrÃªncia(s) exigem atenÃ§Ã£o`:'Nenhuma ocorrÃªncia atual';box.append(b,small);badge.className=`state ${state}`;badge.textContent=String(val);row.append(box,badge);root.appendChild(row);}
}
function renderApprovals(data){
  const pending=(data.approvals||[]).filter(x=>x.status==='pending');$('approval-count').textContent=String(pending.length);$('approval-queue').disabled=!operatorToken;
  const root=$('approval-list');root.replaceChildren();if(!pending.length){root.textContent='Nenhuma aprovaÃ§Ã£o pendente.';return;}
  for(const a of pending){const row=document.createElement('div');row.className='approval-item';const box=document.createElement('div');const b=document.createElement('b');const small=document.createElement('small');b.textContent=`${String(a.tool_name||'aÃ§Ã£o').replaceAll('_',' ')} Â· ${a.risk_level}`;small.textContent=String(a.request_reason||'AÃ§Ã£o de alto risco aguardando decisÃ£o.');box.append(b,small);const actions=document.createElement('div');for(const [label,decision] of [['Aprovar','approved'],['Rejeitar','rejected']]){const btn=document.createElement('button');btn.textContent=label;btn.addEventListener('click',()=>decidePendingApproval(a.approval_id,decision));actions.appendChild(btn);}row.append(box,actions);root.appendChild(row);}
}
function render(data){
  lastData=data;const runs=data.runs||[];$('runs-count').textContent=String(runs.length);$('running-count').textContent=String((data.jobs||[]).filter(x=>x.status==='running').length||runs.filter(x=>x.outcome==='running').length);$('blocked-count').textContent=String(runs.filter(x=>['blocked','awaiting_approval'].includes(x.outcome)).length);$('failed-count').textContent=String(runs.filter(x=>x.outcome==='failed').length);
  const paused=Boolean(data.control?.paused);$('robot-state').textContent=paused?'PAUSADO':'OBSERVÃVEL';$('emergency-stop').textContent=paused?'RETOMAR ROBÃ”':'PAUSA SEGURA';$('emergency-stop').disabled=!operatorToken;
  renderLiveActionPlans(data);renderTimeline(data);renderCapabilities(data);renderGates(data);renderJourney();renderHealth(data);renderApprovals(data);$('updated').textContent=`Atualizado ${new Date(data.generated_at||Date.now()).toLocaleString('pt-BR')}`;
}
async function fetchOperatorState(token=operatorToken){const r=await fetch('/api/robot-control?limit=40',{headers:{authorization:`Bearer ${token}`},cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Token invÃ¡lido ou ausente.':'Estado do robÃ´ indisponÃ­vel.');return r.json();}
async function connectOperator(){const token=$('operator-token').value.trim();if(!token){$('auth-error').textContent='Informe o token de operador.';return false;}try{const data=await fetchOperatorState(token);operatorToken=token;$('operator-token').value='';$('mode-label').textContent='MODO OPERADOR AUTENTICADO';$('connection').textContent='TELEMETRIA REAL';$('robot-substate').textContent='Dados operacionais reais sem PII.';render(data);return true;}catch(e){$('auth-error').textContent=String(e.message||'Falha de autenticaÃ§Ã£o.');return false;}}
async function togglePause(){if(!operatorToken)return;const action=lastData.control?.paused?'resume':'pause';const r=await fetch('/api/robot-control',{method:'POST',headers:{authorization:`Bearer ${operatorToken}`,'content-type':'application/json'},body:JSON.stringify({command:action,reason:`robot_control_${action}`})});if(!r.ok)return;render(await fetchOperatorState());}
async function decidePendingApproval(approvalId,decision){if(!operatorToken)return;const r=await fetch('/api/robot-control',{method:'POST',headers:{authorization:`Bearer ${operatorToken}`,'content-type':'application/json'},body:JSON.stringify({command:'approval',approval_id:approvalId,decision,reason:`robot_control_${decision}`})});if(!r.ok)return;render(await fetchOperatorState());renderApprovals(lastData);}
$('connect').addEventListener('click',()=>{$('auth-error').textContent='';$('auth-dialog').showModal();});$('auth-submit').addEventListener('click',async e=>{e.preventDefault();if(await connectOperator())$('auth-dialog').close();});$('emergency-stop').addEventListener('click',togglePause);$('approval-queue').addEventListener('click',()=>{$('approval-dialog').showModal();renderApprovals(lastData);});$('close-approvals').addEventListener('click',()=>{$('approval-dialog').close();});render(demo);setInterval(async()=>{if(!operatorToken)return;try{render(await fetchOperatorState());}catch{}},15000);

function renderIntelligenceSnapshots(data={}){
  const snapshots=Array.isArray(data.snapshots)?data.snapshots:[];
  const market=snapshots.filter(x=>x.snapshot_type==='market_research').slice(0,8);
  const ranking=snapshots.filter(x=>x.snapshot_type==='product_ranking').slice(0,4);
  const decisions=snapshots.filter(x=>['market_research','investment_decision'].includes(x.snapshot_type)).slice(0,8);
  const fill=(id,rows,kind)=>{const root=$(id);if(!root)return;root.replaceChildren();if(!rows.length&&kind==='Produtos'&&Array.isArray(data.catalog)){for(const item of data.catalog){const card=document.createElement('article');card.className='intelligence-item';const title=document.createElement('b');const score=document.createElement('span');const meta=document.createElement('small');title.textContent=item.name||item.product_id;score.textContent='â€”';meta.textContent='PESQUISA PENDENTE Â· EVIDÃŠNCIA INSUFICIENTE';card.append(title,score,meta);root.appendChild(card);}return;}if(!rows.length){root.textContent='Nenhuma evidÃªncia auditÃ¡vel registrada ainda.';return;}for(const row of rows){const card=document.createElement('article');card.className='intelligence-item';const title=document.createElement('b');const meta=document.createElement('small');const score=document.createElement('span');const payload=row.payload||{};const product=payload.product||payload.top_candidate?.product||{};title.textContent=product.name||row.subject_ref||kind;const n=Number(row.score);score.textContent=Number.isFinite(n)?`${Math.round(n*100)}/100`:'â€”';meta.textContent=`${String(row.decision||payload.market?.decision||'EVIDENCIA_INSUFICIENTE').replaceAll('_',' ')} Â· ${Number(row.evidence_count||0)} fontes Â· ${Number(row.organization_count||0)} orgs`;card.append(title,score,meta);root.appendChild(card);}};
  fill('market-intelligence-list',market,'Mercado');fill('product-intelligence-list',ranking,'Produtos');fill('investment-intelligence-list',decisions,'DecisÃ£o');
  const state=$('intelligence-live-state');if(state)state.textContent=`Ao vivo Â· ${new Date(data.generated_at||Date.now()).toLocaleTimeString('pt-BR')}`;
}
async function refreshIntelligenceFallback(){try{const r=await fetch('/api/intelligence?limit=30',{cache:'no-store'});if(r.ok)renderIntelligenceSnapshots(await r.json());}catch{const state=$('intelligence-live-state');if(state)state.textContent='Telemetria indisponÃ­vel';}}
function connectIntelligenceStream(){
  if(!('EventSource'in window)){refreshIntelligenceFallback();return setInterval(refreshIntelligenceFallback,10000);}
  const source=new EventSource('/api/intelligence?stream=1');
  source.addEventListener('intelligence',e=>{try{renderIntelligenceSnapshots(JSON.parse(e.data));}catch{}});
  source.addEventListener('unavailable',()=>{const state=$('intelligence-live-state');if(state)state.textContent='Telemetria indisponÃ­vel Â· tentando novamente';});
  source.onerror=()=>{const state=$('intelligence-live-state');if(state)state.textContent='Reconectando inteligÃªncia...';};
  return source;
}
$('intelligence-view')?.addEventListener('click',()=>{$('intelligence-dialog')?.showModal();refreshIntelligenceFallback();});
$('close-intelligence')?.addEventListener('click',()=>{$('intelligence-dialog')?.close();});
connectIntelligenceStream();

function renderOperatorIntelligence(data={}){
  const channels=data.channels||{},channelRoot=$('channel-intelligence-list');
  if(channelRoot){channelRoot.replaceChildren();for(const [name,x] of Object.entries(channels)){const card=document.createElement('article');card.className='intelligence-item';const b=document.createElement('b');const state=document.createElement('span');const small=document.createElement('small');b.textContent=String(name).replaceAll('_',' ').toUpperCase();state.textContent=x?.configured?'ONLINE':'PENDENTE';state.dataset.state=x?.configured?'ready':'blocked';small.textContent=`${String(x?.role||'canal').replaceAll('_',' ')} · comercial ${x?.commercial?'habilitável':'bloqueado'}`;card.append(b,state,small);channelRoot.appendChild(card);}if(!channelRoot.children.length)channelRoot.textContent='Nenhum canal observado.';}
  const creativeRoot=$('creative-intelligence-list');if(!creativeRoot)return;creativeRoot.replaceChildren();
  const creativeRuns=(data.runs||[]).filter(r=>r.tool==='create_creative'||r.result?.creative_id||r.result?.image_url||r.result?.video_url).slice(0,8);
  for(const r of creativeRuns){const card=document.createElement('article');card.className='creative-item';const info=document.createElement('div');const b=document.createElement('b');const small=document.createElement('small');const score=document.createElement('span');const result=r.result||{};b.textContent=result.spec?.hook||result.creative_id||'Criativo';score.textContent=result.quality_score==null?'—':`${Math.round(Number(result.quality_score)*100)}/100`;small.textContent=`${String(result.spec?.channel||r.channel||'canal').toUpperCase()} · ${String(result.selection_basis||r.outcome||'observado').replaceAll('_',' ')}`;info.append(b,small,score);card.appendChild(info);if(result.image_url){const img=document.createElement('img');img.loading='lazy';img.alt='Preview do criativo';img.src=result.image_url;card.appendChild(img);}creativeRoot.appendChild(card);}
  if(!creativeRoot.children.length)creativeRoot.textContent='Nenhum criativo auditável registrado ainda.';
}

async function runMarketResearch(){
  if(!operatorToken)return;const subject=$('research-subject')?.value.trim();const feedback=$('research-feedback');if(!subject){if(feedback)feedback.textContent='Informe um produto, nicho ou oportunidade.';return;}
  const button=$('research-now');if(button)button.disabled=true;if(feedback)feedback.textContent='Pesquisando fontes independentes...';
  try{const r=await fetch('/api/intelligence',{method:'POST',headers:{authorization:`Bearer ${operatorToken}`,'content-type':'application/json'},body:JSON.stringify({type:'market_research_run',subject})});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.detail||body.error||`HTTP ${r.status}`);const d=body.research?.decision;if(feedback)feedback.textContent=`${body.cached?'Cache válido':'Pesquisa concluída'} · ${d?.readiness?.verified_sources||0} fontes · decisão ${String(d?.decision||'EVIDENCIA_INSUFICIENTE').replaceAll('_',' ')}`;await refreshIntelligenceFallback();}
  catch(error){if(feedback)feedback.textContent=`Pesquisa não concluída: ${String(error?.message||'erro').slice(0,120)}`;}finally{if(button)button.disabled=!operatorToken;}
}
$('research-now')?.addEventListener('click',runMarketResearch);
$('research-subject')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runMarketResearch();}});
