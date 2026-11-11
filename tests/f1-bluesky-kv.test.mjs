import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../worker/acquisition-engine.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/acquisition-engine.mjs',import.meta.url);
const day='2026-11-11',historyKey='zpc:acquisition:history:bluesky';
async function scenario(mod,mode='throw',key=historyKey){
 const saved=JSON.stringify([{day:'2026-11-10',text:'anterior',product:'ZEV-IA-011'}]);
 const data=new Map([[historyKey,saved]]),writes=[];let creates=0;
 const kv={get:async k=>{if(k===key){if(mode==='throw')throw Error('unreadable');return mode;}return data.get(k)??null;},put:async(k,v)=>{writes.push(k);data.set(k,v);}};
 const fetchImpl=async(url,req={})=>{if(String(url).endsWith('createRecord')){creates++;const r=JSON.parse(req.body);return {ok:true,json:async()=>({uri:'at://did:plc:abc/app.bsky.feed.post/'+r.rkey,cid:'cid'})};}return {ok:true,status:200,json:async()=>({did:'did:plc:abc',accessJwt:'fake'})};};
 const out=await mod.runAcquisitionEngine({ZEVANORY_PRIVATE_ARTIFACTS:kv,BLUESKY_HANDLE:'test.bsky.social',BLUESKY_APP_PASSWORD:'fixture'},new Date(day+'T22:35:00Z'),fetchImpl);
 assert.equal(creates,0);assert.equal(data.get(historyKey),saved);assert.equal(writes.includes(historyKey),false);
 assert.equal(out.outcomes.find(o=>o.channel==='bluesky').code,key===historyKey?'history_unreadable':'receipt_unreadable');
 if(key===historyKey)assert.equal(JSON.parse(data.get('bluesky:status:20261111')).motivo,'history_unreadable');
}
for(const mode of ['throw','{broken','{}','null',''])test('A1 history fail-closed: '+mode,()=>scenario(engine,mode));
test('A1 receipt failure cannot repost',()=>scenario(engine,'throw','zpc:acquisition:daily:'+day+':bluesky'));
test('A1 mutant: safeJson history fallback dies',async()=>{
 await scenario(engine);
 await killedMutation(source,[['const historyRead=await readAcquisitionKv(kv,"zpc:acquisition:history:"+channel,historyShape);','const historyRead={ok:true,value:await safeJson(kv,"zpc:acquisition:history:"+channel,[])};']],scenario);
});
test('A1 idempotency reads: errors and malformed values never overwrite or send',async()=>{
 for(const key of ['bluesky:status:20261111','zpc:acquisition:owner-digest:'+day])for(const raw of ['throw','{broken','[]','null']){
  const writes=[],kv={get:async k=>{if(k===key){if(raw==='throw')throw Error('read');return raw;}return null;},put:async k=>writes.push(k)};
  if(key.startsWith('bluesky:'))assert.equal((await engine.recordBlueskyFailure(kv,day,new Date(),{motivo:'test'})).written,false);
  else {let sent=0;const result=await engine.runOwnerDailyDigest({ZEVANORY_PRIVATE_ARTIFACTS:kv,RESEND_API_KEY:'fixture',OWNER_ALERT_EMAIL:'owner@example.invalid'},new Date(day+'T23:00:00Z'),async()=>{sent++;});assert.equal(result.code,'digest_marker_unreadable');assert.equal(sent,0);}
  assert.deepEqual(writes,[]);
 }
});
test('A1 absent history is legitimate and pause unknown blocks',async()=>{
 assert.deepEqual(await engine.readAcquisitionKv({get:async()=>null},historyKey,Array.isArray),{ok:true,value:null});
 for(const raw of ['garbage','']){const writes=[];const out=await engine.runAcquisitionEngine({ZEVANORY_PRIVATE_ARTIFACTS:{get:async()=>raw,put:async k=>writes.push(k)}},new Date(day+'T22:35:00Z'),async()=>{throw Error('no network');});assert.equal(out.code,'pause_unreadable');assert.deepEqual(writes,[]);}
});
test('A1 mutant: receipt structure validation removed',async()=>{
 const check=m=>scenario(m,'{}','zpc:acquisition:daily:'+day+':bluesky');await check(engine);
 await killedMutation(source,[['return valid(value)?{ok:true,value}:{ok:false};','return {ok:true,value};']],check);
});
test('A1 mutant: strict KV exception becomes missing',async()=>{
 await scenario(engine);
 await killedMutation(source,[['}catch{return {ok:false};}','}catch{return {ok:true,value:null};}']],scenario);
});
