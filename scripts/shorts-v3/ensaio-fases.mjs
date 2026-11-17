// Ensaio por PR (#1055, contra-auditoria GPT-6): fases do CÓDIGO DO PR, que rodam em máquinas SEM nenhuma chave.
//   pedido <out>            -> <out>/pedido-voz.json {texto, voz, modelo} (o TTS é chamado por código do gh-pages)
//   render <out> <vozDir>   -> render v3 completo com a voz gerada fora (voz.pcm + meta.json); o júri Gemini também
//                              roda fora: aqui só se gravam <out>/juri/juri-N.png + juri-pedido.json (dados).
// Nada aqui lê GEMINI_API_KEY nem faz chamada de rede ao Gemini.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderV3,carregarSpec} from './render.mjs';
import {assertPreparation} from '../shorts-v2/preparation.mjs';
import {checagensObjetivas} from '../criativos/avaliador.mjs';
import ATIVO_V3 from '../../data/shorts-v3/ativo.json' with {type:'json'};
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=t=>createHash('sha256').update(t).digest('hex');
async function base(slot){
 if(typeof ATIVO_V3?.[slot]!=='string')throw Error('ensaio_slot_sem_v3');
 const config=JSON.parse(await readFile(join(ROOT,'data/shorts-padrao-v2.json'),'utf8'));
 // GPT-6 (15/11): o roteiro é validado ANTES do pedido de voz — roteiro inválido nunca consome TTS
 const spec=await carregarSpec(ATIVO_V3[slot]);
 return {config,spec,specPath:ATIVO_V3[slot],texto:spec.falas.map(f=>f.texto).join(' ')};
}
export async function pedido(out,slot){
 const {config,texto}=await base(slot);
 await mkdir(out,{recursive:true});
 const p={texto,voz:config.voz_fixa,modelo:config.modelo};
 await writeFile(join(out,'pedido-voz.json'),JSON.stringify(p));return p;
}
// Voz pronta: só aceita o MESMO texto (sha256), a voz fixa e o modelo fixo que o código do gh-pages usou.
export function vozPronta({pcm,meta}){
 if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2)throw Error('ensaio_voz_pronta_invalida');
 return async(text,voice,_key,{model}={})=>{
  if(sha(text)!==meta.texto_sha256)throw Error('ensaio_texto_diverge_da_voz');
  if(voice!==meta.voice||model!==meta.model)throw Error('ensaio_voz_ou_modelo_diverge');
  return {pcm,voice:meta.voice,model:meta.model};
 };
}
// Júri fora: grava os quadros e o pedido como dados; a decisão real vem do job do júri.
export function juriFora(dir,capturar=()=>{}){
 return async({criativo,padrao,quadrosPng,medicao,permitidos,oficial})=>{
  capturar({criativo,medicao,permitidos,oficial});
  await mkdir(dir,{recursive:true});const quadros=[];
  for(const [i,b] of quadrosPng.entries()){const n=`juri-${i}.png`;await writeFile(join(dir,n),b);quadros.push(n);}
  await writeFile(join(dir,'juri-pedido.json'),JSON.stringify({quadros,criativo,padrao,medicao,permitidos,oficial:oficial??null,audio:[]}));
  return {aprovado:false,decisao:'PENDENTE_JURI',nota_geral:null,motivos:['juri_em_job_separado'],juri:null,objetivas:null};
 };
}
// Contra-auditoria GPT-6 (15/11): o júri do ensaio roda com o avaliador do gh-pages, então as checagens objetivas
// NOVAS do candidato (ex.: identidade das células exigidas) precisam rodar AQUI, com o código do PR, sem segredo, e
// ficar vinculadas ao SHA-256 do MP4 e dos quadros enviados ao júri. Reprovação objetiva encerra o job ANTES do júri
// (nenhuma chamada Gemini a mais). Aceite do ensaio = objetivas-candidato.json aprovado + júri APROVADO, mesmos quadros.
export async function objetivasCandidato({r,entrada,dirJuri,commit=process.env.SHA_ENSAIO||null}){
 const hash=async f=>{try{return sha(await readFile(f));}catch{return null;}};
 const mp4=r?.file?{arquivo:r.file.split(/[\\/]/).pop(),sha256:await hash(r.file)}:null;
 let pj=null;try{pj=JSON.parse(await readFile(join(dirJuri,'juri-pedido.json'),'utf8'));}catch{}
 const quadros=[];for(const q of pj?.quadros||[])quadros.push({arquivo:q,sha256:await hash(join(dirJuri,q))});
 const motivos_objetivos=entrada?checagensObjetivas(entrada):['entrada_do_avaliador_ausente'];
 const motivos_audio=r?.qc?.audio?.reasons||[];
 if(!mp4?.sha256)motivos_objetivos.push('mp4_ausente');
 if(!quadros.length||quadros.some(q=>!q.sha256))motivos_objetivos.push('quadros_juri_ausentes');
 const o={schema:1,commit,mp4,quadros_juri:quadros,motivos_objetivos,motivos_audio,aprovado_objetivo:motivos_objetivos.length===0&&motivos_audio.length===0};
 const txt=JSON.stringify(o);await writeFile(join(dirJuri,'objetivas-candidato.json'),txt);await writeFile(join(dirJuri,'..','objetivas-candidato.json'),txt);
 return o;
}
export async function render(out,vozDir,slot,{renderImpl=renderV3,note=m=>console.log(m)}={}){
 const {config,specPath}=await base(slot);
 const meta=JSON.parse(await readFile(join(vozDir,'meta.json'),'utf8')),pcm=await readFile(join(vozDir,'voz.pcm'));
 const dirJuri=join(out,'juri');await mkdir(out,{recursive:true});let entrada=null;
 const r=await renderImpl(specPath,resolve(out,'short-preview'),{preview:true,config,geminiKey:'juri-em-job-separado',synthesize:vozPronta({pcm,meta}),avaliarImpl:juriFora(dirJuri,e=>{entrada=e;}),note});
 // as falhas de áudio são medidas aqui (no MP4); vão junto para o júri decidir DESCARTADO se houver
 const arq=join(dirJuri,'juri-pedido.json'),p=JSON.parse(await readFile(arq,'utf8'));
 p.audio=r?.qc?.audio?.reasons||[];await writeFile(arq,JSON.stringify(p));
 const o=await objetivasCandidato({r,entrada,dirJuri});
 note('OBJETIVAS_CANDIDATO '+JSON.stringify(o));
 if(!o.aprovado_objetivo)throw Error('ensaio_objetivas_reprovadas:'+[...o.motivos_objetivos,...o.motivos_audio].join('+').slice(0,90));
 return r;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const [fase,out,vozDir]=process.argv.slice(2),slot=process.env.PREVIEW_SLOT||'oferta';
 (fase==='render'?Promise.resolve().then(()=>assertPreparation('previa',process.env.DRY_RUN,process.env.FREE_TIER_CONFIRMED)):Promise.resolve()).then(()=>fase==='pedido'?pedido(out,slot):fase==='render'?render(out,vozDir,slot):Promise.reject(Error('ensaio_fase_invalida')))
  .then(()=>console.log(`ENSAIO_FASE ${fase} ok`))
  .catch(e=>{console.error('::error title=ENSAIO_FASE::'+String(e.message||e).replace(/[^\w:.-]/g,'_').slice(0,120));process.exitCode=1;});
}
