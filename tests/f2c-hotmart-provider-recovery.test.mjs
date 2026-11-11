import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../worker/hotmart-post-sale.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../worker/hotmart-post-sale.mjs',import.meta.url),T=Date.parse('2026-11-11T15:00:00Z'),DAY=86400000,BASE='zpc:posvenda:hotmart:';
function fixture(){
 const data=new Map([['sales:hotmart:v1',JSON.stringify({enabled:true,channel:'hotmart',authorization:'LIBERAR VENDAS',by:'fixture',ref:'fixture/sale',at:new Date(T-1000).toISOString()})]]),posts=[],reads=[],history=[];
 const s={data,posts,reads,history,used:0,monthly:0,limit:100,monthlyLimit:3000,bad:null,unknown:false,clock:T};
 const kv={get:async k=>data.get(k)??null,put:async(k,v)=>data.set(k,v),list:async({prefix})=>({keys:[...data.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true})};
 s.env={ZEVANORY_PRIVATE_ARTIFACTS:kv,HOTMART_HOTTOK:'synthetic-hottok-only',RESEND_API_KEY:'synthetic-resend-only'};
 s.enqueue=async(m=mod,id='HP-RECOVERY-1')=>m.recordHotmartPostSale(new Request('https://zevanory.api.br/api/webhooks/hotmart',{method:'POST',headers:{'x-hotmart-hottok':s.env.HOTMART_HOTTOK}}),s.env,{event:'PURCHASE_APPROVED',version:'2.0.0',data:{product:{id:8704733},buyer:{email:'client@example.test',name:'Ana'},purchase:{transaction:id,approved_date:T}}},{now:T});
 s.fetchImpl=async(url,r={})=>{
  if(r.method==='POST'){const mail=JSON.parse(r.body);posts.push(mail);if(s.unknown)throw Error('timeout');return {status:200,json:async()=>({id:'sent-'+posts.length})};}
  reads.push(String(url));
  if(url.endsWith('/usage')){if(s.bad==='error')throw Error('read');return {status:200,json:async()=>s.bad==='shape'?{}:{object:'usage',emails:{daily:{used:s.used,limit:s.limit,resets_at:new Date(s.clock+(s.bad==='stale'?-1:DAY)).toISOString()},monthly:{used:s.monthly,limit:s.monthlyLimit,resets_at:new Date(s.clock+31*DAY).toISOString()}}}};}
  if(s.bad==='history')throw Error('history');
  if(url.includes('/emails?')){const after=new URL(url).searchParams.get('after'),start=after?history.findIndex(x=>x.id===after)+1:0;return {status:200,json:async()=>({data:history.slice(start,start+100),has_more:start+100<history.length})};}
  return {status:200,json:async()=>history.find(x=>url.endsWith('/'+x.id))};
 };
 s.run=(m=mod)=>m.runHotmartPostSale(s.env,{now:s.clock,fetchImpl:s.fetchImpl});return s;
}
async function oldHistory(m){const s=fixture();await s.enqueue(m);for(let i=0;i<1100;i++)s.history.push({id:'old-'+i,created_at:new Date(T-2*DAY).toISOString()});assert.equal((await s.run(m)).sent,1);assert.equal(s.posts.length,1);assert.deepEqual(s.reads,['https://api.resend.com/usage']);}
async function resume(m){const s=fixture();await s.enqueue(m);s.unknown=true;await s.run(m);for(let i=0;i<1100;i++)s.history.push({id:'old-'+i,created_at:new Date(T-2*DAY).toISOString()});s.history.push({...s.posts[0],id:'actual',created_at:new Date(T).toISOString()});for(let i=0;i<12;i++){const before=s.reads.length;await s.run(m);assert.ok(s.reads.length-before<=10);}assert.equal(s.posts.length,1);assert.equal(JSON.parse(s.data.get(BASE+'HP-RECOVERY-1:d0:confirmado')??'{}').id,'actual');}
async function invalid(m){for(const bad of ['error','shape','stale']){const s=fixture();await s.enqueue(m);s.bad=bad;assert.equal((await s.run(m)).ok,false);assert.equal(s.posts.length,0);assert.equal(s.data.has(BASE+'HP-RECOVERY-1:d0'),false);s.bad=null;assert.equal((await s.run(m)).sent,1);}}
test('NC04: 1100 historical emails cannot block a new stage',()=>oldHistory(mod));
test('NC04: unknown stage resumes beyond ten pages without another POST',()=>resume(mod));
test('NC04: failed invalid or stale usage blocks then safely recovers',()=>invalid(mod));
test('NC04: provider daily monthly and policy caps remain enforced',async()=>{for(const values of [{used:100},{monthly:3000},{used:10,limit:10},{monthly:20,monthlyLimit:20},{used:100,limit:null}]){const s=fixture();Object.assign(s,values);await s.enqueue();await s.run();assert.equal(s.posts.length,0);}const s=fixture();s.used=99;await s.enqueue();await s.enqueue(mod,'HP-RECOVERY-2');await s.run();assert.equal(s.posts.length,1);});
test('NC04: history outage or corrupt cursor holds only unknown stage',async()=>{for(const bad of ['history','cursor']){const s=fixture();await s.enqueue();s.unknown=true;await s.run();s.unknown=false;await s.enqueue(mod,'HP-RECOVERY-2');if(bad==='history')s.bad=bad;else s.data.set(BASE+'HP-RECOVERY-1:d0:reconciliacao','{');const out=await s.run();assert.equal(out.sent,1);assert.equal(out.reconciliationPending,1);assert.equal(s.posts.length,2);assert.equal(s.data.has(BASE+'HP-RECOVERY-1:d0:confirmado'),false);}});
async function candidates(m){const s=fixture();await s.enqueue(m);s.unknown=true;await s.run(m);for(let i=0;i<12;i++)s.history.push({...s.posts[0],text:'different',id:'candidate-'+i,created_at:new Date(T).toISOString()});s.history.push({...s.posts[0],id:'actual',created_at:new Date(T).toISOString()});await s.run(m);const cursor=JSON.parse(s.data.get(BASE+'HP-RECOVERY-1:d0:reconciliacao'));assert.equal(cursor.candidates.length,5);await s.run(m);assert.equal(JSON.parse(s.data.get(BASE+'HP-RECOVERY-1:d0:confirmado')??'{}').id,'actual');assert.equal(s.posts.length,1);}
test('NC04: bounded detail reads checkpoint remaining candidates',()=>candidates(mod));
test('NC04 mutant: full-history dependency returns',()=>killedMutation(source,[["const v=await providerGet(env,fetchImpl,'/usage');","const list=await providerGet(env,fetchImpl,'/emails?limit=100');if(list.has_more)throw Error('history_incomplete');const v=await providerGet(env,fetchImpl,'/usage');"]],oldHistory));
test('NC04 mutant: invalid usage becomes zero',()=>killedMutation(source,[["throw Error('provider_usage_invalid');","return {used:0,dailyLimit:100,monthlyUsed:0,monthlyLimit:3000};"]],invalid));
test('NC04 mutant: pagination cursor discarded',()=>killedMutation(source,[["let cursor=savedCursor||","let cursor=null||"]],resume));
test('NC04 mutant: candidate checkpoint discarded',()=>killedMutation(source,[["candidates:cursor.candidates.slice(1)","candidates:[]"]],candidates));

test('NC04: corrupt search checkpoint recovers through matching provider evidence only',async()=>{const s=fixture();await s.enqueue();s.unknown=true;await s.run();s.data.set(BASE+'HP-RECOVERY-1:d0:reconciliacao','{');s.history.push({...s.posts[0],id:'actual',created_at:new Date(T).toISOString()});await s.run();assert.equal(JSON.parse(s.data.get(BASE+'HP-RECOVERY-1:d0:confirmado')??'{}').id,'actual');assert.equal(s.posts.length,1);});
