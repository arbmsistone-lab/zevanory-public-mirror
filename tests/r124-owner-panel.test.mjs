import test from "node:test";import assert from "node:assert/strict";
import {handleSiteChatAdmin,resetSiteChatState} from "../worker/site-chat.mjs";
const ticket={protocolo:"ZEV-20261105-ABCDEF1234",tipo:"suporte",recebido_em:"2026-11-05T12:00:00Z",responder_ate:"2026-11-10T12:00:00Z",owner_status:"sent",customer_status:"sent"};
const sql={query:async q=>q.startsWith("select o.protocolo,o.tipo,o.recebido_em")?[ticket]:[]};
const env={DATABASE_URL:"synthetic"};
test("R124 private owner panel rejects anonymous session before database access",async()=>{
 resetSiteChatState();let queried=0;
 const x=await handleSiteChatAdmin(new Request("https://zevanory.api.br/admin/chat-protocolos"),env,{sqlFactory:()=>{queried++;return sql},isAdminAuthorized:()=>false});
 assert.equal(x.status,401);assert.equal(queried,0);
});
test("R124 private owner HTML and JSON show same canonical ZEV outbox record",async()=>{
 resetSiteChatState();const deps={sqlFactory:()=>sql,isAdminAuthorized:()=>true};
 const res=await handleSiteChatAdmin(new Request("https://zevanory.api.br/admin/chat-protocolos"),env,deps);
 assert.equal(res.status,200);const html=await res.text();
 assert.match(html,/ZEV-20261105-ABCDEF1234/);assert.match(html,/Protocolos oficiais do chat/);
 assert.doesNotMatch(html,/SBX-|ZC-|@example/);
 const api=await handleSiteChatAdmin(new Request("https://zevanory.api.br/api/admin/site-chat/official"),env,deps);
 assert.equal(api.status,200);const body=await api.json();
 assert.equal(body.tickets[0].protocolo,"ZEV-20261105-ABCDEF1234");
 assert.equal(body.source,"zevanory_atendimento_outbox");
});
