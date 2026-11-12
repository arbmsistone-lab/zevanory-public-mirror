// NC-G6-1029-01: perder o estado da curadoria nunca reinicia o livro mensal nem libera promoções.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {killedMutation} from './helpers/f1-mutation.mjs';
import * as storage from '../scripts/shorts-v2/music-kv.mjs';import {runCuration} from '../scripts/shorts-v2/curadoria-musica.mjs';
const kSource=new URL('../scripts/shorts-v2/music-kv.mjs',import.meta.url),pSource=new URL('../scripts/shorts-v2/music-policy.mjs',import.meta.url);
const load=async f=>JSON.parse(await readFile(new URL('../data/'+f,import.meta.url),'utf8'));
async function world(){
 const manifest=await load('musica-licencas.json'),baseState=await load('musica-curadoria.json'),profile=await load('musica-perfil.json');
 profile.descoberta.enabled=true;profile.descoberta.aprovacoes={proprietario:true,claude:true,gpt6:true};
 const seed=await readFile(new URL('../assets/musica/ia-1.ogg',import.meta.url));
 const row=i=>{const bytes=Buffer.concat([seed,Buffer.from('continuidade-'+i)]),r=structuredClone(manifest.faixas[0]),h=createHash('sha256').update(bytes).digest('hex');Object.assign(r,{arquivo:'assets/musica/cc0-cont-'+i+'.ogg',titulo:'Instrumental continuidade '+i,sha256:h,sha256_original:h,tamanho_bytes:bytes.length,temas_permitidos:['ia','dicas']});r.atributos.audio_sha256=h;return {row:r,bytes};};
 const data=new Map(),kv={get:async k=>data.get(k)??null,put:async(k,v)=>{data.set(k,v);},delete:async k=>{data.delete(k);}};
 let n=0;
 async function cycle(day,count=3,m=storage){
  const {state,warnings,desde}=await m.curationState({kv,baseState,day});
  const fresh=Array.from({length:count},()=>row(++n)),bytes=new Map(fresh.map(x=>[x.row.arquivo,x.bytes]));
  const result=await runCuration({profile,manifest,state,day,monthly:true,discover:async()=>({candidates:fresh.map(x=>x.row),warnings:[]}),prepare:async r=>r,measure:async r=>r.atributos});
  await m.persistCuration({kv,result,profile,baseState,day,desde,bytesFor:async r=>bytes.get(r.arquivo)});
  return {promoted:result.promoted.length,warnings};
 }
 return {data,kv,cycle,baseState,manifest,profile};
}
const month=(w,m)=>JSON.parse(w.data.get(storage.STATE_KEY)).meses[m]||[];

test('inicialização (sem estado e sem continuidade): mês corrente bloqueado; o mês seguinte promove até 2',async()=>{
 const w=await world();
 const a=await w.cycle('2026-11-12');assert.equal(a.promoted,0);assert.deepEqual(a.warnings,['music_kv_bootstrap_month_locked']);
 assert.equal((await w.cycle('2026-11-20')).promoted,0,'mês da inicialização segue bloqueado');
 assert.equal((await w.cycle('2026-12-03')).promoted,2);assert.equal((await w.cycle('2026-12-10')).promoted,0,'teto mensal');
 assert.ok(w.data.has(storage.CONTINUITY_KEY));
});

test('duas promoções no mês, exclusão do estado e nova execução: nenhuma promoção adicional (livro restaurado)',async()=>{
 const w=await world();await w.cycle('2026-11-12');assert.equal((await w.cycle('2026-12-03')).promoted,2);
 w.data.delete(storage.STATE_KEY);
 const again=await w.cycle('2026-12-10');assert.equal(again.promoted,0);assert.deepEqual(again.warnings,['music_kv_state_lost_ledger_restored']);
 assert.equal(month(w,'2026-12').length,2,'livro de dezembro restaurado com as 2 promoções');
 const st=JSON.parse(w.data.get(storage.STATE_KEY));for(const f of month(w,'2026-12'))assert.equal(st.faixas[f].status,'retirada','faixa perdida não volta ao rodízio');
 assert.equal((await w.cycle('2027-01-05')).promoted,2,'mês novo segue normal');
});

