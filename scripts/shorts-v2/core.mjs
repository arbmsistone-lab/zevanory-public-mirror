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
export function planV2(plan,{hotmartOpen=false}={}){
 const theme=themeFor(plan),sentences=scriptFor(plan),episode=episodeScript(plan);
 if(plan.purchase!=='hotmart'&&hotmartOpen!==true)throw Error('v2_kit_not_available_sales_lock');
 const sku=plan.entry.product.sku||({ia:'ZEV-IA-011',vendas:'ZEV-VEN-011',financas:'ZEV-LCX-011',dicas:'ZEV-NGC-011'})[theme],kit=ALLOW.products.find(p=>p.kind==='kit'&&p.sku===sku);
 if(!kit)throw Error('v2_kit_missing');
 const link=new URL('https://vendas.zevanory.api.br/hotmart/'+kit.slug);link.searchParams.set('utm_source','youtube');link.searchParams.set('utm_medium','shorts');link.searchParams.set('utm_campaign',theme);
 const warnings=theme==='dicas'&&!themeBySku[plan.entry?.product?.sku]?['theme_ambiguous_using_dicas']:[];
 return {...plan,screen:{...plan.screen,product:kit.name},v2:true,theme,episode,warnings,sentences,speech:sentences.join(' '),link:link.href,description:[sentences[0],link.href,'#Shorts #ZEVANORY',plan.marker].join('\n'),containsSyntheticMedia:true};
}
export function assertVoice(config,voice,{preview=false,model=config?.modelo}={}){if(!config||voice!==config.voz_fixa)throw Error('brand_voice_changed');if(!config.modelo||model!==config.modelo)throw Error('brand_model_changed');if(config.comparacao_aprovada!==true||config.nivel_gratuito_confirmado!==true)throw Error('voice_comparison_or_free_tier_pending');if(!preview&&config.publicacao_aprovada!==true)throw Error('owner_preview_approval_pending');}
export async function licensedTrack({theme,last=null,manifest,root=new URL('../../',import.meta.url)}){if(last!==null&&(!last||typeof last.arquivo!=='string'||!Number.isFinite(last.em)))throw Error('music_history_unreadable');const candidates=manifest?.faixas?.filter(r=>r.temas_permitidos?.includes(theme)&&r.arquivo!==last?.arquivo);if(!candidates?.length)throw Error('licensed_music_missing');const row=candidates[0];if(row.licenca!=='CC0-1.0'||!/^assets\/musica\/[a-z0-9-]+\.(?:flac|ogg)$/.test(row.arquivo)||!/^https:\/\//.test(row.fonte)||!row.autor||!row.titulo||!/^https:\/\//.test(row.pagina_licenca||'')||!/(CC0|Creative Commons 0|public.domain|domínio público)/i.test(row.evidencia_licenca||'')||! /^[a-f0-9]{64}$/.test(row.sha256_original||'')||!/^\d{4}-\d{2}-\d{2}$/.test(row.verificado_em))throw Error('music_license_invalid');const bytes=await readFile(new URL(row.arquivo,root));if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error('music_hash_mismatch');return row;}
const normalized=s=>s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
export function alignedWords(alignment,text,duration){const words=alignment?.segments?.flatMap(s=>s.words||[])||[];const expected=text.split(/\s+/).map(normalized).filter(Boolean);if(words.length!==expected.length||words.some((w,i)=>normalized(w.word)!==expected[i]||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<=w.start||w.end>duration||i>0&&w.start<words[i-1].end-.02))throw Error('alignment_invalid');return words;}
export function captions(words,{width=1080,height=1920}={}){const header=`[Script Info]\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Word,Inter ExtraBold,86,&H0000E5FF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,5,1,5,100,220,300,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
 const time=v=>{const cs=Math.round(v*100);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};return header+words.map(w=>`Dialogue: 0,${time(w.start)},${time(w.end)},Word,,0,0,0,,{\\pos(500,1420)}${w.word.replace(/[{}\\\r\n]/g,'')}`).join('\n')+'\n';}
export function quality(q){const reasons=[];const need=(ok,name)=>{if(!ok)reasons.push(name);};need(Number.isFinite(q.ppm)&&q.ppm>=140&&q.ppm<=185,'voice_speed');need(q.internalSilence<=.9&&q.internalSilence>=0,'voice_silence');need(q.clipping===false,'clipping');need(Number.isFinite(q.voiceLufs)&&Math.abs(q.voiceLufs+16)<=1,'voice_loudness');need(q.duration>=25&&q.duration<=35,'duration');need(q.musicDetected===true,'music_absent');need(q.duckingDb>=10,'ducking');need(q.voiceMusicDb>=12,'voice_music_balance');need(Number.isFinite(q.mixLufs)&&Math.abs(q.mixLufs+14)<=1,'mix_loudness');need(Number.isFinite(q.truePeak)&&q.truePeak<=-1,'true_peak');need(q.hookStart<=2&&q.hookStart>=0&&q.hookQuestion===true&&q.opensWithLogo===false&&q.hookFont>=96&&q.hookEnd>=q.firstSentenceEnd,'hook');need(q.captionX>=80&&q.captionRight<=918&&q.captionBottom<=1632&&q.captionFont>=72&&q.aligned===true,'caption_safe_area');need(q.sceneMaxGap<=3&&q.sceneMinGap>=2,'visual_rhythm');need(q.ctaSeconds>=3&&q.ctaSeconds<=4&&!forbidden.test(q.cta||'')&&q.cta===CTA,'cta');need(q.voiceFixed===true,'brand_voice');return {score:reasons.length?0:100,ok:reasons.length===0,reasons};}
export async function musicHistory(kv,day,{files=null,repair=true}={}){
 const key='zpc:shorts:v2:musica:last',raw=await kv.get(key);
 const valid=v=>v&&Object.keys(v).sort().join(',')==='arquivo,em'&&/^assets\/musica\/[a-z0-9-]+\.(?:flac|ogg)$/.test(v.arquivo)&&Number.isSafeInteger(v.em)&&v.em>0&&v.em<=Date.now()&&(!files||files.includes(v.arquivo));
 if(raw===null)return null;
 try{const v=JSON.parse(raw);if(valid(v))return v;}catch{}
 // Recover the disposable last-track projection only from readable episode receipts.
 const receipts=[];for(let i=0;i<30;i++){const date=new Date(Date.parse(day+'T12:00:00Z')-i*86400000).toISOString().slice(0,10);for(const slot of ['dica','oferta','calc']){const r=await kv.get('zpc:shorts:v2:musica:receipt:'+date+':'+slot);if(r!==null){const v=JSON.parse(r);if(!valid(v))throw Error('music_receipt_unreadable');receipts.push(v);}}}
 if(!receipts.length)throw Error('music_history_unknown');const last=receipts.sort((a,b)=>b.em-a.em)[0];if(repair)await kv.put(key,JSON.stringify(last));return last;
}
