// DEC-23: one owner-approved workflow attempt; no retries after an uncertain POST.
import {readFile,open,mkdir} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runCheck,GRAPH,EXPECTED,redact} from './meta-permission-check.mjs';
export const IMAGE_URL='https://zevanory.api.br/brand/social/zevanory-proof-dec23.jpg';
export const CAPTION='ZEVANORY. Conheça a nossa marca e os nossos materiais: https://zevanory.api.br';
export const forbidden=/R\$|\b(?:BRL|reais|pre[cç]o|whatsapp|telegram|gr[aá]tis|renda garantida|lucro garantido|ganhe dinheiro|resultado garantido|fature|enrique[cç]a|desconto|promo[cç][aã]o|oferta|milagre|cura)\b|\b\d+[,.]\d{2}\b/i;
export function safeCaption(s){return typeof s==='string'&&s===CAPTION&&!forbidden.test(s);}
const numeric=s=>typeof s==='string'&&/^\d+$/.test(s);
function workflowContext(env){return env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/gh-pages'&&env.GITHUB_RUN_NUMBER==='1'&&env.GITHUB_RUN_ATTEMPT==='1'&&numeric(env.GITHUB_RUN_ID);}
const stateShape=s=>s!==null&&typeof s==='object'&&!Array.isArray(s)&&s.schema==='meta-proof-dec23/v1'&&['reserved','unknown','published'].includes(s.status)&&numeric(s.run_id)&&Object.keys(s).every(k=>['schema','status','run_id','instagram_media_id','facebook_post_id'].includes(k))&&(s.instagram_media_id===undefined||numeric(s.instagram_media_id))&&(s.facebook_post_id===undefined||typeof s.facebook_post_id==='string'&&/^\d+_\d+$/.test(s.facebook_post_id));
const clean=s=>({schema:'meta-proof-dec23/v1',status:s.status,run_id:s.run_id,instagram_media_id:s.instagram_media_id??null,facebook_post_id:s.facebook_post_id??null});
export function fileStore(path){return {
 begin:async()=>{const f=await open(path+'.publishing','wx',0o600);await f.close();},
 read:async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('state_unreadable');}},
 reserve:async value=>{await mkdir(dirname(path),{recursive:true,mode:0o700});const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}},
 write:async value=>{const f=await open(path,'r+');try{await f.truncate(0);await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}}
};}
export async function runProof({mode,env=process.env,store,fetchImpl=fetch,check=runCheck,log=console.log,mask=v=>process.stdout.write('::add-mask::'+v.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A')+'\n'),summary=()=>{},caption=CAPTION,imageHash,approvedRecord=null,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const secrets=[env.META_ACCESS_TOKEN].filter(Boolean);let state=null;
 const emit=out=>{const line=JSON.stringify(out);if(secrets.some(s=>line.includes(s)))throw Error('output_suppressed');log(line);summary('## Prova Meta DEC-23\n\n```json\n'+line+'\n```\n');return out;};
 try{
  for(const secret of secrets)mask(secret);
  if(!workflowContext(env))throw Error('workflow_attempt_blocked');
  if(!safeCaption(caption))throw Error('caption_forbidden');
  if(approvedRecord&&Object.entries(approvedRecord).some(([k,v])=>k.startsWith('prova_')&&v!==null&&v!==undefined))throw Error('proof_record_exists');
  const loaded=await store.read();
  if(loaded!==null&&!stateShape(loaded))throw Error('state_invalid');
  state=loaded;
  if(mode==='reserve'&&state!==null)throw Error('proof_state_exists');
  if(mode==='publish'&&(!state||state.schema!=='meta-proof-dec23/v1'||state.status!=='reserved'||state.run_id!==env.GITHUB_RUN_ID||!numeric(env.RESERVATION_ARTIFACT_ID)))throw Error('proof_unknown_or_existing');
  if(!['reserve','publish'].includes(mode))throw Error('invalid_mode');
  const result=await check({env,fetchImpl,log:t=>log(redact(t,secrets)),mask,summary:()=>{}});
  if(result.exitCode!==0||result.report?.pronto_para_prova!==true)throw Error('permission_not_ready');
  if(env.META_PAGE_ID!==EXPECTED.page_id||env.INSTAGRAM_BUSINESS_ACCOUNT_ID!==EXPECTED.ig_id)throw Error('identity_mismatch');
  if(mode==='reserve'){
   state={schema:'meta-proof-dec23/v1',status:'reserved',run_id:env.GITHUB_RUN_ID};
   await store.reserve(state);return emit(clean(state));
  }
  await store.begin(); // exclusive local publisher claim; no second process can POST
  // Verify that the public JPEG is the exact reviewed derivative, before POST.
  const image=await fetchImpl(IMAGE_URL,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!image.ok||image.headers.get('content-type')?.split(';')[0]!=='image/jpeg')throw Error('image_unavailable');
  const bytes=Buffer.from(await image.arrayBuffer());
  if(!/^[a-f0-9]{64}$/.test(imageHash??'')||createHash('sha256').update(bytes).digest('hex')!==imageHash)throw Error('image_hash_mismatch');
  const get=async(path,token)=>{const r=await fetchImpl(GRAPH+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.error)throw Error('graph_read_failed');return b;};
  const p=await get('/'+EXPECTED.page_id+'?fields=id,access_token',env.META_ACCESS_TOKEN);
  if(p.id!==EXPECTED.page_id||typeof p.access_token!=='string'||!p.access_token)throw Error('page_token_missing');
  secrets.push(p.access_token);mask(p.access_token);
  const post=async(path,fields)=>{
   state={...state,status:'unknown'};await store.write(state); // durable local receipt BEFORE every POST
   const r=await fetchImpl(GRAPH+path,{method:'POST',headers:{authorization:'Bearer '+p.access_token,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields).toString(),signal:AbortSignal.timeout(20000)});
   const b=await r.json();if(!r.ok||b.error)throw Error('graph_post_unknown');return b;
  };
  const container=await post('/'+EXPECTED.ig_id+'/media',{image_url:IMAGE_URL,caption});
  if(!numeric(container.id))throw Error('container_unknown');
  let ready=false;for(let i=0;i<5;i++){const v=await get('/'+container.id+'?fields=status_code',p.access_token);if(v.status_code==='FINISHED'){ready=true;break;}if(v.status_code!=='IN_PROGRESS')break;await sleep(2000);}
  if(!ready)throw Error('container_not_ready');
  const ig=await post('/'+EXPECTED.ig_id+'/media_publish',{creation_id:container.id});
  if(!numeric(ig.id))throw Error('instagram_unknown');
  state={...state,instagram_media_id:ig.id};await store.write(state);
  const fb=await post('/'+EXPECTED.page_id+'/photos',{url:IMAGE_URL,caption,published:'true'});
  if(typeof fb.post_id!=='string'||!/^\d+_\d+$/.test(fb.post_id))throw Error('facebook_unknown');
  state={...state,status:'published',facebook_post_id:fb.post_id};await store.write(state);
  return emit(clean(state));
 }catch(e){
  // Never include provider exception bodies/URLs: they can echo either token.
  const out={...clean(state??{status:'blocked',run_id:env.GITHUB_RUN_ID}),ok:false,error:'proof_blocked_or_unknown'};
  return emit(out);
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const env=process.env,path=env.META_PROOF_STATE_PATH;
 if(!path){console.error('proof_state_path_missing');process.exitCode=1;}
 else{
  const record=JSON.parse(await readFile(new URL('../../data/meta-prova-dec23.json',import.meta.url),'utf8'));
  const bytes=await readFile(new URL('../../brand/social/zevanory-proof-dec23.jpg',import.meta.url));
  const out=await runProof({mode:process.argv.includes('--reserve')?'reserve':'publish',env,store:fileStore(path),approvedRecord:record,imageHash:createHash('sha256').update(bytes).digest('hex'),summary:t=>{if(env.GITHUB_STEP_SUMMARY)appendFileSync(env.GITHUB_STEP_SUMMARY,t);}});
  if(out.ok===false)process.exitCode=1;
 }
}