test('perda dupla (estado e continuidade) também não libera promoção no mês',async()=>{
 const w=await world();await w.cycle('2026-11-12');assert.equal((await w.cycle('2026-12-03')).promoted,2);
 w.data.delete(storage.STATE_KEY);w.data.delete(storage.CONTINUITY_KEY);
 const r=await w.cycle('2026-12-10');assert.equal(r.promoted,0);assert.deepEqual(r.warnings,['music_kv_bootstrap_month_locked']);
});

test('perda só da continuidade: o estado é a prova e a continuidade é regravada; estado com menos que a continuidade é unido',async()=>{
 const w=await world();await w.cycle('2026-11-12');await w.cycle('2026-12-03');
 w.data.delete(storage.CONTINUITY_KEY);assert.equal((await w.cycle('2026-12-10')).promoted,0);assert.ok(w.data.has(storage.CONTINUITY_KEY));
 const st=JSON.parse(w.data.get(storage.STATE_KEY));st.meses['2026-12']=[];w.data.set(storage.STATE_KEY,JSON.stringify(st)); // estado "voltou no tempo"
 assert.equal((await w.cycle('2026-12-15')).promoted,0,'o livro maior vale');
});

test('continuidade ilegível ou contraditória = nenhuma promoção (erro, não estado vazio)',async()=>{
 const w=await world();await w.cycle('2026-11-12');
 for(const bad of ['{',JSON.stringify({schema:1}),JSON.stringify({schema:1,desde:'2026-11-12',meses:{'2026-12':[1,2,3]},meses_bloqueados:[]})]){
  w.data.set(storage.CONTINUITY_KEY,bad);await assert.rejects(()=>w.cycle('2026-12-03'));
 }
});

test('continuidade é gravada ANTES do estado (falha na continuidade = nada promovido nem gravado)',async()=>{
 const w=await world();await w.cycle('2026-11-12');const before=w.data.get(storage.STATE_KEY),put=w.kv.put;
 w.kv.put=async(k,v)=>{if(k===storage.CONTINUITY_KEY)throw Error('kv');return put(k,v);};
 await assert.rejects(()=>w.cycle('2026-12-03'));w.kv.put=put;
 assert.equal(w.data.get(storage.STATE_KEY),before,'estado intacto');
});

test('render com estado ausente usa Arpent/Funshine com aviso (contingência não vira livro vazio)',async()=>{
 const w=await world(),notes=[];const lib=await storage.runtimeLibrary({kv:w.kv,manifest:w.manifest,profile:w.profile,baseState:w.baseState,note:(l,t)=>notes.push(t)});
 assert.equal(lib.manifest.faixas.length,2);assert.deepEqual(lib.warnings,['music_kv_state_absent_using_repository']);assert.equal(w.data.has(storage.STATE_KEY),false,'render não grava estado');
});

async function lostLedger(m){const w=await world();await w.cycle('2026-11-12',3,m);assert.equal((await w.cycle('2026-12-03',3,m)).promoted,2);w.data.delete(m.STATE_KEY);assert.equal((await w.cycle('2026-12-10',3,m)).promoted,0);}
test('mutante: estado ausente volta a ser livro vazio (sem restauração)',()=>killedMutation(kSource,[["if(cont){\n  for(const [m,rows] of Object.entries(cont.meses)){","if(false){\n  for(const [m,rows] of Object.entries(cont.meses)){"]],lostLedger));
async function bootLock(m){const w=await world();assert.equal((await w.cycle('2026-11-12',3,m)).promoted,0);}
test('mutante: inicialização sem bloquear o mês',()=>killedMutation(kSource,[["state.meses_bloqueados=[month];",""]],bootLock));
