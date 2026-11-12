// Disposable runtime library. The two owner-approved repository recordings remain the fallback.
import {createHash} from 'node:crypto';
import {licenseEvidence,validFeatures,ownerVeto,tagVeto,REPORT_KEY,dailyMusicText,learnedProfile} from './music-policy.mjs';
export const STATE_KEY='zpc:shorts:v2:musica:estado',TRACK_PREFIX='zpc:shorts:v2:musica:faixa:';
// NC-G6-1029-01: livro de continuidade SEPARADO do estado (sem expiração), gravado ANTES do estado. Guarda só o
// necessário para os limites: promoções por mês (arquivo + sha256) e meses bloqueados. Perder o estado nunca
// reinicia o livro mensal.
export const CONTINUITY_KEY='zpc:shorts:v2:musica:continuidade';
export const MAX_TRACK_BYTES=600000,MAX_TRACKS=6,TRACK_TTL=30*86400;
const hash=b=>createHash('sha256').update(b).digest('hex'),record=o=>o&&typeof o==='object'&&!Array.isArray(o),date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s);
export function strictState(raw,base){
 if(raw===null)return {...structuredClone(base),catalogo:{},schema:1};  // só a forma vazia; a curadoria decide perda × inicialização em curationState
 if(typeof raw!=='string'||raw.length>1500000)throw Error('music_kv_state_unreadable');const s=JSON.parse(raw);
 if(s.schema!==1||!record(s.faixas)||!record(s.meses)||!record(s.catalogo)||!Array.isArray(s.eventos)||s.eventos.length>1000||Object.keys(s.catalogo).length>MAX_TRACKS)throw Error('music_kv_state_unreadable');
 for(const [file,r] of Object.entries(s.faixas))if(!/^assets\/musica\/[a-z0-9-]+\.ogg$/.test(file)||!record(r)||!['ativa','observacao','retirada','vetada'].includes(r.status)||!Number.isFinite(r.peso)||r.peso<0||r.peso>2||!Number.isInteger(r.videos)||r.videos<0||!Number.isInteger(r.badWindows)||r.badWindows<0||!date(r.desde)||!/^[a-f0-9]{64}$/.test(r.sha256))throw Error('music_kv_state_unreadable');
 for(const [month,files] of Object.entries(s.meses))if(!/^\d{4}-\d{2}$/.test(month)||!Array.isArray(files)||files.length>2||new Set(files).size!==files.length||files.some(f=>!s.faixas[f]))throw Error('music_kv_state_unreadable');
 if(Object.values(s.catalogo).length!==new Set(Object.values(s.catalogo).map(r=>r.sha256)).size)throw Error('music_kv_state_unreadable');
 for(const [file,r] of Object.entries(base.faixas))if(s.faixas[file]?.sha256!==r.sha256)throw Error('music_kv_state_unreadable');
 for(const [file,r] of Object.entries(s.catalogo))if(file!==r.arquivo||!Array.isArray(r.temas_permitidos)||!r.temas_permitidos.length||r.temas_permitidos.some(t=>!['ia','vendas','financas','dicas'].includes(t))||['titulo','autor','evidencia_licenca'].some(k=>typeof r[k]!=='string')||!licenseEvidence(r)||!validFeatures(r.atributos,r.sha256)||r.atributos.vocal.status!=='ausente'||!Number.isSafeInteger(r.tamanho_bytes)||r.tamanho_bytes<1||r.tamanho_bytes>MAX_TRACK_BYTES||s.faixas[file]?.sha256!==r.sha256)throw Error('music_kv_state_unreadable');
 if(s.eventos.some(e=>!record(e)||!date(e.day)||!['promovida','retirada_retencao','veto_proprietario'].includes(e.tipo)||!/^assets\/musica\/[a-z0-9-]+\.ogg$/.test(e.arquivo)))throw Error('music_kv_state_unreadable');
 if(s.meses_bloqueados!==undefined&&(!Array.isArray(s.meses_bloqueados)||s.meses_bloqueados.length>240||s.meses_bloqueados.some(m=>!/^\d{4}-\d{2}$/.test(m))))throw Error('music_kv_state_unreadable');return s;
}
const FILE=/^assets\/musica\/[a-z0-9-]+\.ogg$/,MONTH=/^\d{4}-\d{2}$/;
export function strictContinuity(raw){
 if(raw===null)return null;
 if(typeof raw!=='string'||raw.length>200000)throw Error('music_kv_continuity_unreadable');const c=JSON.parse(raw);
 if(!record(c)||c.schema!==1||!date(c.desde)||!record(c.meses)||!Array.isArray(c.meses_bloqueados)||c.meses_bloqueados.some(m=>!MONTH.test(m)))throw Error('music_kv_continuity_unreadable');
 for(const [m,rows] of Object.entries(c.meses))if(!MONTH.test(m)||!Array.isArray(rows)||rows.length>2||rows.some(r=>!record(r)||!FILE.test(r.arquivo)||!/^[a-f0-9]{64}$/.test(r.sha256)))throw Error('music_kv_continuity_unreadable');
 return c;
}
export function continuityOf(state,desde){
 const meses={};for(const [m,files] of Object.entries(state.meses))meses[m]=files.map(f=>({arquivo:f,sha256:state.faixas[f].sha256}));
 return {schema:1,desde,meses,meses_bloqueados:[...new Set(state.meses_bloqueados||[])].sort()};
}
// Estado para a CURADORIA (pode promover). Regras:
// * estado e continuidade presentes: une os livros (o maior vale);
// * estado ausente + continuidade presente = PERDA: livro mensal reconstruído da continuidade, faixas perdidas como
//   "retirada" (o render usa Arpent/Funshine);
// * os dois ausentes = INICIALIZAÇÃO: só com a curadoria ativada (bootstrap aprovado) e o mês corrente BLOQUEADO
//   para promoções, então nem uma perda dupla libera promoção adicional no mês;
// * qualquer leitura ilegível = erro (nenhuma promoção).
export async function curationState({kv,baseState,day}){
 const rawState=await kv.get(STATE_KEY),cont=strictContinuity(await kv.get(CONTINUITY_KEY)),month=day.slice(0,7),warnings=[];
 let state;
 if(rawState!==null)state=strictState(rawState,baseState);
 else{
  state=strictState(null,baseState);
  if(cont)warnings.push('music_kv_state_lost_ledger_restored');
  else{warnings.push('music_kv_bootstrap_month_locked');state.meses_bloqueados=[month];}
 }
 if(cont){
  for(const [m,rows] of Object.entries(cont.meses)){
   const files=new Set(state.meses[m]||[]);
   for(const r of rows){if(!state.faixas[r.arquivo])state.faixas[r.arquivo]={sha256:r.sha256,status:'retirada',videos:0,peso:0,desde:day,badWindows:0};files.add(r.arquivo);}
   if(files.size>2)throw Error('music_kv_continuity_conflict');state.meses[m]=[...files];
  }
  state.meses_bloqueados=[...new Set([...(state.meses_bloqueados||[]),...cont.meses_bloqueados])].sort();
 }
 strictState(JSON.stringify(state),baseState);
 return {state,warnings,desde:cont?.desde||day};
}
export function decodeTrack(raw,row){
 if(typeof raw!=='string'||raw.length>850000)throw Error('music_kv_track_unreadable');const v=JSON.parse(raw);
 if(v.schema!==1||JSON.stringify(v.registro)!==JSON.stringify(row)||typeof v.audio_base64!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(v.audio_base64))throw Error('music_kv_track_unreadable');const b=Buffer.from(v.audio_base64,'base64');
 if(b.subarray(0,4).toString()!=='OggS'||b.length<1||b.length>MAX_TRACK_BYTES||b.length!==row.tamanho_bytes||b.toString('base64')!==v.audio_base64||hash(b)!==row.sha256)throw Error('music_kv_hash_mismatch');return b;
}
export function encodeTrack(bytes,row){const raw=JSON.stringify({schema:1,registro:row,audio_base64:Buffer.from(bytes).toString('base64')});decodeTrack(raw,row);return raw;}
export async function runtimeLibrary({kv,manifest,profile,baseState,note=()=>{}}){
 const fallback=()=>({manifest,profile:learnedProfile(profile,manifest),state:structuredClone(baseState),buffers:new Map(),warnings});const warnings=[];
 const warn=reason=>{warnings.push(reason);note('warning','SHORT_MUSIC '+reason);};let state;
 try{const raw=await kv.get(STATE_KEY);if(raw===null){warn('music_kv_state_absent_using_repository');return fallback();}state=strictState(raw,baseState);}catch{warn('music_kv_state_unreadable_using_repository');return fallback();}
 const buffers=new Map(),rows=[];profile=learnedProfile(profile,{faixas:[...manifest.faixas,...Object.values(state.catalogo)]});
 for(const row of Object.values(state.catalogo)){
  if(ownerVeto(row,profile)||tagVeto(row,profile)||!['ativa','observacao'].includes(state.faixas[row.arquivo].status))continue;
  try{const bytes=decodeTrack(await kv.get(TRACK_PREFIX+row.sha256),row);buffers.set(row.arquivo,bytes);rows.push(row);}catch{warn('music_kv_track_invalid:'+row.arquivo);}
 }
 if(warnings.length&&!rows.length)return fallback();
 // Unreadable runtime entries never remove the base approved library.
 return {manifest:{...manifest,faixas:[...manifest.faixas,...rows]},profile,state,buffers,warnings};
}
export async function writeMusicReport(kv,profile,state,day,warnings=[]){const text=dailyMusicText(profile,state)+(warnings.length?'\nAvisos: '+warnings.slice(-10).join('; '):'');await kv.put(REPORT_KEY,JSON.stringify({schema:1,day,text}),{expirationTtl:3*86400});}
export async function persistCuration({kv,result,profile,baseState,bytesFor,day,desde=day}){
 const state=structuredClone(result.state);state.schema=1;state.catalogo??={};const warnings=[];
 // Veto/removal deletes immediately. Existing blobs also expire within 30 days if cleanup fails.
 for(const [file,row] of Object.entries(state.catalogo))if(ownerVeto(row,profile)||['vetada','retirada'].includes(state.faixas[file]?.status)){
  state.faixas[file].status=ownerVeto(row,profile)?'vetada':state.faixas[file].status;
  try{await kv.delete(TRACK_PREFIX+row.sha256);delete state.catalogo[file];}catch{warnings.push('music_kv_cleanup_pending:'+file);}
 }
 for(const row of result.promoted){if(Object.keys(state.catalogo).length>=MAX_TRACKS)throw Error('music_kv_track_cap');state.catalogo[row.arquivo]=row;}
 state.eventos=state.eventos.slice(-1000);strictState(JSON.stringify(state),baseState);
 // Continuidade ANTES do estado (write-ahead): falhou = nada é gravado nem promovido. Depois, a reserva de
 // capacidade/mês no estado antes do upload. A failed blob leaves a counted reservation,
 // never an untracked promotion; render skips it and retains repository fallback.
 await kv.put(CONTINUITY_KEY,JSON.stringify(continuityOf(state,desde)));
 await kv.put(STATE_KEY,JSON.stringify(state));
 for(const [file,row] of Object.entries(state.catalogo))if(['ativa','observacao'].includes(state.faixas[file].status)&&!ownerVeto(row,profile)){
  try{let bytes=await bytesFor(row);if(!bytes)bytes=decodeTrack(await kv.get(TRACK_PREFIX+row.sha256),row);const raw=encodeTrack(bytes,row);await kv.put(TRACK_PREFIX+row.sha256,raw,{expirationTtl:TRACK_TTL});decodeTrack(await kv.get(TRACK_PREFIX+row.sha256),row);}catch{warnings.push('music_kv_track_write_unconfirmed:'+file);}
 }
 await writeMusicReport(kv,profile,state,day,[...(result.warnings||[]),...warnings]);return {state,warnings};
}
