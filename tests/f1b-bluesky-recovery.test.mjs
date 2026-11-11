import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../worker/acquisition-engine.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/acquisition-engine.mjs',import.meta.url),day='2026-11-12',history='zpc:acquisition:history:bluesky';
async function recovery(mod,{unreadable=false,duplicate=true}={}){
 const text=engine.generateNative(engine.calendarEntry(day),'bluesky').text;
 const data=new Map([[history,'{corrompido'],['zpc:acquisition:daily:2026-11-11:bluesky',JSON.stringify({status:'publicado',text:duplicate?text:'Texto anterior inteiramente diferente',product:'ZEV-IA-011'})]]),writes=[],reads=[];let creates=0;
 const kv={get:async k=>{reads.push(k);if(unreadable&&k==='zpc:acquisition:daily:2026-11-02:bluesky')throw Error('source_read');return data.get(k)??null;},put:async(k,v)=>{writes.push(k);data.set(k,v);}};
 const fetchImpl=async(url,req={})=>{if(String(url).endsWith('createRecord')){creates++;const r=JSON.parse(req.body);return{ok:true,json:async()=>({uri:'at://did:plc:abc/app.bsky.feed.post/'+r.rkey,cid:'fake'})};}return {ok:true,status:200,json:async()=>({did:'did:plc:abc',accessJwt:'fixture'})};};
 const out=await mod.runAcquisitionEngine({ZEVANORY_PRIVATE_ARTIFACTS:kv,BLUESKY_HANDLE:'fixture.bsky.social',BLUESKY_APP_PASSWORD:'fixture'},new Date(day+'T22:35:00Z'),fetchImpl);
 const b=out.outcomes.find(o=>o.channel==='bluesky');
 if(unreadable){assert.equal(b.code,'history_unreadable');assert.equal(creates,0);assert.equal(writes.filter(k=>k===history).length,0);assert.equal(data.get(history),'{corrompido');}
 else {assert.equal(b.history_rebuilt,true);assert.equal(JSON.parse(data.get('bluesky:status:20261112')).motivo,'history_rebuilt');assert.equal(new Set(reads.filter(k=>/^zpc:acquisition:daily:.*:bluesky$/.test(k))).size,30);
 if(duplicate){assert.equal(creates,0);assert.match(b.code,/similarity/);assert.equal(writes.filter(k=>k===history).length,1);assert.equal(JSON.parse(data.get(history))[0].text,text);}
 else{assert.equal(creates,1);assert.equal(b.status,'publicado');}}
}
test('CL1019 rebuild uses all 30 receipts and the normal similarity gate',()=>recovery(engine));
test('CL1019 one unreadable receipt blocks recovery without writing history',()=>recovery(engine,{unreadable:true}));
test('CL1019 repaired history can publish a distinct text automatically',()=>recovery(engine,{duplicate:false}));
test('CL1019 mutant: ignore one failed source',async()=>{const sc=m=>recovery(m,{unreadable:true});await sc(engine);await killedMutation(source,[['if(!read.ok)return {ok:false};','if(!read.ok)continue;']],sc);});
test('CL1019 mutant: rebuild with empty array',async()=>{await recovery(engine);await killedMutation(source,[['return {ok:true,history:recovered};','return {ok:true,history:[]};']],recovery);});
