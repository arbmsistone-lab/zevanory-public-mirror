const $=(id)=>document.getElementById(id);
const set=(id,value)=>{const el=$(id);if(el)el.textContent=String(value??'—');};
const safeNumber=(value)=>Number.isFinite(Number(value))?Number(value):null;
const scoreLabel=(value)=>{const n=safeNumber(value);if(n===null)return '—';return n<=1?(n*100).toFixed(1):n.toFixed(1);};
const variantLetter=(index)=>String.fromCharCode(65+index);
const FRONT_LABELS={zevanory:'ZEVANORY',whatsapp:'WhatsApp',email:'Email',instagram:'Instagram',facebook:'Facebook',youtube:'YouTube',tiktok:'TikTok',linkedin:'LinkedIn',google:'Google',affiliate:'Afiliados',mercado_livre:'Mercado Livre',nuvemshop:'Nuvemshop'};
const SERVICE_FRONTS=new Set(['zevanory','whatsapp','email','instagram','facebook']);
let sample=null;
let closure=null;
let mode='image';
let selectedFront='instagram';

function currentVariants(){return mode==='image'?(sample?.image_variants||[]):(sample?.video_variants||[]);}
function currentWinnerId(){return mode==='image'?sample?.image_creative_id:sample?.video_creative_id;}
function currentAssetUrl(){return mode==='image'?sample?.png_url:sample?.webm_url;}
function currentBasis(){return mode==='image'?sample?.image_selection_basis:sample?.video_selection_basis;}
function currentBoard(){return mode==='image'?sample?.image_review_board:sample?.video_review_board;}

function clearPreview(){
  $('image-preview')?.classList.remove('active');
  $('video-preview')?.classList.remove('active');
  const video=$('video-preview');if(video){video.pause();video.removeAttribute('src');video.load();}
  const image=$('image-preview');if(image)image.removeAttribute('src');
}

