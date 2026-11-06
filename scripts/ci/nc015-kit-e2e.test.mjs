import test from "node:test";
import assert from "node:assert/strict";
import {createKitHarness,PRODUCT_ID,TRANSACTION,APPROVED_AT,INTERNAL_KEY} from "./nc015-kit-harness.mjs";
import {RELEASE_DELAY_MS} from "../../worker/kit-release-192h.mjs";
import {readHotmartOrderNc015} from "../../worker/kit-nc015-readback.mjs";
import {verifySignedKitToken,issueSignedKitToken} from "../../worker/kit-nc015-token.mjs";
import {downloadVerifiedKitCandidate,handleKitDownloadNc015,KIT_DOWNLOAD_ENABLED} from "../../worker/kit-nc015-download.mjs";
import {sendKitMailCandidate,sendKitMailConfigured,KIT_RESEND_CONSUMER_ENABLED} from "../../worker/kit-nc015-resend.mjs";

const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function storage(env){
 const bytes=new TextEncoder().encode("%PDF-1.7\nZEVANORY offline fixture; no customer data.");
 const hash=hex(await crypto.subtle.digest("SHA-256",bytes));
 const key="kit-private/"+PRODUCT_ID+"/"+hash+".pdf";
 const calls=[];
 env.KIT_PRIVATE_FILES_JSON=JSON.stringify({[PRODUCT_ID]:{
  key,sha256:hash,bytes:bytes.byteLength,mime_type:"application/pdf",filename:"guia_ia.pdf"}});
 env.KIT_PRIVATE_R2={get:async k=>{calls.push(k);return k===key?{
  size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(0)
 }:null}};
 return {bytes,hash,key,calls};
}
const download=(h,link,now)=>downloadVerifiedKitCandidate({
 request:new Request(link),env:h.env,now,enabled:true,fetcher:h.hotmartFetch
});
test("N1 approved purchase and alarm are bound to exactly 192 complete hours",async()=>{
 const h=createKitHarness();
 await h.approve();
 assert.equal(h.object.ledger.state().release_at_ms,h.at+192*3600000);
 assert.equal(h.object.ledger.authorizeRelease(h.eligibleAt-1,h.proof(h.eligibleAt-1)).code,"not_eligible");
 assert.equal(h.object.ledger.outbox().length,0);
 await h.object.alarm(h.eligibleAt-1);
 assert.equal(h.object.ledger.state().state,"waiting");
 await h.object.alarm(h.eligibleAt);
 assert.equal(h.object.ledger.alarmPolicy().status,"queued");
 assert.equal(h.object.ledger.state().token_hash,null);
});
test("N1 readback permits only exact Hotmart transaction, product, status and approved timestamp",async()=>{
 const h=createKitHarness();
 const base={transaction:TRANSACTION,productId:PRODUCT_ID,approvedAtMs:APPROVED_AT,
  orderOpaque:h.opaque,accessToken:h.env.HOTMART_ACCESS_TOKEN,fetcher:h.hotmartFetch,now:h.eligibleAt};
 const proof=await readHotmartOrderNc015(base);
 assert.equal(proof.state,"APPROVED");
 assert.equal(proof.checked_at_ms,h.eligibleAt);
 await assert.rejects(readHotmartOrderNc015({...base,productId:"8704999"}),/hotmart_readback/);
 await assert.rejects(readHotmartOrderNc015({...base,approvedAtMs:APPROVED_AT+1}),/hotmart_approval_timestamp_mismatch/);
 const refunded=async()=>Response.json({items:[{product:{id:Number(PRODUCT_ID)},purchase:{
  transaction:TRANSACTION,approved_date:APPROVED_AT,status:"REFUNDED"}}]});
 await assert.rejects(readHotmartOrderNc015({...base,fetcher:refunded}),/hotmart_purchase_not_eligible/);
});
test("N1 signed per-order token cannot be tampered or activated before grant",async()=>{
 const h=createKitHarness();
 const token=await issueSignedKitToken(h.opaque,h.env.KIT_DOWNLOAD_SIGNING_KEY);
 assert.equal((await verifySignedKitToken(token,h.env.KIT_DOWNLOAD_SIGNING_KEY)).orderOpaque,h.opaque);
 assert.equal(await verifySignedKitToken(token.slice(0,-1)+"0",h.env.KIT_DOWNLOAD_SIGNING_KEY),null);
 const r=await download(h,"https://zevanory.api.br/kit/baixar?t="+token,h.at+1000);
 assert.equal(r.status,503); // no order reference/grant yet
});
test("N1 E2E offline private R2 + Hotmart readback: 5 downloads, 6th denied",async()=>{
 const h=createKitHarness(),asset=await storage(h.env);
 const {grant,link}=await h.ready();
 assert.equal(grant.code,"grant_pending_email");
 const early=await download(h,link,h.eligibleAt-1);
 assert.notEqual(early.status,200);
 for(let n=1;n<=5;n++){
  const result=await download(h,link,h.eligibleAt+n*1000);
  assert.equal(result.status,200,"download "+n);
  assert.equal(result.headers.get("content-disposition"),'attachment; filename="guia_ia.pdf"');
  assert.equal(result.headers.get("cache-control"),"no-store, private, max-age=0");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),asset.bytes);
  assert.equal(h.object.ledger.downloadCount(),n);
 }
 assert.equal((await download(h,link,h.eligibleAt+6000)).status,403);
 assert.equal(h.object.ledger.downloadCount(),5);
 assert.equal(asset.calls.length,6);
});
test("N1 refund before 192 hours prevents grant, email, link and download",async()=>{
 const h=createKitHarness(),asset=await storage(h.env);await h.approve();
 h.object.ledger.acceptEvent({event_key:"hotmart:refund:nc015-pre",event_type:"PURCHASE_REFUNDED"},h.eligibleAt-1000);
 await h.object.alarm(h.eligibleAt);
 assert.equal(h.object.ledger.state().state,"revoked");
 assert.equal(h.object.ledger.outbox().length,0);
 const grant=await h.call("/internal/grant",{now_ms:h.eligibleAt,proof:h.proof(h.eligibleAt)});
 assert.equal((await grant.json()).code,"not_eligible");
 const link="https://zevanory.api.br/kit/baixar?t="+await issueSignedKitToken(h.opaque,h.env.KIT_DOWNLOAD_SIGNING_KEY);
 assert.notEqual((await download(h,link,h.eligibleAt+1000)).status,200);
 assert.equal(asset.calls.length,0);
});
test("N1 refund after grant or email immediately revokes future downloads",async()=>{
 const h=createKitHarness();await storage(h.env);
 const {link}=await h.ready();
 assert.equal((await download(h,link,h.eligibleAt+1000)).status,200);
 h.object.ledger.acceptEvent({event_key:"hotmart:refund:nc015-post",event_type:"PURCHASE_CHARGEBACK"},h.eligibleAt+2000);
 assert.equal(h.object.ledger.state().state,"revoked");
 assert.equal((await download(h,link,h.eligibleAt+3000)).status,403);
 assert.equal(h.object.ledger.downloadCount(),1);
});
test("N1 Resend default OFF; offline consumer claims once with exact idempotency key",async()=>{
 const h=createKitHarness();await storage(h.env);
 const {link}=await h.ready();let sent=0,key;
 h.env.RESEND_API_KEY="test-only-resend-token-not-live-12345678";
 h.env.KIT_FROM_EMAIL="entregas@zevanory.api.br";
 assert.equal(KIT_DOWNLOAD_ENABLED,false);
 assert.equal(KIT_RESEND_CONSUMER_ENABLED,false);
 assert.equal((await handleKitDownloadNc015(new Request(link),h.env)).status,503);
 assert.equal((await sendKitMailConfigured({stub:h.stub,env:h.env,recipient:"customer@example.invalid",downloadLink:link})).code,"RESEND_DISABLED");
 const fake=async(url,init)=>{
  sent++;assert.equal(url,"https://api.resend.com/emails");
  key=init.headers["Idempotency-Key"];
  return Response.json({id:"mail-nc015-proof-001"});
 };
 const a=await sendKitMailCandidate({stub:h.stub,env:h.env,recipient:"customer@example.invalid",downloadLink:link,
  enabled:true,fetcher:fake});
 assert.equal(a.code,"RESEND_ACCEPTED");
 assert.equal(key,h.opaque+":mail:v1");
 assert.equal(h.object.ledger.outbox()[0].status,"accepted");
 const b=await sendKitMailCandidate({stub:h.stub,env:h.env,recipient:"customer@example.invalid",downloadLink:link,
  enabled:true,fetcher:fake});
 assert.equal(b.ok,false);
 assert.equal(sent,1);
});
test("N1 ambiguous Resend network failure stays uncertain, no blind retry",async()=>{
 const h=createKitHarness();const {link}=await h.ready();
 h.env.RESEND_API_KEY="test-only-resend-token-not-live-12345678";
 h.env.KIT_FROM_EMAIL="entregas@zevanory.api.br";
 let sends=0;
 const fail=async()=>{sends++;throw Error("simulated_timeout")};
 const req={stub:h.stub,env:h.env,recipient:"customer@example.invalid",downloadLink:link,enabled:true,fetcher:fail};
 assert.equal((await sendKitMailCandidate(req)).code,"MAIL_UNCERTAIN_NEEDS_RECONCILIATION");
 assert.equal(h.object.ledger.outbox()[0].status,"uncertain");
 assert.equal((await sendKitMailCandidate(req)).code,"MAIL_NOT_CLAIMABLE");
 assert.equal(sends,1);
});
