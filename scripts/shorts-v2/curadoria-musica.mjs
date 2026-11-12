import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {mkdtemp} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {learnedProfile,candidateDecision,tagVeto,ownerVeto,promote,assertActivation,applyOwnerVeto,learnPerformance,dailyMusicText,REPORT_KEY} from './music-policy.mjs';
import {discoverFreePD,boundedFetch} from './music-discovery.mjs';
import {musicPublications,updateObservation} from './music-publications.mjs';
import {STATE_KEY,strictState,persistCuration,writeMusicReport,MAX_TRACK_BYTES,MAX_TRACKS} from './music-kv.mjs';
import {retentionWindow} from './music-analytics.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const load=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
function run(cmd,args){const p=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:8*1024*1024});if(p.status!==0)throw Error('curation_tool_failed:'+cmd);return p.stdout;}
export async function runCuration({profile,manifest,state,day,monthly=false,kv=null,token=null,fetchImpl=fetch,measure,prepare,discover=discoverFreePD,availableBytes=Infinity}={}){
 profile=learnedProfile(profile,manifest);assertActivation(profile);let next=applyOwnerVeto(profile,state,day),publications=[],analytics='sem_dados';const decisions=[];
 if(kv){publications=await musicPublications(kv,day,90);next=updateObservation(next,publications);const end=Date.parse(day+'T12:00:00Z')-3*86400000;for(const [a,b] of [[27,14],[13,0]]){const start=new Date(end-a*86400000).toISOString().slice(0,10),finish=new Date(end-b*86400000).toISOString().slice(0,10),window=await retentionWindow(token,start,finish,publications,{fetchImpl});next=learnPerformance(next,profile,window);decisions.push({tipo:'analytics',status:window.status,start,end:finish,reason:window.reason||null});if(window.status==='verified'&&window.rows.some(r=>r.arquivo&&window.rows.filter(x=>x.arquivo===r.arquivo).length>=10))analytics='verified';}}
 const accepted=[];const capacity=MAX_TRACKS-Object.keys(next.catalogo||{}).length;if(monthly&&capacity>0&&(next.meses[day.slice(0,7)]||[]).length<Math.min(2,profile.descoberta.max_por_mes)){const found=await discover({fetchImpl,max:profile.descoberta.max_candidatas});decisions.push(...found.warnings.map(reason=>({tipo:'catalogo',reason})));let tried=0;
 for(const row of found.candidates){if(tried>=profile.descoberta.max_candidatas)break;if(tagVeto(row,profile)||ownerVeto(row,profile)||manifest.faixas.some(r=>r.titulo===row.titulo)){decisions.push({titulo:row.titulo,status:'vetada_ou_existente'});continue;}tried++;
 try{const candidate=await prepare(row,day,fetchImpl);candidate.atributos=await measure(candidate);const d=candidateDecision(candidate,profile);decisions.push({titulo:row.titulo,...d});if(d.ok)accepted.push(candidate);}catch(e){decisions.push({titulo:row.titulo,status:'bloqueada',reason:String(e.message).slice(0,80)});}
 }}
 next.analytics={status:analytics,day,reason:analytics==='verified'?null:'permissao_dados_ou_amostra_insuficiente'};
 const promoted=promote(accepted.filter(r=>!r.tamanho_bytes||r.tamanho_bytes<=MAX_TRACK_BYTES),profile,next,day,{availableBytes,maxPromotions:Math.max(0,capacity)});return {state:promoted.state,promoted:promoted.promoted,decisions,analytics,report:dailyMusicText(profile,promoted.state)};
}
export async function main(argv=process.argv.slice(2)){
 let profile=await load('data/musica-perfil.json');try{assertActivation(profile);}catch{return {status:'desligada',network_calls:0,promotions:0};}
 const {cloudflareKv}=await import('../channels/youtube-daily-short.mjs'),{getYoutubeAccessToken}=await import('../channels/youtube-access.mjs');
 const kv=cloudflareKv({token:process.env.CLOUDFLARE_API_TOKEN,account:process.env.CLOUDFLARE_ACCOUNT_ID,namespace:process.env.KV_NAMESPACE_ID});
 if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID||!process.env.KV_NAMESPACE_ID)throw Error('curation_kv_credentials_missing');
 const manifest=await load('data/musica-licencas.json'),baseState=await load('data/musica-curadoria.json'),day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 let state;try{state=strictState(await kv.get(STATE_KEY),baseState);}catch{await writeMusicReport(kv,profile,baseState,day,['music_kv_state_unreadable_using_repository']);throw Error('music_kv_state_unreadable');}
 const catalog={faixas:[...manifest.faixas,...Object.values(state.catalogo)]};profile=learnedProfile(profile,catalog);
 const output=process.env.RUNNER_TEMP||tmpdir(),work=await mkdtemp(join(output,'zev-curation-'));let token=null;try{token=await getYoutubeAccessToken();}catch{}
 try{
 const usedBytes=Object.values(state.catalogo).reduce((n,r)=>n+r.tamanho_bytes,0);
 const prepared=new Map(),model=process.env.SHORTS_VOCAL_MODEL;if(!model)throw Error('vocal_model_required');
 const result=await runCuration({profile,manifest:catalog,state,day,monthly:argv.includes('--monthly'),kv,token,availableBytes:MAX_TRACKS*MAX_TRACK_BYTES-usedBytes,
 prepare:async(row,date,fetchImpl)=>{const bytes=await boundedFetch(row.fonte,{fetchImpl}),id='cc0-'+sha(bytes).slice(0,16),source=join(work,id+'.mp3'),cut=join(work,id+'.ogg');await writeFile(source,bytes);run('ffmpeg',['-v','error','-y','-protocol_whitelist','file,pipe','-f','mp3','-i',source,'-t','36','-af','loudnorm=I=-28:TP=-4:LRA=7','-ar','44100','-ac','2','-c:a','libvorbis','-q:a','4',cut]);const info=JSON.parse(run('ffprobe',['-v','error','-show_format','-of','json',cut]));if(Number(info.format.duration)<35||Number(info.format.duration)>40)throw Error('music_excerpt_duration_invalid');const excerpt=await readFile(cut),c={...row,arquivo:'assets/musica/'+id+'.ogg',sha256_original:sha(bytes),sha256:sha(excerpt),verificado_em:date,tamanho_bytes:excerpt.length,trecho_inicio:0,trecho_segundos:36,credito:row.titulo+' — '+row.autor+' (CC0).'};prepared.set(c.arquivo,cut);return c;},
 measure:async c=>JSON.parse(run('python3',[fileURLToPath(new URL('./audio-features.py',import.meta.url)),prepared.get(c.arquivo),model]))});
 const saved=await persistCuration({kv,result,profile,baseState,day,bytesFor:async row=>prepared.has(row.arquivo)?readFile(prepared.get(row.arquivo)):null});result.state=saved.state;result.warnings=saved.warnings;
 await mkdir(join(output,'music-curation-report'),{recursive:true});await writeFile(join(output,'music-curation-report/resultado.json'),JSON.stringify({...result,promoted:result.promoted.map(r=>({arquivo:r.arquivo,sha256:r.sha256}))},null,2)+'\n');return {status:'concluida',promotions:result.promoted.length,analytics:result.analytics};
 }finally{await rm(work,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await main()));
