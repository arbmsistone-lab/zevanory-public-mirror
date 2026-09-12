import test from 'node:test';
import assert from 'node:assert/strict';
import {transferNuvemshopCustody,NUVEMSHOP_CUSTODY_PROJECT} from '../scripts/nuvemshop-custody-transfer.mjs';
const env={ZEVANORY_NUVEMSHOP_CUSTODY_TRANSFER:'YES',VERCEL_ENV:'production',VERCEL_PROJECT_ID:NUVEMSHOP_CUSTODY_PROJECT,NUVEMSHOP_APP_ID:'41672',NUVEMSHOP_CLIENT_SECRET:'fixture-client-secret',COMMERCIAL_OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,12).toString('base64'),ZEVANORY_CUSTODY_CF_TOKEN:'fixture-cf'};
const names=['NUVEMSHOP_APP_ID','NUVEMSHOP_CLIENT_SECRET','COMMERCIAL_OAUTH_ENCRYPTION_KEY'];
const response=body=>new Response(JSON.stringify(body),{status:200});
test('custody transfers exact existing secrets only to the pinned sales-disabled Worker',async()=>{
 const writes=[];
 const fetchImpl=async(url,options)=>{
 assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/accounts/1b26415802588185a86c1d4d3ebf5bdb/workers/scripts/zevanory/'));assert.equal(options.redirect,'error');
 if(url.endsWith('/settings'))return response({success:true,result:{bindings:['SALE_GLOBALLY_ENABLED','CHECKOUT_ENABLED','FINANCIAL_EVENTS_ENABLED'].map(name=>({name,text:'false'}))}});
 if(options.method==='PUT'){writes.push(JSON.parse(options.body));return response({success:true});}
 return response({success:true,result:names.map(name=>({name,type:'secret_text'}))});
 };
 const out=await transferNuvemshopCustody({env,fetchImpl});assert.equal(out.ok,true);assert.equal(writes.length,3);
 for(const write of writes)assert.equal(write.text,env[write.name]);assert.equal(out.unchanged_key,true);
 assert.doesNotMatch(JSON.stringify(out),/fixture-client-secret|fixture-cf/);
});
test('custody refuses another project before network access',async()=>{await assert.rejects(transferNuvemshopCustody({env:{...env,VERCEL_PROJECT_ID:'other'},fetchImpl:()=>{throw new Error('unexpected');}}),/identity_invalid/);});
test('custody refuses a sales-enabled target without writing secrets',async()=>{let calls=0;await assert.rejects(transferNuvemshopCustody({env,fetchImpl:async()=>{calls++;return response({success:true,result:{bindings:[{name:'SALE_GLOBALLY_ENABLED',text:'true'}]}});}}),/sales_guard_invalid/);assert.equal(calls,1);});
test('custody does not declare success after provider failure',async()=>{await assert.rejects(transferNuvemshopCustody({env,fetchImpl:async()=>response({success:false})}),/target_unverified/);});
