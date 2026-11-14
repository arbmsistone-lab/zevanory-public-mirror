// Shorts v3: roteiro com dor concreta, produto real calculando (planilha do kit), números com proveniência,
// oferta oficial. Reaproveita do v2 a voz (Achird), o alinhamento, o tempo do CTA e o áudio (mix + loudnorm em duas
// passagens). O visual são quadros desenhados por fala (quadros.py) com transições, e legendas em grupos de até
// 3 palavras na área segura. Antes de qualquer uso, o próprio Laboratório de Criativos avalia e decide.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,isAbsolute} from 'node:path';
import MANIFEST from '../../data/musica-licencas.json' with {type:'json'};
import {command,runAligner,tts,audioMetrics,rmsDb,mixGraph,normalizeTwoPass} from '../shorts-v2/render.mjs';
import {STYLE} from '../shorts-v2/core.mjs';
// Prévia real 43601408721: o pedido de voz "mais calma" piorou o alinhamento (7 palavras instantâneas e grupo final
// com 0 s). Volta ao estilo original; a velocidade é corrigida no áudio pronto (VOZ_ATEMPO), antes do alinhamento.
export const ESTILO_V3=STYLE;
export const VOZ_ATEMPO=0.95;
export const FILTRO_VOZ_V3=`highpass=f=80,atempo=${VOZ_ATEMPO},deesser=i=0.15:m=0.3:f=0.5,acompressor=threshold=0.25:ratio=2:attack=10:release=100`;
export function duracaoAudio(arquivo,run=command){const d=Number(JSON.parse(run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',arquivo])).format?.duration);if(!(d>0))throw Error('v3_duracao_voz_invalida');return d;}
import {CTA,alignedWords,shortTiming,licensedTrack,assertVoice,quality} from '../shorts-v2/core.mjs';
import {avaliar,permitidosDaProveniencia,precosOficiais,registrarDecisao} from '../criativos/avaliador.mjs';
import {createHash} from 'node:crypto';
import {ofertaPublicada} from '../criativos/afirmacoes.mjs';
import {CRITERIOS,montarPadrao,validarPadrao} from '../criativos/padrao.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const AUDIO_REASONS=new Set(['voice_speed','voice_silence','clipping','voice_loudness','duration','music_absent','ducking','music_bed_loudness','voice_music_balance','mix_loudness','true_peak','cta','brand_voice']);
export async function carregarSpec(path){
 const spec=JSON.parse(await readFile(join(ROOT,path),'utf8'));
 if(spec.schema!==1||!Array.isArray(spec.falas)||spec.falas.length<6||spec.falas.at(-1).texto!==CTA+'.'||!Array.isArray(spec.provas)||!spec.provas.length)throw Error('v3_spec_invalida');
 return spec;
}
// Todo número mostrado precisa bater com a conta e com o que a planilha real calculou (proveniência versionada).
// NC-R05: integridade da prova — proveniência e capturas precisam bater com o manifesto de hashes.
const noRepo=f=>isAbsolute(f)?f:join(ROOT,f);
export async function conferirManifesto(spec){
 if(typeof spec.manifesto!=='string')throw Error('v3_manifesto_ausente');
 const M=JSON.parse(await readFile(noRepo(spec.manifesto),'utf8')),req=[spec.proveniencia_numeros,...spec.provas.map(p=>p.captura).filter(p=>p.startsWith('assets/shorts-v3/'))];
 for(const f of req){const h=M.arquivos?.[f];if(!h)throw Error('v3_manifesto_sem:'+f);const bruto=await readFile(noRepo(f)),real=createHash('sha256').update(/\.json$/.test(f)?Buffer.from(bruto.toString('utf8').replace(/\r\n/g,'\n')):bruto).digest('hex');if(real!==h)throw Error('v3_proveniencia_adulterada:'+f);}
 return JSON.parse(await readFile(noRepo(spec.proveniencia_numeros),'utf8'));
}
export async function conferirNumeros(spec){
 const N=spec.numeros,P=await conferirManifesto(spec),E=P.entradas,R=P.resultados_calculados_pela_planilha,motivos=[];
 if(E['Preço atual']!==N.preco_venda)motivos.push('preco_venda_divergente');
 if(E['Custo direto unit.']+E['Outros custos var. unit.']!==N.custo_produto_frete)motivos.push('custo_divergente');
 if(Math.round(E['Preço atual']*E['Taxa pagamento %']*100)/100!==N.taxa_cartao||Math.round(E['Taxa pagamento %']*100)!==N.taxa_cartao_pct)motivos.push('taxa_divergente');
 if(N.preco_venda-N.custo_produto_frete-N.taxa_cartao!==N.margem_antes_fixas||R['Contribuição/unit.']!==N.margem_antes_fixas)motivos.push('margem_divergente');
 const pct=v=>(Math.round(v*1000)/10).toFixed(1).replace('.',',')+'%';
 if(pct(R['Margem contribuição %'])!==N.margem_pct)motivos.push('margem_pct_divergente');
 if(R['Preço mínimo p/ margem alvo']!==N.preco_minimo)motivos.push('preco_minimo_divergente');
 if(pct(R['Desconto máx. p/ margem alvo'])!==N.desconto_maximo)motivos.push('desconto_divergente');
 if(R.Status!=='OK'||P.margem_alvo_config*100!==N.meta_margem_pct)motivos.push('planilha_status_ou_meta');
 return motivos;
}
// Grupos de até 3 palavras; a palavra falada fica amarela. Posição na área segura (centro x=470, y=1380).
// Grupos da legenda v3 (mesma divisão de legendasV3) que ficariam menos de `min` segundos na tela.
export function gruposCurtosV3(words,porFala,fim,min=0.3){const g=[];let ini=0;for(const n of porFala){for(let a=ini;a<ini+n;a+=3)g.push(a);ini+=n;}
 return g.map((a,i)=>{const fimGrupo=i+1<g.length?words[g[i+1]].start:fim;return [a,fimGrupo-words[a].start];}).filter(([,d])=>!(d>=min)).map(([a,d])=>`${a}:${d.toFixed(2)}`);}
export const DESTAQUE_MIN_S=0.12;
export function legendasV3(words,porFala=[words.length]){
 const t=v=>{const cs=Math.round(v*100);return `${Math.floor(cs/360000)}:${String(Math.floor(cs/6000)%60).padStart(2,'0')}:${String(Math.floor(cs/100)%60).padStart(2,'0')}.${String(cs%100).padStart(2,'0')}`;};
 const clean=s=>String(s).trim().replace(/[{}\\\r\n]/g,'');
 const head=`[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: G,Inter ExtraBold,74,&H00FFFFFF,&H00FFFFFF,&H00140D09,&H99000000,-1,0,0,0,100,100,0,0,1,6,0,5,64,140,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
 const ev=[],grupos=[];let ini=0;
 // Grupos nunca atravessam o fim de uma fala (frase): cada frase começa um grupo novo.
 for(const n of porFala){for(let g=ini;g<ini+n;g+=3)grupos.push([g,Math.min(g+3,ini+n)]);ini+=n;}
 if(ini!==words.length)throw Error('v3_legenda_contagem');
 for(const [a,b] of grupos){const grp=words.slice(a,b),fimGrupo=Math.max((words[b]||{start:grp.at(-1).end}).start,grp.at(-1).end);
  const fins=grp.map((w,k)=>Math.max((grp[k+1]||words[b]||{start:w.end}).start,w.end));
  // NC-1048-01: se o destaque de alguma palavra ficaria menos de DESTAQUE_MIN_S na tela (palavra instantânea do
  // alinhador), o grupo inteiro aparece destacado de forma estável do início ao fim do grupo — nenhum tempo é inventado.
  if(grp.some((w,k)=>fins[k]-w.start<DESTAQUE_MIN_S)){ev.push(`Dialogue: 0,${t(grp[0].start)},${t(fimGrupo)},G,,0,0,0,,{\\pos(470,1380)}{\\c&H000AD6FF&}`+grp.map(x=>clean(x.word)).join(' '));continue;}
  for(let k=0;k<grp.length;k++){const w=grp[k];
  ev.push(`Dialogue: 0,${t(w.start)},${t(fins[k])},G,,0,0,0,,{\\pos(470,1380)}`+grp.map((x,i)=>i===k?`{\\c&H000AD6FF&}${clean(x.word)}{\\c&H00FFFFFF&}`:clean(x.word)).join(' '));}}
 // Garantia no arquivo gerado: nenhum evento de legenda com menos de DESTAQUE_MIN_S na tela.
 const curto=ev.find(l=>{const c=l.split(','),x=v=>{const [h,m,q]=v.split(':');return +h*3600+ +m*60+ +q;};return x(c[2])-x(c[1])<DESTAQUE_MIN_S-0.015;});// folga de 1 centésimo do arredondamento do .ass
 if(curto)throw Error('v3_legenda_evento_curto');
 return head+ev.join('\n')+'\n';
}
function pcmOf(file){return command('ffmpeg',['-v','error','-i',file,'-f','f32le','-ac','1','-ar','24000','pipe:1'],{buffer:true});}
export async function renderV3(specPath,base,{geminiKey,config,preview=true,synthesize=tts,padrao=null,avaliarImpl=avaliar,align=null,oferta=ofertaPublicada,commit=process.env.GITHUB_SHA||null,note=m=>console.log(m)}={}){
 assertVoice(config,config?.voz_fixa,{preview});
 const spec=await carregarSpec(specPath),numeros=await conferirNumeros(spec);
 if(numeros.length)throw Error('v3_numeros_divergentes:'+numeros.join('+'));
 if(/[\[\]';:,\\]/.test(base))throw Error('unsafe_media_path');
 await mkdir(dirname(base),{recursive:true});
 const speech=spec.falas.map(f=>f.texto).join(' ');
 // Prévia real 43545028933: ppm=188,3 (limite 185) no roteiro v3, mais denso em números que o v2. Mesma voz e estilo,
 // com pedido explícito de ritmo mais calmo e pausa curta entre frases.
 const generated=await synthesize(speech,config.voz_fixa,geminiKey,{model:config.modelo,freeTierConfirmed:config.nivel_gratuito_confirmado,style:ESTILO_V3});
 assertVoice(config,generated.voice,{preview,model:generated.model});
 await writeFile(base+'.pcm',generated.pcm);await writeFile(base+'-roteiro.txt',speech);
 let clipping=false;for(let i=0;i+1<generated.pcm.length;i+=2)if(Math.abs(generated.pcm.readInt16LE(i))>=32760){clipping=true;break;}
 // Mesma cadeia do v2, mas o loudnorm da voz em DUAS passagens (prévia real: voice_loudness e ducking fora do alvo).
 command('ffmpeg',['-y','-f','s16le','-ar','24000','-ac','1','-i',base+'.pcm','-af',FILTRO_VOZ_V3,'-c:a','pcm_s16le',base+'-voz-tratada.wav']);
 normalizeTwoPass(base+'-voz-tratada.wav',base+'-voz.wav',{I:-16,TP:-1.5,LRA:7});
 // NC-1052-01: a duração vem do WAV EFETIVAMENTE processado (o atempo muda a duração); usada no alinhamento, nas
 // cenas, nas legendas, na composição e nas métricas.
 const voiceDuration=duracaoAudio(base+'-voz.wav');
 let alignment;if(align)alignment=await align(base+'-voz.wav',speech);else{runAligner([base+'-voz.wav',base+'-roteiro.txt',base+'-alignment.json']);alignment=JSON.parse(await readFile(base+'-alignment.json','utf8'));}
 // Prévia real 43594272962 (voz mais calma): o modelo small deixou 5 palavras curtas instantâneas (início === fim).
 // A regra do v3 passa a ser pelo EFEITO VISÍVEL, não por contagem arbitrária: tempos exatamente do alinhador, no
 // máximo 10% das palavras instantâneas, e todo grupo de legenda (até 3 palavras, nunca atravessa frase) na tela por
 // pelo menos 0,30 s. Se algum grupo ficaria curto demais, reprova.
 const nPalavras=speech.split(/\s+/).filter(Boolean).length;
 const words=alignedWords(alignment,speech,voiceDuration,{toleraDuracaoZero:Math.floor(nPalavras*0.1)});
 const curtos=gruposCurtosV3(words,spec.falas.map(f=>f.texto.split(/\s+/).filter(Boolean).length),voiceDuration);
 if(curtos.length)throw Error('v3_legenda_grupo_curto:'+curtos.slice(0,3).join(','));
 const {duration,firstCta}=shortTiming(voiceDuration,words);
 // Início de cada fala = início real da 1ª palavra dela.
 let cursor=0;const cenas=spec.falas.map((f,i)=>{const n=f.texto.split(/\s+/).filter(Boolean).length,start=i===0?0:words[cursor].start;cursor+=n;return {quadro:f.quadro,start};});
 cenas.forEach((c,i)=>{c.end=i+1<cenas.length?cenas[i+1].start:duration;});
 if(cursor!==words.length||cenas.some(c=>!(c.end-c.start>0.4)))throw Error('v3_cenas_invalidas');
 // Música licenciada (CC0) com hash conferido; mix com ducking; loudnorm em duas passagens.
 const track=await licensedTrack({theme:'financas',manifest:MANIFEST});
 const trackPath=join(ROOT,track.arquivo);
 command('ffmpeg',['-y','-i',base+'-voz.wav','-i',trackPath,'-filter_complex',mixGraph(duration),'-map','[mix]','-t',String(duration),base+'-mix-pass1.wav','-map','[reference]','-t',String(duration),base+'-musica-reference.wav','-map','[stem]','-t',String(duration),base+'-musica-ducked.wav']);
 normalizeTwoPass(base+'-mix-pass1.wav',base+'-mix.wav');
 // Quadros desenhados (as medidas do desenho NÃO são usadas na avaliação; quem mede é medir.py no vídeo).
 const desenho=JSON.parse(command('python3',['-E','-P',join(ROOT,'scripts/shorts-v3/quadros.py'),ROOT,join(ROOT,specPath),base+'-quadros']));
 await writeFile(base+'-legendas.ass',legendasV3(words,spec.falas.map(f=>f.texto.split(/\s+/).filter(Boolean).length)));
 // Cortes secos entre quadros (sem transição deslizante/fundida): todo estado do vídeo é um quadro desenhado inteiro,
 // dentro da área segura — a varredura completa do MP4 (medir.py) não encontra texto cortado ou em movimento.
 const inputs=[],parts=[];
 cenas.forEach((c,i)=>{inputs.push('-loop','1','-framerate','30','-t',String(c.end-c.start),'-i',desenho.quadros[c.quadro]);parts.push(`[${i}:v]scale=1080:1920,fps=30,format=yuv420p,setsar=1[s${i}]`);});
 parts.push(cenas.map((_,i)=>`[s${i}]`).join('')+`concat=n=${cenas.length}:v=1:a=0[vx]`);const last='vx';
 const fontsdir=dirname(join(ROOT,'assets/fonts/Inter-ExtraBold.ttf'));
 parts.push(`[${last}]ass=${base}-legendas.ass:fontsdir=${fontsdir},trim=duration=${duration}[v]`);
 await writeFile(base+'-filter.txt',parts.join(';\n'));
 command('ffmpeg',['-y','-filter_threads','1',...inputs,'-i',base+'-mix.wav','-filter_complex_script',base+'-filter.txt','-map','[v]','-map',`${cenas.length}:a`,'-t',String(duration),'-c:v','libx264','-threads','2','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',base+'.mp4']);
 // Áudio: mesmos critérios do v2 (só os de áudio/CTA).
 const voice=audioMetrics(base+'-voz.wav'),mix=audioMetrics(base+'.mp4'),windows=words.map(w=>({start:w.start,end:w.end}));
 const musicDb=rmsDb(pcmOf(base+'-musica-ducked.wav'),windows),referenceDb=rmsDb(pcmOf(base+'-musica-reference.wav'),windows),voiceDb=rmsDb(pcmOf(base+'-voz.wav'),windows);
 let internalSilence=0;for(let i=0;i<voice.starts.length;i++)if(voice.starts[i]>.1&&voice.starts[i]<words.at(-1).end-.1)internalSilence=Math.max(internalSilence,(voice.ends[i]??voiceDuration)-voice.starts[i]);
 const probe=JSON.parse(command('ffprobe',['-v','error','-show_format','-show_streams','-of','json',base+'.mp4'])),videoDuration=Number(probe.format.duration);
 const metrics={musicBedLufs:audioMetrics(base+'-musica-reference.wav').lufs,ppm:words.length/voiceDuration*60,internalSilence,clipping:clipping||voice.peak>=0,voiceLufs:voice.lufs,duration,videoDuration,musicDetected:Number.isFinite(musicDb)&&musicDb>-70,duckingDb:referenceDb-musicDb,voiceMusicDb:voiceDb-musicDb,mixLufs:mix.lufs,truePeak:mix.peak,ctaSeconds:duration-firstCta,cta:CTA,voiceFixed:generated.voice===config.voz_fixa,videoFrames:Math.round(videoDuration*30)};
 const audio=quality(metrics).reasons.filter(r=>AUDIO_REASONS.has(r));
 if(Math.abs(videoDuration-duration)>0.15)audio.push('video_incomplete');
 // Laboratório de Criativos: MEDE o vídeo renderizado INTEIRO (todo estado visual distinto do MP4, OCR + correlação
 // com as capturas reais); o júri de IA recebe um quadro por fala,
 // confere as afirmações e a oferta publicada, e o júri de IA dá as notas. Nada declarado pelo criativo vale como medida.
 const quadros=[],quadrosJuri=[];
 for(const c of cenas){const t=String(Math.min(c.end-0.05,c.start+Math.min(1.2,(c.end-c.start)*0.7))),p=`${base}-medir-${quadros.length}.png`,pj=`${base}-juri-${quadros.length}.png`;
  command('ffmpeg',['-y','-v','error','-ss',t,'-i',base+'.mp4','-frames:v','1',p]);command('ffmpeg',['-y','-v','error','-i',p,'-vf','scale=540:960',pj]);quadros.push(p);quadrosJuri.push(await readFile(pj));}
 await writeFile(base+'-medir.json',JSON.stringify({video:base+'.mp4',pasta_estados:base+'-estados',provas:spec.provas.map(p=>({captura:join(ROOT,p.captura),largura:p.largura}))}));
 const medicao=JSON.parse(command('python3',['-E','-P',join(ROOT,'scripts/criativos/medir.py'),base+'-medir.json']));
 const O=spec.oferta,cat=precosOficiais()[spec.sku];
 let oficial=null;try{oficial=await oferta(spec.slug);}catch(e){note('OFERTA_PUBLICADA indisponivel '+String(e.message||e).slice(0,60));}
 const criativo={sku:spec.sku,falas:spec.falas.map(f=>f.texto),oferta:{nome:O.nome,preco:O.preco}};
 const pad=validarPadrao(padrao||montarPadrao({evidencia:[],geradoEm:'base'}));
 const avaliacao=await avaliarImpl({criativo,padrao:pad,quadrosPng:quadrosJuri,medicao,permitidos:permitidosDaProveniencia(await conferirManifesto(spec),cat?.[1]),oficial,key:geminiKey});
 if(audio.length){avaliacao.aprovado=false;avaliacao.decisao='DESCARTADO';avaliacao.motivos=[...audio.map(r=>'audio:'+r),...avaliacao.motivos];}
 const qc={audio:{ok:audio.length===0,reasons:audio},metrics,medicao,avaliacao,padrao:pad.geradoEm,criterios:CRITERIOS.map(c=>c.id),track,mode:preview?'preview':'production'};
 await writeFile(base+'-qc.json',JSON.stringify(qc,null,2));
 const decisao=registrarDecisao({videoBytes:await readFile(base+'.mp4'),sku:spec.sku,avaliacao,padrao:pad,commit,oficial,chave:process.env.CRIATIVOS_DECISAO_KEY||null});await writeFile(base+'-decisao.json',JSON.stringify(decisao,null,2));await writeFile(base+'-cenas.json',JSON.stringify(cenas,null,2));
 note(`CRIATIVO_V3 ${spec.sku} decisao=${avaliacao.decisao} nota_geral=${avaliacao.nota_geral??'n/d'} notas=${avaliacao.juri?JSON.stringify(avaliacao.juri.notas):'n/d'} motivos=${avaliacao.motivos.join(',')||'-'}${avaliacao.erro?' erro='+avaliacao.erro:''}`);
 for(const p of avaliacao.juri?.problemas||[])note('PROBLEMA '+p);for(const p of avaliacao.juri?.melhorias||[])note('MELHORIA '+p);
 const n2=x=>Number.isFinite(x)?x.toFixed(2):'NaN';
 note(`AUDIO_V3 mixLufs=${n2(mix.lufs)} truePeak=${n2(mix.peak)} voiceLufs=${n2(metrics.voiceLufs)} duckingDb=${n2(metrics.duckingDb)} voiceMusicDb=${n2(metrics.voiceMusicDb)} musicBedLufs=${n2(metrics.musicBedLufs)} ppm=${n2(metrics.ppm)} silencio=${n2(metrics.internalSilence)} duracao=${n2(duration)} ${audio.length?'falhas='+audio.join('+'):'ok'}`);
 return {file:base+'.mp4',duration,qc,avaliacao,decisao};
}
