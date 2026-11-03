// NC-015: fully offline synthetic purchase, SQLite, Hotmart readback, R2 and Resend.
import {DatabaseSync} from "node:sqlite";
import {KitReleaseOrderDO,RELEASE_DELAY_MS} from "../../worker/kit-release-192h.mjs";
import {issueSignedKitToken} from "../../worker/kit-nc015-token.mjs";
export const APPROVED_AT=Date.parse("2026-10-20T09:30:00Z");
export const PRODUCT_ID="8704733";
export const TRANSACTION="HP1234567890111";
export const ID="a".repeat(64);
export const SIGNING_KEY="nc015-owner-pending-key-only-synthetic-1234567890";
export const INTERNAL_KEY="nc015-internal-do-synthetic-1234567890";
export function createKitHarness(){
 const db=new DatabaseSync(":memory:");
 const sql={exec(q,...args){
  const s=q.trim();
  if(/^SELECT\b/i.test(s))return {toArray:()=>db.prepare(s).all(...args)};
  if(/^CREATE\s+(TABLE|INDEX)\b/i.test(s)){db.exec(s);return {toArray:()=>[]}};
  db.prepare(s).run(...args);return {toArray:[]};
 }};
 const alarms=[];
 const storage={sql,setAlarm:async at=>{alarms.push(at)},transactionSync(fn){
  db.exec("BEGIN IMMEDIATE");try{const result=fn();db.exec("COMMIT");return result}
  catch(e){db.exec("ROLLBACK");throw e}
 }};
 const at=APPROVED_AT,eligibleAt=at+RELEASE_DELAY_MS,opaque="kr:"+ID;
 const proof=(now=eligibleAt)=>({source:"hotmart_authoritative_readback",
  state:"APPROVED",refund_request_open:false,order_opaque:opaque,checked_at_ms:now,approved_at_ms:at});
 const verifier={fetch:async()=>Response.json(proof(eligibleAt))};
 const envDO={INTERNAL_DO_SIGNING_KEY:INTERNAL_KEY,
  KIT_DOWNLOAD_SIGNING_KEY:SIGNING_KEY,HOTMART_STATUS_VERIFIER:verifier};
 const object=new KitReleaseOrderDO({id:{toString:()=>ID},storage},envDO);
 const stub={fetch:(u,init={})=>object.fetch(new Request(u,init))};
 const doNamespace={idFromName:()=>({toString:()=>ID}),
  idFromString:s=>{if(s!==ID)throw Error("wrong_do");return {toString:()=>s}},
  get:()=>stub};
 const call=(path,obj,method="POST")=>stub.fetch("https://internal.kit.example"+path,{
  method,headers:{"x-internal-do-key":INTERNAL_KEY,"content-type":"application/json"},
  ...(method!=="GET"?{body:JSON.stringify(obj)}:{})});
 const sale={product:{id:Number(PRODUCT_ID)},purchase:{transaction:TRANSACTION,approved_date:at,status:"APPROVED"}};
 const hotmartFetch=async(url,init)=>{
  if(!String(url).startsWith("https://developers.hotmart.com/payments/api/v1/sales/history?"))
   throw Error("wrong_readback_url");
  if(new URL(url).searchParams.get("transaction")!==TRANSACTION)throw Error("wrong_tx");
  if(new URL(url).searchParams.get("product_id")!==PRODUCT_ID)throw Error("wrong_product");
  if(!init.headers.authorization?.startsWith("Bearer "))throw Error("missing_auth");
  return Response.json({items:[sale]});
 };
 const env={INTERNAL_DO_SIGNING_KEY:INTERNAL_KEY,
  KIT_DOWNLOAD_SIGNING_KEY:SIGNING_KEY,HOTMART_ACCESS_TOKEN:"offline-token-not-a-real-secret-1234567890",
  PURCHASE_RELEASE_DO:doNamespace};
 const approve=async()=>{
  object.ledger.recordReference({transaction:TRANSACTION,product_id:PRODUCT_ID});
  object.ledger.acceptEvent({event_key:"hotmart:approved:nc015-0001",event_type:"PURCHASE_APPROVED",approved_at_ms:at},at);
 };
 const ready=async()=>{
  await approve();
  await object.alarm(eligibleAt);
  const grant=await call("/internal/grant",{now_ms:eligibleAt,proof:proof(eligibleAt)});
  return {grant:await grant.json(),link:"https://zevanory.api.br/kit/baixar?t="+await issueSignedKitToken(opaque,SIGNING_KEY)};
 };
 return {db,alarms,object,stub,env,call,proof,approve,ready,hotmartFetch,at,eligibleAt,opaque};
}
