import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as postSale from '../worker/hotmart-post-sale.mjs';
import * as ingress from '../worker/cp-nc012-digital-hotmart.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
import {readTextNormalized} from './helpers/text.mjs';
const source=new URL('../worker/hotmart-post-sale.mjs',import.meta.url),handler=new URL('../worker/cp-nc012-digital-hotmart.mjs',import.meta.url),T=Date.parse('2026-11-11T15:00:00Z'),token='synthetic-hottok-000000000000',prefix='zpc:posvenda:hotmart:';
const usage=()=>({object:'usage',emails:{daily:{used:0,limit:100,resets_at:new Date(T+86400000).toISOString()},monthly:{used:0,limit:3000,resets_at:new Date(T+31*86400000).toISOString()}}});
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(mode='none'){
 const data=new Map(),writes=[],errors=[];let lists=0,reads=0,provider=0,activityBeforePost=true,failed=mode;
 const body={event:'PURCHASE_APPROVED',version:'2.0.0',data:{buyer:{email:'customer@example.test',name:'Ana Pessoa'},product:{id:8704733},purchase:{transaction:'HP-SYNTH-SECONDARY',approved_date:T,price:{value:97}}}};
 const ref=hash(body.data.purchase.transaction);if(mode==='corrupt')data.set(prefix+'cancelado:'+ref,'{');
 data.set('sales:hotmart:v1',JSON.stringify({enabled:true,channel:'hotmart',authorization:'LIBERAR VENDAS',at:new Date(T-1000).toISOString(),by:'fixture',ref:'fixture/sale'}));
 const kv={get:async k=>{reads++;if(k.startsWith(prefix)){activityBeforePost&&=writes.some(w=>w.k.startsWith('zpc-activity:v1:event:'));if(failed==='get'||failed==='all')throw Error('private read');}return data.get(k)??null;},put:async(k,v,opts)=>{if(failed==='all'&&k.startsWith(prefix))throw Error('private write');writes.push({k,v,opts});data.set(k,v);},list:async({prefix=''})=>{lists++;return {keys:[...data.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}};
 const env={HOTMART_HOTTOK:token,RESEND_API_KEY:'synthetic-resend',ZEVANORY_PRIVATE_ARTIFACTS:kv};
 const request=()=>new Request('https://zevanory.api.br/api/webhooks/hotmart',{method:'POST',headers:{'x-hotmart-hottok':token},body:JSON.stringify(body)});
 return {body,data,writes,env,kv,ref,request,errors,stats:()=>({lists,reads,provider,activityBeforePost}),repair:()=>{failed='none';data.delete(prefix+'cancelado:'+ref);},fetchImpl:async()=>{provider++;return {status:200,json:async()=>usage()};}};
}
async function secondary(m,mode='get'){
 const s=fixture(mode),old=console.error;console.error=(...a)=>s.errors.push(a.join(' '));
 let response;try{response=await m.handleDigitalHotmartNc012(s.request(),s.env,{now:T});}finally{console.error=old;}
 assert.equal(response.status,200);assert.equal((await response.json()).scope,'digital_product');
 assert.ok(s.writes.some(w=>w.k.startsWith('zpc:sales:v1:ev:')));assert.ok(s.writes.some(w=>w.k.startsWith('zpc-activity:v1:event:')));
 assert.equal(s.stats().activityBeforePost,true);assert.deepEqual(s.errors,['hotmart_post_sale_enqueue_failed']);
 if(mode!=='all'){const mark=s.writes.find(w=>w.k===prefix+'falha:'+s.ref);assert.deepEqual(JSON.parse(mark.v),{failed:true});assert.equal(mark.opts.expirationTtl,7*86400);assert.equal(mark.v.includes(s.body.data.buyer.email),false);}
 return s;
}
async function idle(m){const s=fixture();const out=await m.runHotmartPostSale(s.env,{now:T,fetchImpl:s.fetchImpl,cron:'0 * * * *'});assert.equal(out.ok,true);assert.equal(s.stats().lists,1);assert.equal(s.stats().provider,0);}
async function scanner(m){const s=fixture();await m.recordHotmartPostSale(s.request(),s.env,s.body,{now:T});let mail;
 await m.runHotmartPostSale(s.env,{now:T,fetchImpl:async(_,r={})=>{if(r.method==='POST'){mail=JSON.parse(r.body);return {status:200,json:async()=>({id:'accepted'})};}return {status:200,json:async()=>usage()};}});
 const link=mail.headers['List-Unsubscribe'].slice(1,-1),before=s.writes.length;
 const get=await m.handleHotmartPostSaleOptOut(new Request(link),s.env);assert.equal(get.status,200);assert.match(await get.text(),/<form method="post">/);assert.equal(s.writes.length,before);
 const post=await m.handleHotmartPostSaleOptOut(new Request(link,{method:'POST'}),s.env);assert.equal(post.status,200);assert.ok(s.writes.some(w=>w.k===prefix+'optout:'+s.ref));
}
test('CL1025-01: post-sale read failure leaves response, financial sale and activity intact',()=>secondary(ingress));
test('CL1025-01: corrupt canceled marker cannot break ingress',()=>secondary(ingress,'corrupt'));
test('CL1025-01: total post-sale storage outage only logs, without changing sale response',()=>secondary(ingress,'all'));
test('CL1025-01: strict failure reader and successful replay resolve the marker',async()=>{const s=await secondary(ingress);s.repair();assert.deepEqual(await postSale.readHotmartPostSaleFailures(s.kv),{status:'ok',count:1,label:'pós-venda não enfileirado (1)'});await ingress.handleDigitalHotmartNc012(s.request(),s.env,{now:T});assert.equal((await postSale.readHotmartPostSaleFailures(s.kv)).count,0);s.data.set(prefix+'falha:'+s.ref,'{');assert.equal((await postSale.readHotmartPostSaleFailures(s.kv)).count,null);});
test('CL1025-02: nonhourly ticks perform zero storage/provider calls',async()=>{for(const cron of ['5,35 * * * *','15,45 * * * *']){const s=fixture();assert.equal((await postSale.runHotmartPostSale(s.env,{cron,now:T,fetchImpl:s.fetchImpl})).code,'not_hourly_tick');assert.deepEqual(s.stats(),{lists:0,reads:0,provider:0,activityBeforePost:true});}assert.match(readTextNormalized(new URL('../worker/cloudflare-worker.compat.mjs',import.meta.url)),/if\(controller\?\.cron==="0 \* \* \* \*"\)await runHotmartPostSale/);});
test('CL1025-02: no orders means zero provider calls',()=>idle(postSale));
test('CL1025-02: no due stage and all due stages confirmed mean zero provider calls',async()=>{const s=fixture();await postSale.recordHotmartPostSale(s.request(),s.env,s.body,{now:T});await postSale.runHotmartPostSale(s.env,{now:T-1,fetchImpl:s.fetchImpl});assert.equal(s.stats().provider,0);let posts=0;await postSale.runHotmartPostSale(s.env,{now:T,fetchImpl:async(_,r={})=>r.method==='POST'?(posts++,{status:200,json:async()=>({id:'mail'})}):{status:200,json:async()=>usage()}});assert.equal(posts,1);await postSale.runHotmartPostSale(s.env,{now:T+1000,fetchImpl:s.fetchImpl});assert.equal(s.stats().provider,0);});
test('CL1025-03: link scanner GET only shows confirmation; POST suppresses',()=>scanner(postSale));
test('CL1025 mutant: restore 503 on secondary failure',async()=>{await secondary(ingress);await killedMutation(handler,[[' await enqueueHotmartPostSaleSecondary(request,env,body,{now});',' if(!await enqueueHotmartPostSaleSecondary(request,env,body,{now}))return json(503,{ok:false,error:"post_sale_commit_pending"});']],secondary);});
test('CL1025 mutant: enqueue before activity',async()=>{await secondary(ingress);await killedMutation(handler,[[' await enqueueHotmartPostSaleSecondary(request,env,body,{now});',''],[' const activity=ACTIVE.has(event)?',' await enqueueHotmartPostSaleSecondary(request,env,body,{now});\n const activity=ACTIVE.has(event)?']],secondary);});
test('CL1025 mutant: provider call without a due stage',async()=>{await idle(postSale);await killedMutation(source,[["if(!hasDue)return {ok:true,sent:0,priority:1,code:'no_due_steps'};","if(!hasDue){await providerUsage(env,fetchImpl,now);return {ok:true,sent:0,priority:1,code:'no_due_steps'};}"]],idle);});
test('CL1025 mutant: GET writes suppression',async()=>{await scanner(postSale);await killedMutation(source,[["if(request.method==='GET')return new Response","if(false)return new Response"]],scanner);});
