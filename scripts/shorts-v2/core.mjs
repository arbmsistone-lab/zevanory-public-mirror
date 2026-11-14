import PROFILE from '../../data/musica-perfil.json' with {type:'json'};
import MUSIC_STATE from '../../data/musica-curadoria.json' with {type:'json'};
import {selectMusic,learnedProfile} from './music-policy.mjs';
import {fingerprint,assertNovel,scriptHistory} from './script-history.mjs';
import ALLOW from '../../data/p18-commercial-allowlist.json' with {type:'json'};
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {episodeScript} from './episode.mjs';
export const CTA='Kit completo no link da descrição';
export const STYLE='Português do Brasil. Converse como quem ensina a um amigo. Energia média-alta no gancho, sorriso na voz, 150 a 170 palavras por minuto. Sem cadência de leitura e sem enfatizar todas as palavras. Pausas curtas na pontuação. Pronuncie ZEVANORY como zê-va-nó-ri. Não leia títulos ou instruções.';
export const forbidden=/R\$|\b(reais|BRL|lucro garantido|renda garantida|ganhe dinheiro|resultado garantido|whatsapp|telegram|gr[aá]tis|oferta imperd[ií]vel)\b|\b\d+[,.]\d{2}\b/i;
const themeBySku={'ZEV-IA-011':'ia','ZEV-VEN-011':'vendas','ZEV-LCX-011':'financas','ZEV-CMB-011':'dicas','ZEV-NGC-011':'dicas'};
export function themeFor(plan){
 const sku=plan.entry?.product?.sku;if(themeBySku[sku])return themeBySku[sku];
 const t=String((plan.entry?.theme_id||'')+' '+(plan.entry?.product?.name||'')).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 const found=[[/\b(ia|inteligencia|tecnologia)\b/,'ia'],[/\b(vendas|atendimento)\b/,'vendas'],[/\b(caixa|lucro|financas|calculadora)\b/,'financas']].filter(([r])=>r.test(t)).map(([,v])=>v);
 if(found.length===1)return found[0];return 'dicas';
}
export function scriptFor(plan){
 const episode=episodeScript(plan),lines=[episode.hook,...episode.steps,episode.result,...(episode.followup?[episode.followup]:[]),CTA+'.'];
 if(episode.steps.length<3||episode.steps.length>4)throw Error('episode_steps_invalid');
 if(lines.some(x=>x.replace(/[?!.]/g,'').trim().split(/\s+/).length>12)||forbidden.test(lines.join(' ')))throw Error('spoken_script_invalid');
 return lines;
}
function candidatePlan(plan,{hotmartOpen=false}={}){
 const theme=themeFor(plan),sentences=scriptFor(plan),episode=episodeScript(plan);
 if(plan.purchase!=='hotmart'&&hotmartOpen!==true)throw Error('v2_kit_not_available_sales_lock');
 const sku=plan.entry.product.sku||({ia:'ZEV-IA-011',vendas:'ZEV-VEN-011',financas:'ZEV-LCX-011',dicas:'ZEV-NGC-011'})[theme],kit=ALLOW.products.find(p=>p.kind==='kit'&&p.sku===sku);
 if(!kit)throw Error('v2_kit_missing');
 const link=new URL('https://vendas.zevanory.api.br/hotmart/'+kit.slug);link.searchParams.set('utm_source','youtube');link.searchParams.set('utm_medium','shorts');link.searchParams.set('utm_campaign',theme);
 const warnings=theme==='dicas'&&!themeBySku[plan.entry?.product?.sku]?['theme_ambiguous_using_dicas']:[];
 return {...plan,screen:{...plan.screen,product:kit.name},v2:true,theme,episode,warnings,sentences,speech:sentences.join(' '),link:link.href,description:[sentences[0],link.href,'#Shorts #ZEVANORY',plan.marker].join('\n'),containsSyntheticMedia:true};
}
export function assertVoice(config,voice,{preview=false,model=config?.modelo}={}){if(!config||voice!==config.voz_fixa)throw Error('brand_voice_changed');if(!config.modelo||model!==config.modelo)throw Error('brand_model_changed');if(config.comparacao_aprovada!==true||config.nivel_gratuito_confirmado!==true)throw Error('voice_comparison_or_free_tier_pending');if(!preview&&config.publicacao_aprovada!==true)throw Error('owner_preview_approval_pending');}
export async function licensedTrack({theme,last=null,manifest,root=new URL('../../',import.meta.url),profile=PROFILE,state=MUSIC_STATE,history=[],buffers=new Map()}){if(last!==null&&(!last||typeof last.arquivo!=='string'||!Number.isFinite(last.em)))throw Error('music_history_unreadable');if(manifest?.faixas?.some(r=>! /^[a-f0-9]{64}$/.test(r.sha256||'')))throw Error('music_hash_mismatch');profile=learnedProfile(profile,manifest||{faixas:[]});const row=selectMusic({theme,last,manifest:manifest||{faixas:[]},profile,state,history});if(row.licenca!=='CC0-1.0'||!/^assets\/musica\/[a-z0-9-]+\.(?:flac|ogg)$/.test(row.arquivo)||!/^https:\/\//.test(row.fonte)||!row.autor||!row.titulo||!/^https:\/\//.test(row.pagina_licenca||'')||!/(CC0|Creative Commons 0|public.domain|domínio público)/i.test(row.evidencia_licenca||'')||! /^[a-f0-9]{64}$/.test(row.sha256_original||'')||!/^\d{4}-\d{2}-\d{2}$/.test(row.verificado_em))throw Error('music_license_invalid');const bytes=buffers.get(row.arquivo)||await readFile(new URL(row.arquivo,root));if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('music_hash_mismatch');return row;}
const normalized=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
// Critério inalterado (nada é estimado nem aceito a mais). Só o DIAGNÓSTICO mudou: o erro diz o TIPO do problema,
// o índice, as contagens e os tempos — nunca o conteúdo das palavras (observadas ou esperadas), que vai para o log.
// Palavra com tipo diferente de texto é reprovada (sem coerção). Prévia real de 13/11/2026 falhou sem motivo.
const t2=n=>Number.isFinite(n)?n.toFixed(2):'NaN';
const word=w=>typeof w?.word==='string'?normalized(w.word):null;
export function alignmentIssues(alignment,text,duration){
 const words=alignment?.segments?.flatMap(s=>s.words||[])||[];const expected=text.split(/\s+/).map(normalized).filter(Boolean);const issues=[];
 if(words.length!==expected.length){const i=expected.findIndex((e,k)=>word(words[k])!==e);issues.push({tipo:'contagem',texto:`contagem:${words.length}/${expected.length}`+(i>=0?`@${i}`:'')});}
 else words.forEach((w,i)=>{
  const got=word(w);
  if(got===null)issues.push({tipo:'tipo_palavra',texto:`tipo_palavra@${i}`});
  else if(got!==expected[i])issues.push({tipo:'palavra',texto:`palavra@${i}`});
  if(!Number.isFinite(w?.start)||!Number.isFinite(w?.end)||w.start<0)issues.push({tipo:'tempo',texto:`tempo@${i}:${t2(w?.start)}-${t2(w?.end)}`});
  else if(w.end<=w.start)issues.push({tipo:'duracao_zero',texto:`duracao_zero@${i}:${t2(w.start)}-${t2(w.end)}`});
  else if(w.end>duration)issues.push({tipo:'apos_fim',texto:`apos_fim@${i}:${t2(w.end)}>${t2(duration)}`});
  if(i>0&&Number.isFinite(w?.start)&&Number.isFinite(words[i-1]?.end)&&w.start<words[i-1].end-.02)issues.push({tipo:'sobreposicao',texto:`sobreposicao@${i}:${t2(w.start)}<${t2(words[i-1].end)}`});
 });
 return {words,expected,issues};
}
// Tempo do vídeo a partir da fala REAL alinhada (nada é estimado): o cartão de CTA entra em duration-3.5 e precisa
// coincidir com o início falado do CTA. Antes a cauda era fixa (voz + 1,0 s) e a voz Achird fala o CTA em ~1,9 s, então o
// CTA começava ~0,1 s depois da janela (prévia real 13/11: cta_alignment_failed). Agora a cauda de silêncio após a voz
// se ajusta para o cartão coincidir com o CTA falado, limitada a 0,5–2,0 s; fora disso, falha explícita com os tempos.
export const CTA_CARD_SECONDS=3.5,TAIL_MIN=0.5,TAIL_MAX=2.0;
export function shortTiming(voiceDuration,words){
 const n=CTA.split(/\s+/).length,firstCta=words?.length>=n?words[words.length-n]?.start:undefined;
 if(!Number.isFinite(voiceDuration)||voiceDuration<=0||!Number.isFinite(firstCta)||firstCta<0||firstCta>=voiceDuration)throw Error('cta_alignment_failed sem_cta');
 const duration=firstCta+CTA_CARD_SECONDS,tail=duration-voiceDuration;
 if(tail<TAIL_MIN-1e-9||tail>TAIL_MAX+1e-9)throw Error('cta_alignment_failed cta='+t2(firstCta)+' voz='+t2(voiceDuration)+' cauda='+t2(tail));
 if(duration<25||duration>35)throw Error('v2_duration_failed');
 return {duration,ctaStart:duration-CTA_CARD_SECONDS,firstCta,tail};
}
// toleraDuracaoZero (só o v3, legenda por frase): aceita até N palavras com início === fim EXATAMENTE como o alinhador
// devolveu (nenhum tempo nosso), desde que todo o resto passe. Qualquer outro problema, ou mais de N, reprova.
export function alignedWords(alignment,text,duration,{toleraDuracaoZero=0}={}){const r=alignmentIssues(alignment,text,duration),{words,expected}=r;
 const instantaneas=r.issues.filter(x=>x.tipo==='duracao_zero'&&words[+x.texto.match(/@(\d+)/)[1]].end===words[+x.texto.match(/@(\d+)/)[1]].start);
 const issues=instantaneas.length&&instantaneas.length<=toleraDuracaoZero&&instantaneas.length===r.issues.filter(x=>x.tipo==='duracao_zero').length?r.issues.filter(x=>x.tipo!=='duracao_zero'):r.issues;
 if(issues.length){const n={};for(const x of issues)n[x.tipo]=(n[x.tipo]||0)+1;throw Error('alignment_invalid '+issues[0].texto+' ['+Object.entries(n).map(([k,v])=>k+'='+v).join(',')+'; palavras='+words.length+'/'+expected.length+'; duracao='+t2(duration)+']');}return words;}
export function captions(words,{width=1080,height=1920}={}){const header=`[Script Info]\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word,Inter ExtraBold,86,&H0000E5FF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,5,1,5,100,220,300,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
 const time=v=>{const cs=Math.round(v*100);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};return header+words.map(w=>`Dialogue: 0,${time(w.start)},${time(w.end)},Word,,0,0,0,,{\\pos(500,1530)}${w.word.replace(/[{}\\\r\n]/g,'')}`).join('\n')+'\n';}
export function quality(q){const reasons=[];const need=(ok,name)=>{if(!ok)reasons.push(name);};need(Number.isFinite(q.ppm)&&q.ppm>=140&&q.ppm<=185,'voice_speed');need(q.internalSilence<=.9&&q.internalSilence>=0,'voice_silence');need(q.clipping===false,'clipping');need(Number.isFinite(q.voiceLufs)&&Math.abs(q.voiceLufs+16)<=1,'voice_loudness');need(q.duration>=25&&q.duration<=35,'duration');need(Math.abs(q.videoDuration-q.duration)<.05&&q.videoFrames>=Math.floor(q.duration*30)-1,'video_incomplete');need(q.musicDetected===true,'music_absent');need(q.duckingDb>=10,'ducking');need(q.musicBedLufs>=-24&&q.musicBedLufs<=-22,'music_bed_loudness');need(q.voiceMusicDb>=12&&q.voiceMusicDb<=22,'voice_music_balance');need(Number.isFinite(q.mixLufs)&&Math.abs(q.mixLufs+14)<=1,'mix_loudness');need(Number.isFinite(q.truePeak)&&q.truePeak<=-1,'true_peak');need(q.hookStart<=2&&q.hookStart>=0&&q.hookQuestion===true&&q.opensWithLogo===false&&q.hookFont>=96&&q.hookEnd>=q.firstSentenceEnd,'hook');need(q.captionX>=80&&q.captionRight<=918&&q.captionBottom<=1632&&q.captionFont>=72&&q.aligned===true,'caption_safe_area');need(q.textRight<=984&&q.textRight>=0,'text_safe_area');need(q.sceneSentenceAligned===true,'scene_sentence_boundary');need(q.captionContrast>=4.5,'caption_contrast');need(q.sceneMaxGap<=3&&q.sceneMinGap>=2,'visual_rhythm');need(q.ctaSeconds>=3&&q.ctaSeconds<=4&&!forbidden.test(q.cta||'')&&q.cta===CTA,'cta');need(q.voiceFixed===true,'brand_voice');return {score:reasons.length?0:100,ok:reasons.length===0,reasons};}
export async function musicHistory(kv,day,{files=null,repair=true}={}){
 const key='zpc:shorts:v2:musica:last',raw=await kv.get(key);
 const valid=v=>v&&Object.keys(v).sort().join(',')==='arquivo,em'&&/^assets\/musica\/[a-z0-9-]+\.(?:flac|ogg)$/.test(v.arquivo)&&Number.isSafeInteger(v.em)&&v.em>0&&v.em<=Date.now()&&(!files||files.includes(v.arquivo));
 if(raw===null)return null;
 try{const v=JSON.parse(raw);if(valid(v))return v;}catch{}
 // Recover the disposable last-track projection only from readable episode receipts.
 const receipts=[];for(let i=0;i<30;i++){const date=new Date(Date.parse(day+'T12:00:00Z')-i*86400000).toISOString().slice(0,10);for(const slot of ['dica','oferta','calc']){const r=await kv.get('zpc:shorts:v2:musica:receipt:'+date+':'+slot);if(r!==null){const v=JSON.parse(r);if(!valid(v))throw Error('music_receipt_unreadable');receipts.push(v);}}}
 if(!receipts.length)throw Error('music_history_unknown');const last=receipts.sort((a,b)=>b.em-a.em)[0];if(repair)await kv.put(key,JSON.stringify(last));return last;
}

export function planV2(plan,{hotmartOpen=false,history=[]}={}){let last;for(let variant=0;variant<125;variant++){try{const candidate=candidatePlan({...plan,v2Variant:variant},{hotmartOpen});const current=fingerprint(candidate),existing=history.find(r=>r.day===plan.day&&r.slot===plan.slot);if(existing&&existing.sha256!==current.sha256){last=Error('script_slot_conflict');continue;}assertNovel(current,history.filter(r=>r!==existing));return candidate;}catch(e){last=e;if(!/script_repeated_60d|script_similar_30d|spoken_script_invalid/.test(e.message))throw e;}}throw last;}

export async function planV2WithHistory(plan,{kv,note=()=>{},...opts}={}){try{const initial=planV2(plan,opts),history=await scriptHistory(kv,initial,{historyOnly:true});return planV2(plan,{...opts,history});}catch(e){note('warning','SHORT_PLAN '+plan.day+' '+plan.slot+' '+String(e.message).replace(/[^a-z0-9_]/gi,'_'));return null;}}
