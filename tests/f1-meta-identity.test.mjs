import test from 'node:test';
import assert from 'node:assert/strict';
import * as meta from '../scripts/channels/meta-permission-check.mjs';
import {killedMutation} from './helpers/f1-mutation.mjs';
const source=new URL('../scripts/channels/meta-permission-check.mjs',import.meta.url);
const env={META_ACCESS_TOKEN:'fixture-system-token',META_PAGE_ID:meta.EXPECTED.page_id,INSTAGRAM_BUSINESS_ACCOUNT_ID:meta.EXPECTED.ig_id};
async function check(mod,patch={},accounts={data:[{id:env.META_PAGE_ID,access_token:'fixture-page-token'}]}){
 const output=[];const fetchImpl=async url=>{
  const u=new URL(url),p=u.pathname.replace('/v21.0','');let body;
  if(p==='/me')body={id:'1',name:'zevanory-publisher'};
  else if(p==='/me/accounts')body=accounts;
  else if(p==='/me/permissions')body={data:meta.EXPECTED.required_permissions.map(permission=>({permission,status:'granted'}))};
  else if(p==='/debug_token')body={data:{app_id:meta.EXPECTED.app_id,is_valid:true,type:'SYSTEM_USER',expires_at:0,data_access_expires_at:123,...patch}};
  else if(p.endsWith('/content_publishing_limit'))body={data:[{quota_usage:0}]};
  else if(p==='/'+env.META_PAGE_ID)body=u.searchParams.get('fields')==='access_token'?{access_token:'fixture-page-token'}:{id:env.META_PAGE_ID,name:'Zevanory',instagram_business_account:{id:env.INSTAGRAM_BUSINESS_ACCOUNT_ID}};
  else body={id:env.INSTAGRAM_BUSINESS_ACCOUNT_ID,username:'zevanory_'};
  return {ok:true,status:200,json:async()=>body};
 };
 return mod.runCheck({env,fetchImpl,log:x=>output.push(x),mask:()=>{},summary:x=>output.push(x)});
}
const cases=[['validity',{is_valid:false},'d.is_valid === true && '],['system user',{type:'USER'},'d.type === "SYSTEM_USER" && '],['no expiration',{expires_at:123},' && d.expires_at === 0']];
for(const [name,patch,anchor] of cases){
 const scenario=async mod=>{const r=await check(mod,patch);assert.equal(r.report.app_identity,'NAO_COMPROVADA');assert.equal(r.report.pronto_para_prova,false);assert.equal(r.exitCode,1);assert.ok(r.report.failed.includes('token_identity'));};
 test('A6 rejects wrong '+name,()=>scenario(meta));
 test('A6 mutant missing '+name+' is killed',async()=>{await scenario(meta);await killedMutation(source,[[anchor,'']],scenario);});
}
test('A6 strict types: missing/string expiry or validity never prove identity',async()=>{
 for(const patch of [{expires_at:undefined},{expires_at:'0'},{is_valid:'true'},{type:undefined},{type:'PAGE'},{never_expires:true,expires_at:42}])assert.equal((await check(meta,patch)).report.pronto_para_prova,false);
 const good=await check(meta);assert.equal(good.report.app_identity,'COMPROVADA');assert.equal(good.report.pronto_para_prova,true);assert.equal(good.report.items.debug_token.data_access_expires_at,123);
});
test('A6 malformed accounts only fail the page-token item and preserve other checks',async()=>{
 for(const data of [{},'wrong',null,42]){const r=await check(meta,{}, {data});assert.equal(r.exitCode,1);assert.deepEqual(r.report.failed,['page_token']);assert.match(r.report.items.page_token.error,/invalid_data_array/);assert.equal(r.report.items.instagram.ok,true);assert.equal(r.report.items.debug_token.ok,true);assert.equal(r.report.error,undefined);}
});
async function redactScenario(mod){const text=mod.redact('graph.facebook.com/debug_token?input_token=untracked-value&x=1',[]);assert.ok(!text.includes('untracked-value'));assert.match(text,/input_token=\[redacted\]/);}
test('A6 redacts input_token without URL scheme',()=>redactScenario(meta));
test('A6 mutant: input_token redaction removed',async()=>{await redactScenario(meta);await killedMutation(source,[['(access_token|input_token)=','(access_token)=']],redactScenario);});
