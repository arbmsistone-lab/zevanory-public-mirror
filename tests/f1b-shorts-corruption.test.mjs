import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as shorts from '../scripts/channels/shorts-retomada.mjs';
import * as yt from '../scripts/channels/youtube-daily-short.mjs';
import {killedMutation} from './helpers/f1b-shorts-mutation.mjs';
const pure=new URL('../scripts/channels/shorts-retomada.mjs',import.meta.url),source=new URL('../scripts/channels/youtube-daily-short.mjs',import.meta.url);
async function corruption(mod){
 const a='{corrompido A',b='{}';
 const ra=(await mod.lerCongelamento({get:async()=>a})).registro,rb=(await mod.lerCongelamento({get:async()=>b})).registro;
 const id=mod.idEpisodio(ra),config={canal:{congelamento_liberado_id:id}};
 assert.equal(mod.congelamentoAtivo({config,registro:ra}),false);
 assert.equal(mod.congelamentoAtivo({config,registro:rb}),true);
 assert.equal(id,'ilegivel:'+createHash('sha256').update(a).digest('hex').slice(0,16));
 assert.equal(mod.congelamentoAtivo({config:{canal:{congelamento_liberado_id:'ilegivel'}},registro:rb}),true);
}
test('CL1022 release corruption A only, not corruption B',()=>corruption(shorts));
test('CL1022 mutant: fixed illegible identity',async()=>{await corruption(shorts);await killedMutation(pure,[['ID_ILEGIVEL+":"+createHash("sha256").update(String(raw)).digest("hex").slice(0,16)','ID_ILEGIVEL']],corruption);});
async function dayReceipts(mod){
 for(const raw of ['{broken','null','[]','{}','42','{"status":"unknown"}']){
  const warnings=[];const r=await mod.publicadosNoDia({get:async k=>k.endsWith(':youtube_dica')?raw:null},'2026-11-12',{warn:s=>warnings.push(s)});
  assert.deepEqual(r,{dica:true,calc:false,oferta:false});assert.equal(warnings.length,1);assert.match(warnings[0],/publicado_desconhecido/);
 }
}
test('CL1022 unreadable present receipt blocks duplicate slot and emits warning',()=>dayReceipts(yt));
test('CL1022 mutant: unreadable receipt treated as not published',async()=>{await dayReceipts(yt);await killedMutation(source,[['out[slot]=true; // presente mas ilegível','out[slot]=false; // presente mas ilegível']],dayReceipts);});
