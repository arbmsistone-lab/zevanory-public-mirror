import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../worker/acquisition-engine.mjs';
import {lerStatusDoDia} from '../worker/diagnostico-diario.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/acquisition-engine.mjs',import.meta.url),day='2026-11-12',state='zpc:acquisition:daily:'+day,receipt=state+':bluesky';
async function scenario(mod,trigger='manual',legacy=false){
 const data=new Map(),writes=[];let fail=false;
 const kv={get:async k=>{if(fail&&k===state)throw Error('unreadable state');return data.get(k)??null;},put:async(k,v)=>{writes.push(k);data.set(k,v);}};
 const f=async(url,req={})=>{if(String(url).endsWith('createRecord')){const r=JSON.parse(req.body);return{ok:true,json:async()=>({uri:'at://did:plc:abc/app.bsky.feed.post/'+r.rkey,cid:'fake'})};}return{ok:true,status:200,json:async()=>({did:'did:plc:abc',accessJwt:'fixture'})};};
 const env={ZEVANORY_PRIVATE_ARTIFACTS:kv,BLUESKY_HANDLE:'fixture.bsky.social',BLUESKY_APP_PASSWORD:'fixture'};
 await mod.runAcquisitionEngine(env,new Date(day+'T22:35:00Z'),f,{trigger});
 assert.equal(JSON.parse(data.get(receipt)).trigger,trigger);
 if(legacy){const old=JSON.parse(data.get(receipt));delete old.trigger;data.set(receipt,JSON.stringify(old));data.delete(state);}
 const original=data.get(state),before=writes.filter(k=>k===state).length;
 fail=true;const repeat=await mod.runAcquisitionEngine(env,new Date(day+'T23:05:00Z'),f,{trigger:'cron'});fail=false;
 assert.equal(writes.filter(k=>k===state).length,before);assert.equal(data.get(state),original);
 assert.equal(repeat.outcomes.find(o=>o.channel==='bluesky').trigger,legacy?null:trigger);
 const read=await lerStatusDoDia(kv,day);assert.equal(read.porCanal.bluesky.semComando,!legacy&&trigger==='cron'?1:0);
}
test('CL1021 manual publication stays manual when the next cron cannot read state',()=>scenario(engine));
test('CL1021 cron receipt proves autonomous origin despite state read failure',()=>scenario(engine,'cron'));
test('CL1021 legacy receipt without trigger stays unknown',()=>scenario(engine,'manual',true));
test('CL1021 mutant: stamp current trigger on published receipt',async()=>{await scenario(engine);await killedMutation(source,[['trigger:o.status==="publicado"?(o.trigger??null):trigger','trigger']],scenario);});
test('CL1021 mutant: publish without trigger in receipt',async()=>{await scenario(engine);await killedMutation(source,[['const outcome={channel,day:entry.day,status:"publicado",trigger:receipt.adopted===true?(prior?.trigger??null):trigger,','const outcome={channel,day:entry.day,status:"publicado",']],scenario);});
test('CL1021 mutant: rewrite unreadable daily state',async()=>{await scenario(engine);await killedMutation(source,[['if(stateRead.ok&&(!priorState||','if((!priorState||']],scenario);});

test('CL1021 adopting an existing provider post preserves attempt origin or stays unknown',async()=>{
 const {deterministicTid}=await import('../worker/bluesky-publisher.mjs');
 for(const origin of ['manual',undefined]){
  const data=new Map([[receipt,JSON.stringify({status:'pending',...(origin?{trigger:origin}:{})})]]);
  const kv={get:async k=>data.get(k)??null,put:async(k,v)=>data.set(k,v)};
  const rkey=deterministicTid(day,engine.calendarEntry(day).product.sku);
  const f=async url=>String(url).endsWith('createRecord')?{ok:false,status:400,headers:{get:()=>null}}:String(url).includes('getRecord')?{ok:true,json:async()=>({uri:'at://did:plc:abc/app.bsky.feed.post/'+rkey,cid:'fixture'})}:{ok:true,status:200,json:async()=>({did:'did:plc:abc',accessJwt:'fixture'})};
  const out=await engine.runAcquisitionEngine({ZEVANORY_PRIVATE_ARTIFACTS:kv,BLUESKY_HANDLE:'fixture',BLUESKY_APP_PASSWORD:'fixture'},new Date(day+'T22:35:00Z'),f,{trigger:'cron'});
  assert.equal(out.outcomes.find(o=>o.channel==='bluesky').trigger,origin??null);
  assert.equal(JSON.parse(data.get(receipt)).trigger,origin??null);
 }
});
