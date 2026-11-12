// Pure policy shared by discovery, rotation and read-only performance processing.
export const REPORT_KEY='zpc:shorts:v2:musica:curadoria:diario';
export const PUBLISHED_PREFIX='zpc:shorts:v2:musica:publicado:';
const normalized=s=>String(s||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
export const publicMusicLink=file=>'https://raw.githubusercontent.com/arbmsistone-lab/zevanory-public-mirror/gh-pages/'+file;
export function sameTrack(a,b){return Boolean(a&&b&&(a.arquivo&&a.arquivo===b.arquivo||a.sha256&&a.sha256===b.sha256||a.sha256_original&&a.sha256_original===b.sha256_original||a.titulo&&normalized(a.titulo)===normalized(b.titulo)));}
export function ownerVeto(row,profile){return profile.recusadas.some(v=>sameTrack(row,v));}
export function tagVeto(row,profile){const text=normalized([row.descricao_original,...(row.tags||[])].join(' '));return profile.vetos_tags.some(t=>new RegExp('(?:^|[^a-z0-9])'+normalized(t).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9])','i').test(text));}
export function licenseEvidence(row){return row.licenca==='CC0-1.0'&&/^https:\/\//.test(row.fonte||'')&&Boolean(row.autor&&row.titulo)&&/^\d{4}-\d{2}-\d{2}$/.test(row.verificado_em||'')&&/^https:\/\//.test(row.pagina_licenca||'')&&/(CC0|Creative Commons 0|public.domain)/i.test(row.evidencia_licenca||'')&&/^[a-f0-9]{64}$/.test(row.sha256_original||'')&&/^[a-f0-9]{64}$/.test(row.sha256||'')&&/^assets\/musica\/[a-z0-9-]+\.ogg$/.test(row.arquivo||'');}
const dims=[['bpm',60],['rms',.03],['centroide_hz',2000],['lra',8]];
export function validFeatures(f,sha){return f?.schema===1&&f.audio_sha256===sha&&dims.every(([k])=>Number.isFinite(f[k])&&f[k]>=0)&&['maior','menor'].includes(f.modo)&&f.vocal?.model_sha256==='4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf'&&Number.isFinite(f.vocal.max_score)&&f.vocal.janelas>0&&['ausente','presente','incerto'].includes(f.vocal.status)&&(f.vocal.status!=='ausente'||f.vocal.max_score<.15&&f.vocal.music_mean>=.25);}
export function featureDistance(a,b){const usable=dims.filter(([k])=>k!=='bpm'||a.bpm_confiavel===true&&b.bpm_confiavel===true);return Math.sqrt(usable.reduce((s,[k,scale])=>{const delta=k==='bpm'?Math.min(...[.5,1,2].map(f=>Math.abs(a[k]*f-b[k]))):Math.abs(a[k]-b[k]);return s+(delta/scale)**2;},0)/usable.length)+(a.modo===b.modo?0:.1);}
const distance=featureDistance;
export function similarity(row,profile){const f=row.atributos;if(!validFeatures(f,row.sha256))return 0;const allowed=profile.aprovadas.filter(r=>!ownerVeto(r,profile)&&validFeatures(r.medidas,r.sha256));if(!allowed.length)return 0;const near=Math.min(...allowed.map(r=>distance(f,r.medidas))),rejected=profile.recusadas.filter(r=>validFeatures(r.medidas,r.sha256)),bad=rejected.length?Math.min(...rejected.map(r=>distance(f,r.medidas))):Infinity;const boost=/\b(upbeat|uplifting|happy)\b/i.test(row.descricao_original||'')?.03:0;return Math.max(0,Math.min(1,1-near-.4*Math.max(0,1-bad)+boost));}
export function candidateDecision(row,profile){
 if(ownerVeto(row,profile))return {ok:false,reason:'owner_veto'};
 if(tagVeto(row,profile)&&!profile.aprovadas.some(r=>r.sha256===row.sha256))return {ok:false,reason:'tag_veto'};
 if(!licenseEvidence(row))return {ok:false,reason:'license_missing'};
 if(!validFeatures(row.atributos,row.sha256)||row.atributos.vocal.status!=='ausente')return {ok:false,reason:'vocal_or_features_unknown'};
 const score=similarity(row,profile);return {ok:score>=profile.descoberta.limiar,reason:score>=profile.descoberta.limiar?'eligible':'dissimilar',score};
}
export function learnedProfile(profile,manifest){const p=structuredClone(profile);for(const r of [...p.aprovadas,...p.recusadas]){if(r.medidas)continue;const row=manifest.faixas.find(x=>sameTrack(r,x));if(row&&validFeatures(row.atributos,row.sha256)){r.medidas=row.atributos;r.sha256=row.sha256;r.sha256_original=row.sha256_original;}}return p;}
export function assertActivation(profile){if(profile.descoberta.max_por_mes!==2||!Number.isInteger(profile.descoberta.max_candidatas)||profile.descoberta.max_candidatas<1||profile.descoberta.max_candidatas>12||!Number.isFinite(profile.descoberta.limiar)||profile.descoberta.limiar<.7||profile.descoberta.limiar>1)throw Error('music_profile_invalid');if(profile.descoberta.enabled!==true||!['proprietario','claude','gpt6'].every(k=>profile.descoberta.aprovacoes[k]===true))throw Error('music_curation_disabled_pending_reviews');}
export function promote(candidates,profile,state,day,{availableBytes=Infinity,maxPromotions=2}={}){
 const next=structuredClone(state),month=day.slice(0,7);next.meses[month]??=[];const promoted=[];
 for(const row of [...candidates].sort((a,b)=>similarity(b,profile)-similarity(a,profile)||a.arquivo.localeCompare(b.arquivo))){
  if(next.meses[month].length>=Math.min(2,profile.descoberta.max_por_mes)||promoted.length>=maxPromotions)break;
  if(next.faixas[row.arquivo]||profile.aprovadas.some(r=>sameTrack(r,row))||Object.values(next.faixas).some(r=>r.sha256===row.sha256))continue;
  const decision=candidateDecision(row,profile);if(!decision.ok)continue;if(Number.isFinite(availableBytes)){if(!Number.isSafeInteger(row.tamanho_bytes)||row.tamanho_bytes<1||row.tamanho_bytes>availableBytes)continue;availableBytes-=row.tamanho_bytes;}
  next.faixas[row.arquivo]={sha256:row.sha256,status:'observacao',videos:0,peso:1,desde:day,score:decision.score,badWindows:0};next.meses[month].push(row.arquivo);next.eventos.push({day,tipo:'promovida',arquivo:row.arquivo,link:publicMusicLink(row.arquivo)});promoted.push(row);
 }
 return {state:next,promoted};
}
export function applyOwnerVeto(profile,state,day){const next=structuredClone(state);for(const [arquivo,row] of Object.entries(next.faixas))if(ownerVeto({arquivo,...row},profile)&&row.status!=='vetada'){row.status='vetada';next.eventos.push({day,tipo:'veto_proprietario',arquivo});}return next;}
const median=rows=>{const v=rows.map(r=>r.retention).sort((a,b)=>a-b),m=Math.floor(v.length/2);return v.length%2?v[m]:(v[m-1]+v[m])/2;};
export function learnPerformance(state,profile,window){
 const next=applyOwnerVeto(profile,state,window.end);if(window.status!=='verified')return next;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(window.start)||!/^\d{4}-\d{2}-\d{2}$/.test(window.end)||window.end<window.start||!Array.isArray(window.rows)||window.rows.some(r=>!r.video_id||!Number.isFinite(r.retention)||r.retention<0)||new Set(window.rows.map(r=>r.video_id)).size!==window.rows.length)throw Error('retention_window_unreadable');
 const baseline=median(window.rows);if(!Number.isFinite(baseline)||baseline<=0)return next;
 for(const file of new Set(window.rows.map(r=>r.arquivo).filter(Boolean))){
  const rows=window.rows.filter(r=>r.arquivo===file);if(rows.length<10)continue;
  const r=next.faixas[file]??={status:'ativa',peso:1,badWindows:0,videos:rows.length};if(['vetada','retirada'].includes(r.status)||r.ultimaJanela&&window.start<=r.ultimaJanela.end)continue;
  const avg=rows.reduce((s,r)=>s+r.retention,0)/rows.length;r.badWindows=avg<=baseline*.85?(r.ultimaJanela&&new Date(Date.parse(r.ultimaJanela.end)+86400000).toISOString().slice(0,10)===window.start?r.badWindows+1:1):0;r.ultimaJanela={start:window.start,end:window.end,mean:avg,median:baseline,n:rows.length};
  if(r.badWindows>=2){r.status='retirada';r.peso=0;next.eventos.push({day:window.end,tipo:'retirada_retencao',arquivo:file,mean:avg,median:baseline});}else r.peso=avg>baseline?Math.min(2,avg/baseline):1;
 }
 return next;
}
export function selectMusic({theme,last,manifest,profile,state,history=[]}){
 for(const r of Object.values(state.faixas))if(!['ativa','observacao','retirada','vetada'].includes(r.status)||!Number.isFinite(r.peso)||r.peso<0||r.peso>2)throw Error('music_curation_state_unreadable');
 let rows=manifest.faixas.filter(r=>!ownerVeto(r,profile)&&(!tagVeto(r,profile)||profile.aprovadas.some(p=>p.sha256===r.sha256))&&(profile.aprovadas.some(p=>p.sha256===r.sha256)||state.faixas[r.arquivo]?.sha256===r.sha256&&['observacao','ativa'].includes(state.faixas[r.arquivo]?.status))&&!['retirada','vetada'].includes(state.faixas[r.arquivo]?.status));
 const counts=new Map();for(const r of history)counts.set(r.arquivo,(counts.get(r.arquivo)||0)+1);
 const alternatives=rows.length>1;rows=rows.filter(r=>r.arquivo!==last?.arquivo&&(!alternatives||(counts.get(r.arquivo)||0)+1<=Math.ceil((history.length+1)/2)));
 if(!rows.length)throw Error('licensed_music_missing_or_rotation_blocked');
 if(manifest.faixas.length>=3&&rows.some(r=>r.temas_permitidos.includes(theme)))rows=rows.filter(r=>r.temas_permitidos.includes(theme));
 const weight=r=>state.faixas[r.arquivo]?.peso||1,total=rows.reduce((n,r)=>n+weight(r),0),priority=r=>(history.length+1)*weight(r)/total-(counts.get(r.arquivo)||0)+(r.temas_permitidos.includes(theme)?.05:0);
 rows.sort((a,b)=>priority(b)-priority(a)||a.arquivo.localeCompare(b.arquivo));return rows[0];
}
export function dailyMusicText(profile,state){const active=Object.entries(state.faixas).filter(([arquivo,r])=>['observacao','ativa'].includes(r.status)&&!ownerVeto({arquivo,...r},profile)).sort((a,b)=>String(b[1].desde).localeCompare(String(a[1].desde))).slice(0,20);return ['Curadoria musical:','Retenção: '+(state.analytics?.status==='verified'?'janelas verificadas':'sem dados suficientes'),...profile.aprovadas.filter(r=>!ownerVeto(r,profile)).map(r=>'Aprovada pelo proprietário: '+r.titulo+' — '+publicMusicLink(r.arquivo)),...active.map(([f,r])=>`${r.status==='observacao'?'Nova faixa em observação':'Faixa ativa'} (${Math.min(5,r.videos||0)}/5): ${f.split('/').at(-1)} — ${(state.catalogo?.[f]?.fonte||publicMusicLink(f))}`),...state.eventos.slice(-10).filter(e=>e.tipo!=='promovida').map(e=>e.tipo+': '+e.arquivo),'Veto do proprietário prevalece; dados ausentes não alteram desempenho.'].join('\n');}
