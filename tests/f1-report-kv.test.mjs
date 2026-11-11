import test from 'node:test';
import assert from 'node:assert/strict';
import * as diag from '../worker/diagnostico-diario.mjs';
import * as report from '../worker/relatorio-diario.mjs';
import {SALES_SUMMARY_KEY} from '../worker/sales-ledger.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const day='2026-11-11',now=new Date(day+'T23:00:00Z'),prefix='zpc:acquisition:daily:'+day;
const diagSource=new URL('../worker/diagnostico-diario.mjs',import.meta.url),reportSource=new URL('../worker/relatorio-diario.mjs',import.meta.url);
const active={blog:{ativo:true},bluesky:{ativo:true}};
async function unread(mod,mode='throw',key=prefix+':bluesky'){
 const data=new Map([[prefix,JSON.stringify({outcomes:[{channel:'bluesky',status:'publicado',trigger:'cron'}]})]]);
 const kv={get:async k=>{if(k===key){if(mode==='throw')throw Error('read');return mode;}return data.get(k)??null;}};
 const st=await mod.lerStatusDoDia(kv,day);
 assert.equal(st.fonte,'falha_leitura');assert.equal(st.porCanal.bluesky.publicadas,null);assert.equal(st.porCanal.bluesky.semComando,0);
 const diagnostics=mod.diagnosticarDia({day,hour:20,ativos:active,status:st});
 const item=diagnostics.find(d=>d.canal==='bluesky');assert.equal(item.regra,'LEITURA_INCONCLUSIVA');assert.equal(item.publicadas,null);
 assert.equal(mod.autonomiaDoDia({day,hour:20,ativos:active,status:st}).valor,null);
}
test('A4 each failed receipt/state read is unknown, never zero or autonomous',async()=>{
 for(const key of [prefix,prefix+':bluesky'])for(const mode of ['throw','{broken','[]','null'])await unread(diag,mode,key);
});
test('A4 blog gate status failure also makes publication unknown',async()=>{
 const kv={get:async k=>k==='zpc:blog:status:v1:'+day?'{}':null};const st=await diag.lerStatusDoDia(kv,day);assert.equal(st.porCanal.blog.publicadas,null);assert.equal(st.porCanal.blog.status,'erro');
});
test('A4 mutant: invalid structure accepted',async()=>{
 await unread(diag,'[]');
 await killedMutation(diagSource,[['return valid(v) ? { ok: true, v } : { ok: false, v: null };','return { ok: true, v };']],m=>unread(m,'[]'));
});
test('A4 mutant: KV exception mistaken for absence',async()=>{
 await unread(diag);
 await killedMutation(diagSource,[['} catch { return { ok: false, v: null }; }','} catch { return { ok: true, v: null }; }']],unread);
});
async function malformedReport(mod){
 const kv={get:async k=>k===report.FUNNEL_SUMMARY_KEY?'[]':k===SALES_SUMMARY_KEY?'{}':k==='zpc:blog:status:v1:'+day?'{broken':null};
 const r=await mod.montarRelatorioDiario({ZEVANORY_PRIVATE_ARTIFACTS:kv},{day,now,checklist:[{id:'bluesky',configured:true}]});
 assert.equal(r.funil.viewsBr,null);assert.equal(r.funil.erro,true);assert.equal(r.vendas.estado,'INCONCLUSIVO');assert.equal(r.vendas.aprovadas,null);
 assert.match(r.text,/blog: esperado 1 × real não lido/);assert.match(r.text,/amostra não lida/);assert.match(r.text,/LEITURA_INCONCLUSIVA/);
 assert.doesNotMatch(r.text,/nenhum canal ativo abaixo do esperado/);
}
test('A4 malformed funnel/ledger/review data are explicitly unread',()=>malformedReport(report));
test('A4 stale funnel values are not presented as measured',()=>{
 const r=report.funilDoDia({ok:true,v:{generatedAt:'2026-11-01T00:00:00Z',porDiaUtc:{[day]:{views_br:123,hotmart_view:4,lead_submit:5}}}},day,now.getTime());assert.equal(r.medido,false);assert.equal(r.viewsBr,null);
});
test('A4 mutant: stale funnel values treated as measured',async()=>{
 const scenario=async m=>assert.equal(m.funilDoDia({ok:true,v:{generatedAt:'2026-11-01T00:00:00Z',porDiaUtc:{[day]:{views_br:123,hotmart_view:4,lead_submit:5}}}},day,now.getTime()).viewsBr,null);
 await scenario(report);await killedMutation(reportSource,[['const d = !erro && fresco ? rawDay : null;','const d = !erro ? rawDay : null;']],scenario);
});
