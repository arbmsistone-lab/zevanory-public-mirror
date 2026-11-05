import test from "node:test";
import assert from "node:assert/strict";
import {handleSiteChat,resetSiteChatState} from "../worker/site-chat.mjs";
import {fakeSql,fakeKv,SANDBOX_ENV,sinkMailer} from "./helpers/site-chat-fakes.mjs";
test("R122 official handoff creates a ZEV consumer protocol, not a second chat email",async()=>{
 resetSiteChatState();
 const sql=fakeSql(), mailer=sinkMailer();
 let count=0,record={};
 const deps={sqlFactory:()=>sql,salesOpen:async()=>false,mailer,registerOfficialAtendimento:async(_env,input)=>{
  count++;record=input;
  return {status:200,body:{protocolo:"ZEV-20261105-ABCDEF1234",email_confirmacao:"enviado"}};
 }};
 const env={...SANDBOX_ENV,ZEVANORY_PRIVATE_ARTIFACTS:fakeKv(),SITE_CHAT_OFFICIAL_PROTOCOLS:"true"};
 const ask=async(path,body={})=>{
  const res=await handleSiteChat(new Request("https://chat.internal"+path,{method:"POST",headers:{"content-type":"application/json","x-zev-client-ip":"203.0.113.1"},body:JSON.stringify(body)}),env,deps);
  return {status:res.status,body:await res.json()};
 };
 const session=(await ask("/api/chat/session")).body.session;
 const reply=await ask("/api/chat",{session,message:"Quero reembolso porque não recebi os arquivos do pedido"});
 assert.equal(reply.status,200);
 assert.doesNotMatch(reply.body.reply,/ZC-|SBX-/);
 const denied=await ask("/api/chat/handoff",{session,email:"comprador@dominio.com.br"});
 assert.equal(denied.status,400);
 assert.equal(count,0);
 const handoff=await ask("/api/chat/handoff",{session,email:"comprador@dominio.com.br",privacy_ack:true});
 assert.equal(handoff.status,200);
 assert.equal(handoff.body.protocol,"ZEV-20261105-ABCDEF1234");
 assert.equal(handoff.body.official,true);
 assert.equal(handoff.body.email_confirmation,"sent");
 assert.equal(count,1);
 assert.equal(sql.db.tickets.size,0,"official mode creates zero parallel ZC tickets");
 assert.equal(record.email,"comprador@dominio.com.br");
 assert.equal(record.tipo,"reembolso");
 assert.equal(mailer.sent.length,0,"no parallel chat emails; official durable outbox owns delivery");
});
test("R122 unavailable official protocol fails closed with actual form fallback",async()=>{
 resetSiteChatState();const sql=fakeSql();
 const deps={sqlFactory:()=>sql,salesOpen:async()=>false,mailer:sinkMailer(),registerOfficialAtendimento:async()=>({status:503,body:{error:"atendimento_indisponivel"}})};
 const env={...SANDBOX_ENV,ZEVANORY_PRIVATE_ARTIFACTS:fakeKv(),SITE_CHAT_OFFICIAL_PROTOCOLS:"true"};
 const req=async(p,b)=>{const r=await handleSiteChat(new Request("https://chat.internal"+p,{method:"POST",headers:{"content-type":"application/json","x-zev-client-ip":"203.0.113.5"},body:JSON.stringify(b)}),env,deps);return r;};
 const sid=(await (await req("/api/chat/session",{})).json()).session;
 const r=await req("/api/chat/handoff",{session:sid,email:"cliente@dominio.com.br",privacy_ack:true});
 assert.equal(r.status,503);const j=await r.json();assert.match(j.fallback.contact_form||j.fallback.message,/atendimento/);
});
