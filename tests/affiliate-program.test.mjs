import test from "node:test";import assert from "node:assert/strict";
import {referralCookie,referralFromRequest,recordAffiliateAttribution,applyAffiliateOrderOutcome,affiliateReport,resetAffiliateMemoForTest} from "../worker/affiliate-program.mjs";
test("signed ref cookie attributes for exactly 60 days and rejects tampering",()=>{const env={AFFILIATE_SIGNING_SECRET:"secret-secret-secret"},now=Date.now(),cookie=referralCookie("Parceiro_1",env,now);const req=new Request("https://zevanory.api.br/?ref=Parceiro_1",{headers:{cookie:cookie.split(";")[0]}});assert.equal(referralFromRequest(req,env,now+59*86400e3),"parceiro_1");assert.equal(referralFromRequest(req,env,now+61*86400e3),"");const bad=new Request(req.url,{headers:{cookie:cookie.split(";")[0]+"x"}});assert.equal(referralFromRequest(bad,env,now),"");});
test("paid order records exactly 30 percent and refund reverses before payout",async()=>{resetAffiliateMemoForTest();const calls=[],sql={query:async(q,p=[])=>{calls.push([q,p]);if(q.startsWith("insert into affiliate_attributions"))return[{order_id:p[0]}];if(q.startsWith("insert into affiliate_commissions"))return[{order_id:p[0],partner_code:"par1",commission_amount:"59.10",status:"confirmed"}];if(q.startsWith("update affiliate_commissions"))return[{order_id:p[0],partner_code:"par1",commission_amount:"59.10",status:"reversed"}];return[];}};assert.equal((await recordAffiliateAttribution(sql,{databaseUrl:"db",orderId:"00000000-0000-4000-8000-000000000001",partnerCode:"par1",amount:197})).recorded,true);const paid=await applyAffiliateOrderOutcome(sql,{databaseUrl:"db",orderId:"00000000-0000-4000-8000-000000000001",event:"payment_confirmed"});assert.equal(paid.commission_amount,"59.10");assert.ok(calls.find(x=>x[0].includes("round(amount*0.30,2)")));assert.equal((await applyAffiliateOrderOutcome(sql,{databaseUrl:"db",orderId:"00000000-0000-4000-8000-000000000001",event:"refund_confirmed"})).status,"reversed");});
test("report exposes no payout action and declares owner approval",async()=>{resetAffiliateMemoForTest();const sql={query:async q=>q.startsWith("select status")?[{status:"confirmed",count:2,amount:"118.20"}]:[]};const r=await affiliateReport({DATABASE_URL:"db"},()=>sql);assert.equal(r.payout_requires_owner_approval,true);assert.equal(r.commission_rate,.30);assert.equal(r.states[0].amount,118.2);});
// Regressão do #1008: o DDL fica LITERAL (o restore drill recusa DDL interpolado), mas o default de
// affiliate_commissions.commission_rate não pode divergir da taxa do programa próprio em data/affiliates.json.
test("DDL literal: default de commission_rate = taxa do programa próprio em data/affiliates.json, sem interpolação no DDL",async()=>{
 const {readTextNormalized}=await import("./helpers/text.mjs");
 const src=readTextNormalized(new URL("../worker/affiliate-program.mjs",import.meta.url));
 const af=JSON.parse(readTextNormalized(new URL("../data/affiliates.json",import.meta.url)));
 const ddls=[...src.matchAll(/create table if not exists\s+(\w+)\s*\(/gi)].map(m=>{let d=0,j=m.index+m[0].length-1;for(;j<src.length;j++){if(src[j]==="(")d++;else if(src[j]===")"&&--d===0)break;}return [m[1],src.slice(m.index,j+1)];});
 assert.deepEqual(ddls.map(x=>x[0]).sort(),["affiliate_attributions","affiliate_commissions"]);
 for(const [name,ddl] of ddls)assert.ok(!ddl.includes("${"),"DDL interpolado: "+name);
 const def=ddls.find(x=>x[0]==="affiliate_commissions")[1].match(/commission_rate numeric\(5,4\) not null default ([0-9.]+)/);
 assert.ok(def,"default de commission_rate ausente");
 assert.equal(Number(def[1]),af.own_program_commission_pct/100,"default do DDL diverge de data/affiliates.json");
 // e o que o programa grava/relata é a mesma taxa
 resetAffiliateMemoForTest();const calls=[],sql={query:async(q,p=[])=>{calls.push(q);return q.startsWith("insert into affiliate_commissions")?[{order_id:p[0],status:"confirmed"}]:[];}};
 await applyAffiliateOrderOutcome(sql,{databaseUrl:"ddl",orderId:"00000000-0000-4000-8000-000000000009",event:"payment_confirmed"});
 const ins=calls.find(q=>q.startsWith("insert into affiliate_commissions"));
 assert.ok(ins.includes(`amount,${(af.own_program_commission_pct/100).toFixed(4)},round(amount*${(af.own_program_commission_pct/100).toFixed(2)},2)`),ins);
});