function renderBoard(){
  const board=currentBoard()||{};const root=$('board-votes');if(root)root.replaceChildren();
  const votes=Array.isArray(board.votes)?board.votes:[];set('board-score',`${board.approved_count??0}/${board.required??5}`);
  const lensLabels={strategy_message:'ESTRATÉGIA',visual_quality:'QUALIDADE',truth_compliance:'VERACIDADE',channel_fit:'CANAL',conversion_clarity:'CONVERSÃO'}; votes.forEach(v=>{const row=document.createElement('div');row.className=`board-vote ${v.approved?'approved':'rejected'}`;const lens=lensLabels[String(v.lens||'')]||String(v.lens||'REVISÃO').replaceAll('_',' ').toUpperCase();row.innerHTML=`<span>SR-${v.analyst}</span><b title="${lens}">${lens}</b><i>${v.approved?'APROVA':'REVISA'}</i>`;root?.append(row);});
  set('board-state',board.unanimous?'APROVADO 5/5 · liberação técnica permitida':'REVISÃO OBRIGATÓRIA · exige 5/5');
  const step=$('review-step');if(step)step.dataset.state=board.unanimous?'done':'blocked';
}
function renderVariants(){
  const root=$('variants');if(!root)return;root.replaceChildren();
  const variants=currentVariants(),winner=currentWinnerId();set('variant-count',`${variants.length} avaliadas`);
  variants.forEach((variant,index)=>{
    const card=document.createElement('article');card.className='variant'+(variant.creative_id===winner?' winner':'');
    const head=document.createElement('div');head.className='variant-head';
    const title=document.createElement('strong');title.textContent=`Variante ${variantLetter(index)} · ${variant.layout||'layout'}`;
    const rank=document.createElement('b');rank.textContent=variant.creative_id===winner?'VENCEDORA':`#${index+1}`;head.append(title,rank);
    const id=document.createElement('small');id.textContent=`${variant.variant_id||variant.creative_id} · ${variant.creative_id}`;
    const scores=document.createElement('div');scores.className='score-row';
    const pairs=[['Seleção',variant.selection_score],['Qualidade',variant.quality_score],['Perceptual',variant.perceptual_score],['Frame mínimo',variant.visual_min_frame_score]];
    pairs.forEach(([name,value])=>{const box=document.createElement('span');box.textContent=name;const b=document.createElement('b');b.textContent=scoreLabel(value);box.append(b);scores.append(box);});
    card.append(head,id,scores);root.append(card);
  });
  if(!variants.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Nenhuma variante retornada pelo motor.';root.append(empty);}
  renderBoard();
}


function renderAdvisor(){
  const variants=currentVariants(),winner=currentWinnerId();const selected=variants.find(v=>v.creative_id===winner)||variants[0]||{};const a=selected.advisor||{};
  set('advisor-policy',a.policy_version||'media-investment-advisor-v1');set('advisor-action',a.action||'AGUARDAR');
  set('advisor-budget',`R$ ${Number(a.recommended_daily_budget_brl||0).toFixed(2).replace('.',',')}`);
  set('advisor-roas',Number.isFinite(Number(a.evidence?.roas))?Number(a.evidence.roas).toFixed(2):'—');
  const advisorReasonLabels={evidence_gate_not_met:'Evidência comercial ainda insuficiente',negative_economics:'Economia negativa observada',refund_rate_too_high:'Taxa de reembolso acima do limite',contribution_margin_too_low:'Margem de contribuição abaixo do limite'};set('advisor-confidence',Number.isFinite(Number(a.confidence))?`${(Number(a.confidence)*100).toFixed(0)}%`:'—');set('advisor-reason',advisorReasonLabels[a.reason]||a.reason||'Evidência ainda insuficiente');
  set('kpi-invest',a.action||'AGUARDAR');set('kpi-invest-copy',a.auto_spend===false?'recomendação · sem gasto automático':'governança indisponível');
}

function renderPreview(){
  clearPreview();const winner=currentWinnerId(),url=currentAssetUrl();
  set('creative-id',winner||'—');set('selection-basis',currentBasis()||'—');set('preview-badge',mode==='image'?'IMAGEM · INSTAGRAM':'VÍDEO · YOUTUBE');
  const loading=$('preview-loading');if(loading){loading.hidden=false;loading.textContent='Carregando preview real…';}
  if(!url){if(loading)loading.textContent='Preview indisponível.';renderVariants();return;}
  if(mode==='image'){
    const image=$('image-preview');if(!image)return;
    image.onload=()=>{image.classList.add('active');if(loading)loading.hidden=true;};
    image.onerror=()=>{if(loading)loading.textContent='Falha ao carregar o PNG real.';};
    image.src=url;
  }else{
    const video=$('video-preview');if(!video)return;
    video.onloadeddata=()=>{video.classList.add('active');if(loading)loading.hidden=true;};
    video.onerror=()=>{if(loading)loading.textContent='Falha ao carregar o WebM real.';};
    video.src=url;video.load();
  }
  renderVariants();renderAdvisor();set('updated-at',new Date().toLocaleTimeString('pt-BR'));
}

function renderFrontStatus(name,state){
  clearPreview();
  set('preview-badge',`${FRONT_LABELS[name]||name} · STATUS`);
  set('creative-id','—');set('selection-basis','frente operacional');set('updated-at',new Date().toLocaleTimeString('pt-BR'));
  const operational=Boolean(state?.operational_ready);
  const distribution=Boolean(state?.automation_ready||state?.api_configured);
  const loading=$('preview-loading');if(loading){loading.hidden=false;loading.textContent=`${FRONT_LABELS[name]||name} selecionado · criação ${operational?'ativa':'aguardando'} · divulgação ${distribution?'pronta':'assistida'}; preview visual específico ainda não gerado.`;}
  const root=$('variants');if(root){root.replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.textContent='Selecione Instagram ou YouTube para revisar variantes visuais e banca 5/5.';root.append(empty);}
  const votes=$('board-votes');if(votes)votes.replaceChildren();const step=$('review-step');if(step)delete step.dataset.state;
  set('variant-count','status da frente');set('board-score','N/A');set('board-state','Banca 5/5 não se aplica sem variante visual concreta.');
  set('advisor-policy','media-investment-advisor-v1');set('advisor-action','N/A');set('advisor-budget','—');set('advisor-roas','—');set('advisor-confidence','—');set('advisor-reason','Disponível somente para variante visual avaliada.');
}
function selectFront(name,state,previewMode){
  selectedFront=name;
  document.querySelectorAll('.production-item[data-front]').forEach(el=>el.classList.toggle('active',el.dataset.front===selectedFront));
  if(previewMode){mode=previewMode;renderPreview();}else renderFrontStatus(name,state);
}

function renderFronts(){
  const root=$('production-list');if(!root)return;root.replaceChildren();
  const fronts=closure?.distribution?.fronts||{};const entries=Object.entries(fronts);
  set('production-count',`${entries.length} frentes`);
  entries.forEach(([name,state])=>{
    const item=document.createElement('button');item.type='button';item.className='production-item';item.dataset.front=name;
    const previewMode=name==='youtube'?'video':name==='instagram'?'image':'';if(previewMode)item.dataset.mode=previewMode;
    const operation=state.operational_ready?'ATIVA':'AGUARDANDO';
    const executionMode=state.automation_ready||state.api_configured?'DIRETA':'ASSISTIDA';
    const service=SERVICE_FRONTS.has(name)?(state.operational_ready?'SUPORTADO':'AGUARDANDO'):'N/A';
    const sales=closure?.commercial_enabled?'LIBERADA':'BLOQUEADA';
    item.innerHTML=`<span class="channel">${FRONT_LABELS[name]||name}</span><div class="front-statuses"><span class="operation-state"><em>Operação</em><b>${operation}</b></span><span><em>Modo</em><b>${executionMode}</b></span><span><em>Atendimento</em><b>${service}</b></span><span class="sales-state"><em>Venda</em><b>${sales}</b></span></div><i>${previewMode?'PREVIEW DISPONÍVEL':'ABRIR STATUS DA FRENTE'}</i>`;
    item.addEventListener('click',()=>selectFront(name,state,previewMode));
    root.append(item);
  });
  if(!entries.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Nenhuma frente operacional retornada.';root.append(empty);return;}
  const initial=fronts[selectedFront]?selectedFront:(fronts.instagram?'instagram':entries[0][0]);selectedFront=initial;
  document.querySelector(`.production-item[data-front="${initial}"]`)?.classList.add('active');
}
function renderSummary(){
  const all=[...(sample?.image_variants||[]),...(sample?.video_variants||[])];
  const best=Math.max(...all.map(v=>safeNumber(v.selection_score)??-Infinity));
  set('kpi-engine',sample?.engine||'—');set('kpi-variants',all.length||0);set('kpi-score',Number.isFinite(best)?scoreLabel(best):'—');
  const sales=Boolean(closure?.commercial_enabled);set('kpi-publish',sales?'LIBERADAS':'BLOQUEADAS');set('truth-state',sales?'VENDAS LIBERADAS':'VENDAS BLOQUEADAS');
  set('truth-copy',sales?'Os gates comerciais autorizaram vendas.':'Pesquisa, criação, avaliação e preparação seguem ativas; apenas vendas permanecem bloqueadas.');
  set('engine-state',sample?.engine?'MOTOR ONLINE':'MOTOR INDISPONÍVEL');
  set('image-id',sample?.image_creative_id||'sem criativo');set('video-id',sample?.video_creative_id||'sem criativo');
  const publish=$('publish-step');if(publish)publish.dataset.state=sales?'done':'blocked';
  set('flow-state',sales?'MOTOR + VENDAS':'MOTOR ATIVO · VENDAS BLOQUEADAS');renderFronts();
}

async function load(){
  try{
    const [sampleRes,closureRes,agentRes]=await Promise.all([
      fetch('/private-api/config?view=creative_sample',{cache:'no-store'}),
      fetch('/private-api/config?view=closure_status',{cache:'no-store'}),
      fetch('/private-api/agent/status',{cache:'no-store'})
    ]);
    if(!sampleRes.ok)throw new Error(`creative_sample_http_${sampleRes.status}`);
    if(!closureRes.ok)throw new Error(`closure_status_http_${closureRes.status}`);
    sample=await sampleRes.json();closure=await closureRes.json();const agent=agentRes.ok?await agentRes.json():{};window.__zevanoryAgentEvidence=agent;
    if(!sample?.engine||!closure?.distribution?.fronts)throw new Error('creative_contract_invalid');
    renderSummary();renderPreview();const auto=agent.autopilot||{};set('truth-copy',`Pesquisa, criação e avaliação seguem ativas · ${auto.cycles_24h||0} ciclo(s) autônomo(s) 24h · ${auto.program_drafts||0} programa(s) em rascunho · vendas bloqueadas.`);set('source-state','fontes reais · creative_sample + closure_status + autopilot');
  }catch(error){
    set('engine-state','ERRO');set('kpi-engine','INDISPONÍVEL');set('production-count','0 frentes');set('variant-count','0 avaliadas');set('board-score','0/5');set('source-state',String(error?.message||'falha de carregamento'));
    const list=$('production-list');if(list){list.replaceChildren();const empty=document.createElement('div');empty.className='empty';empty.textContent='Status operacional indisponível. Nenhuma frente será apresentada como pronta sem prova real.';list.append(empty);}
    const loading=$('preview-loading');if(loading){loading.hidden=false;loading.textContent='Motor criativo indisponível.';}
  }
}

window.__zevanoryAgentEvidence={};

function escText(v){return String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll("'",'&#39;');}
function safeHttps(v){try{const u=new URL(String(v||''));return u.protocol==='https:'?u.toString():'';}catch{return '';}}
function renderEvidence(agent={}){
  const activity=Array.isArray(agent.activity_timeline)?agent.activity_timeline:[];
  const research=activity.filter(x=>x.kind==='intelligence'&&x.title==='market_research');
  const decisions=activity.filter(x=>x.kind==='intelligence'&&x.title==='investment_decision');
  const runs=activity.filter(x=>x.kind==='agent_run').slice(0,24);
  const latestResearch=research[0]||{}; set('evidence-cycles',agent.autopilot?.cycles_24h||0); set('evidence-sources',latestResearch.evidence_count||0); set('evidence-orgs',latestResearch.organization_count||0);
  const rr=$('evidence-research'); if(rr){rr.replaceChildren(); for(const item of research.slice(0,6)){const card=document.createElement('article');const ev=Array.isArray(item.evidence)?item.evidence:[];const links=ev.slice(0,8).map(e=>{const u=safeHttps(e.source_url);return u?`<a href="${escText(u)}" target="_blank" rel="noopener noreferrer">${escText(e.organization||e.source||'fonte')}</a>`:'';}).filter(Boolean).join('');card.innerHTML=`<b>${escText(item.subject||'Pesquisa')}</b><small>${item.evidence_count||0} fontes · ${item.organization_count||0} organizações · score ${item.score==null?'—':Number(item.score).toFixed(3)} · ${escText(item.decision||'')}</small><div class="source-links">${links||'<span>URLs não expostas neste ciclo</span>'}</div>`;rr.append(card);} if(!research.length)rr.innerHTML='<div class="empty">Nenhuma pesquisa persistida nas últimas 24h.</div>';}
  const media=[]; for(const item of decisions){const c=item.creative||{};for(const m of (Array.isArray(c.channel_creatives)?c.channel_creatives:[])){media.push({...m,cycle_id:item.candidate?.cycle_id||null,subject:item.candidate?.subject||item.subject||null});}}
  set('evidence-media-count',media.filter(x=>x.asset_url).length);
  const mr=$('evidence-media'); if(mr){mr.replaceChildren(); for(const m of media.slice(0,10)){const card=document.createElement('article');card.className='media-proof';const accepted=m.elite_accepted===true&&m.asset_url;const visual=accepted?(String(m.channel).match(/youtube|tiktok/)?`<video src="${escText(m.asset_url)}" controls preload="metadata"></video><audio src="${escText(m.asset_url)}" controls preload="none"></audio>`:`<img src="${escText(m.asset_url)}" loading="lazy" alt="Criativo ${escText(m.creative_id||'')}">`):'<div class="media-rejected">ARTEFATO NÃO LIBERADO · gate de qualidade não atingido</div>';card.innerHTML=`${visual}<div><b>${escText(m.channel||'canal')} · ${escText(m.creative_id||'sem creative id')}</b><small>Q ${Number(m.quality_score||0).toFixed(3)} · P ${Number(m.perceptual_score||0).toFixed(3)} · rodada ${m.revision_round||0} · ${m.elite_accepted?'ELITE APROVADO':'REVISÃO'}</small><small>Ciclo ${escText(m.cycle_id||'—')} · ${escText(m.subject||'')}</small></div>`;mr.append(card);} if(!media.length)mr.innerHTML='<div class="empty">Nenhuma mídia do autopilot persistida neste recorte.</div>';}
  const er=$('evidence-runs'); if(er){er.replaceChildren();for(const r of runs){const card=document.createElement('article');card.innerHTML=`<b>${escText(r.title||r.provider||'execução')}</b><small>${escText(r.provider||'')} · ${escText(r.model||'')} · ${r.latency_ms||0} ms · ${escText(r.state||'')}</small><small>${new Date(r.created_at).toLocaleString('pt-BR')} · trace ${escText((r.trace_id||r.id||'').slice(0,12))}</small>`;er.append(card);}if(!runs.length)er.innerHTML='<div class="empty">Nenhuma execução recente.</div>';}
}
const evidenceDialog=$('evidence-dialog');$('open-evidence')?.addEventListener('click',()=>{evidenceDialog?.showModal();renderEvidence(window.__zevanoryAgentEvidence||{});});$('close-evidence')?.addEventListener('click',()=>evidenceDialog?.close());evidenceDialog?.addEventListener('click',e=>{if(e.target===evidenceDialog)evidenceDialog.close();});

load();setInterval(load,60000);

// Surgical accessibility/state sync for channel selection.
function syncCreativeFrontA11y(){
  document.querySelectorAll('.production-item[data-front]').forEach(el=>{
    const active=el.classList.contains('active');
    el.setAttribute('aria-pressed',active?'true':'false');
    const channel=el.querySelector('.channel')?.textContent?.trim()||el.dataset.front||'Canal';
    el.setAttribute('aria-label',`${channel}: ${active?'selecionado':'não selecionado'}`);
  });
}
document.addEventListener('click',event=>{
  if(event.target.closest('.production-item[data-front]')) queueMicrotask(syncCreativeFrontA11y);
});
const creativeFrontObserver=new MutationObserver(syncCreativeFrontA11y);
creativeFrontObserver.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
queueMicrotask(syncCreativeFrontA11y);
