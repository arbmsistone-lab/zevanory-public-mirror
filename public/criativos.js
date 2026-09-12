const $=(id)=>document.getElementById(id);
const set=(id,value)=>{const el=$(id);if(el)el.textContent=String(value??'—');};
const safeNumber=(value)=>Number.isFinite(Number(value))?Number(value):null;
const scoreLabel=(value)=>{const n=safeNumber(value);if(n===null)return '—';return n<=1?(n*100).toFixed(1):n.toFixed(1);};
const variantLetter=(index)=>String.fromCharCode(65+index);
const FRONT_LABELS={zevanory:'ZEVANORY',whatsapp:'WhatsApp',email:'Email',instagram:'Instagram',facebook:'Facebook',youtube:'YouTube',google:'Google',affiliate:'Afiliados',mercado_livre:'Mercado Livre'};
let sample=null;
let closure=null;
let mode='image';

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
  votes.forEach(v=>{const row=document.createElement('div');row.className=`board-vote ${v.approved?'approved':'rejected'}`;row.innerHTML=`<span>SR-${v.analyst}</span><b>${String(v.lens||'review').replaceAll('_',' ')}</b><i>${v.approved?'APROVA':'REVISA'}</i>`;root?.append(row);});
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
  set('advisor-roas',Number.isFinite(Number(a.evidence?.roas))?Number(a.evidence.roas).toFixed(2):'â€”');
  set('advisor-confidence',Number.isFinite(Number(a.confidence))?`${(Number(a.confidence)*100).toFixed(0)}%`:'â€”');set('advisor-reason',a.reason||'evidÃªncia insuficiente');
  set('kpi-invest',a.action||'AGUARDAR');set('kpi-invest-copy',a.auto_spend===false?'recomendaÃ§Ã£o Â· sem gasto automÃ¡tico':'governanÃ§a indisponÃ­vel');
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

function selectMode(next){
  mode=next;document.querySelectorAll('.production-item[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode===mode));renderPreview();
}

function renderFronts(){
  const root=$('production-list');if(!root)return;root.replaceChildren();
  const fronts=closure?.distribution?.fronts||{};const entries=Object.entries(fronts);
  set('production-count',`${entries.length} frentes`);
  entries.forEach(([name,state])=>{
    const item=document.createElement('button');item.type='button';item.className='production-item';
    const previewMode=name==='youtube'?'video':name==='instagram'?'image':'';if(previewMode)item.dataset.mode=previewMode;
    item.innerHTML=`<span class="channel">${FRONT_LABELS[name]||name}</span><strong>${state.operational_ready?'CRIAÇÃO ATIVA':'AGUARDANDO'}</strong><small>${state.automation_ready?'automação pronta':'operação assistida'}</small><i>${previewMode?'PREVIEW DISPONÍVEL':'PRONTA PARA CRIAÇÃO'}</i>`;
    if(previewMode)item.addEventListener('click',()=>selectMode(previewMode));else item.disabled=true;
    root.append(item);
  });
  if(!entries.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Nenhuma frente operacional retornada.';root.append(empty);}
  document.querySelector('.production-item[data-mode="image"]')?.classList.add('active');
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
    const [sampleRes,closureRes]=await Promise.all([
      fetch('/api/config?view=creative_sample',{cache:'no-store'}),
      fetch('/api/config?view=closure_status',{cache:'no-store'})
    ]);
    if(!sampleRes.ok)throw new Error(`creative_sample_http_${sampleRes.status}`);
    sample=await sampleRes.json();closure=closureRes.ok?await closureRes.json():{};
    renderSummary();renderPreview();set('source-state','fontes reais · creative_sample + closure_status');
  }catch(error){
    set('engine-state','ERRO');set('kpi-engine','INDISPONÍVEL');set('source-state',String(error?.message||'falha de carregamento'));
    const loading=$('preview-loading');if(loading){loading.hidden=false;loading.textContent='Motor criativo indisponível.';}
  }
}

load();setInterval(load,60000);
