import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {mkdtemp} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import {learnedProfile,candidateDecision,tagVeto,ownerVeto,promote,assertActivation,applyOwnerVeto,learnPerformance,dailyMusicText,REPORT_KEY} from './music-policy.mjs';
import {discoverFreePD,boundedFetch} from './music-discovery.mjs';
import {musicPublications,updateObservation} from './music-publications.mjs';
import {retentionWindow} from './music-analytics.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const load=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
function run(cmd,args){const p=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:8*1024*1024});if(p.status!==0)throw Error('curation_tool_failed:'+cmd);return p.stdout;}
export async function runCuration({profile,manifest,state,day,monthly=false,kv=null,token=null,fetchImpl=fetch,measure,prepare,discover=discoverFreePD,availableBytes=Infinity}={}){
 profile=learnedProfile(profile,manifest);assertActivation(profile);let next=applyOwnerVeto(profile,state,day),publications=[],analytics='sem_dados';const decisions=[];
 if(kv){publications=await musicPublications(kv,day,90);next=updateObservation(next,publications);const end=Date.parse(day+'T12:00:00Z')-3*86400000;for(const [a,b] of [[27,14],[13,0]]){const start=new Date(end-a*86400000).toISOString().slice(0,10),finish=new Date(end-b*86400000).toISOString().slice(0,10),window=await retentionWindow(token,start,finish,publications,{fetchImpl});next=learnPerformance(next,profile,window);decisions.push({tipo:'analytics',status:window.status,start,end:finish,reason:window.reason||null});if(window.status==='verified'&&window.rows.some(r=>r.arquivo&&window.rows.filter(x=>x.arquivo===r.arquivo).length>=10))analytics='verified';}}
 const accepted=[];if(monthly&&(next.meses[day.slice(0,7)]||[]).length<Math.min(2,profile.descoberta.max_por_mes)){const found=await discover({fetchImpl,max:profile.descoberta.max_candidatas});decisions.push(...found.warnings.map(reason=>({tipo:'catalogo',reason})));let tried=0;
 for(const row of found.candidates){if(tried>=profile.descoberta.max_candidatas)break;if(tagVeto(row,profile)||ownerVeto(row,profile)||manifest.faixas.some(r=>r.titulo===row.titulo)){decisions.push({titulo:row.titulo,status:'vetada_ou_existente'});continue;}tried++;
 try{const candidate=await prepare(row,day,fetchImpl);candidate.atributos=await measure(candidate);const d=candidateDecision(candidate,profile);decisions.push({titulo:row.titulo,...d});if(d.ok)accepted.push(candidate);}catch(e){decisions.push({titulo:row.titulo,status:'bloqueada',reason:String(e.message).slice(0,80)});}
 }}
 next.analytics={status:analytics,day,reason:analytics==='verified'?null:'permissao_dados_ou_amostra_insuficiente'};
 const promoted=promote(accepted,profile,next,day,{availableBytes});return {state:promoted.state,promoted:promoted.promoted,decisions,analytics,report:dailyMusicText(profile,promoted.state)};
}
export async function main(argv=process.argv.slice(2)){
 let profile=await load('data/musica-perfil.json');try{assertActivation(profile);}catch{return {status:'desligada',network_calls:0,promotions:0};}
 const {cloudflareKv}=await import('../channels/youtube-daily-short.mjs'),{getYoutubeAccessToken}=await import('../channels/youtube-access.mjs');
 const kv=cloudflareKv({token:process.env.CLOUDFLARE_API_TOKEN,account:process.env.CLOUDFLARE_ACCOUNT_ID,namespace:process.env.KV_NAMESPACE_ID});
 if(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID||!process.env.KV_NAMESPACE_ID)throw Error('curation_kv_credentials_missing');
 const manifest=await load('data/musica-licencas.json'),state=await load('data/musica-curadoria.json'),day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 profile=learnedProfile(profile,manifest);
 if(argv.includes('--publish-report')){await kv.put(REPORT_KEY,JSON.stringify({schema:1,day,text:dailyMusicText(profile,state)}),{expirationTtl:3*86400});return {status:'report_registered',day};}
 const output=process.env.RUNNER_TEMP||tmpdir(),work=await mkdtemp(join(output,'zev-curation-'));let token=null;try{token=await getYoutubeAccessToken();}catch{}
 try{
 const usedBytes=(await Promise.all(manifest.faixas.map(async r=>(await readFile(join(root,r.arquivo))).length))).reduce((a,b)=>a+b,0);if(usedBytes>6000000)throw Error('music_budget_exceeded');
 const prepared=new Map(),model=process.env.SHORTS_VOCAL_MODEL;if(!model)throw Error('vocal_model_required');
 const result=await runCuration({profile,manifest,state,day,monthly:argv.includes('--monthly'),kv,token,availableBytes:6000000-usedBytes,
 prepare:async(row,date,fetchImpl)=>{const bytes=await boundedFetch(row.fonte,{fetchImpl}),id='cc0-'+sha(bytes).slice(0,16),source=join(work,id+'.mp3'),cut=join(work,id+'.ogg');await writeFile(source,bytes);run('ffmpeg',['-v','error','-y','-protocol_whitelist','file,pipe','-f','mp3','-i',source,'-t','36','-af','loudnorm=I=-28:TP=-4:LRA=7','-ar','44100','-ac','2','-c:a','libvorbis','-q:a','4',cut]);const info=JSON.parse(run('ffprobe',['-v','error','-show_format','-of','json',cut]));if(Number(info.format.duration)<35||Number(info.format.duration)>40)throw Error('music_excerpt_duration_invalid');const excerpt=await readFile(cut),c={...row,arquivo:'assets/musica/'+id+'.ogg',sha256_original:sha(bytes),sha256:sha(excerpt),verificado_em:date,tamanho_bytes:excerpt.length,trecho_inicio:0,trecho_segundos:36,credito:row.titulo+' — '+row.autor+' (CC0).'};prepared.set(c.arquivo,cut);return c;},
 measure:async c=>JSON.parse(run('python3',[fileURLToPath(new URL('./audio-features.py',import.meta.url)),prepared.get(c.arquivo),model]))});
 for(const row of result.promoted){await rename(prepared.get(row.arquivo),join(root,row.arquivo));manifest.faixas.push(row);}
 // Files are persisted only after all gates and the monthly cap. The workflow
 // commits these paths atomically and registers the daily report after its push.
 await writeFile(join(root,'data/musica-perfil.json'),JSON.stringify(profile,null,2)+'\n');
 await writeFile(join(root,'data/musica-licencas.json'),JSON.stringify(manifest,null,2)+'\n');await writeFile(join(root,'data/musica-curadoria.json'),JSON.stringify(result.state,null,2)+'\n');
 await mkdir(join(output,'music-curation-report'),{recursive:true});await writeFile(join(output,'music-curation-report/resultado.json'),JSON.stringify({...result,promoted:result.promoted.map(r=>({arquivo:r.arquivo,sha256:r.sha256}))},null,2)+'\n');return {status:'concluida',promotions:result.promoted.length,analytics:result.analytics};
 }finally{await rm(work,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await main()));
