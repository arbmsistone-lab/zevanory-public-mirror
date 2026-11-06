import test from "node:test";
import assert from "node:assert/strict";
import {injectInstitutionalChat} from "../worker/r120-chat-institutional.mjs";
const html="<!doctype html><html><head><title>ZEVANORY</title></head><body><main>Informação</main></body></html>";
const request=(url="https://zevanory.api.br/")=>new Request(url);
const response=()=>new Response(html,{status:200,headers:{"content-type":"text/html; charset=utf-8","content-security-policy":"default-src 'self'; script-src 'self'; frame-src 'none'; connect-src 'self'"}});
test("R121 default OFF leaves institutional response byte-for-byte unchanged",async()=>{
 const original=response();const result=await injectInstitutionalChat(request(),{},original);
 assert.equal(result,original);assert.equal(await result.text(),html);
});
test("R121 enabled injects only own CSS/JS on institutional HTML",async()=>{
 const out=await injectInstitutionalChat(request("https://zevanory.api.br/produtos"),{SITE_CHAT_ENABLED:"true"},response());
 assert.equal(out.status,200);const body=await out.text();
 assert.match(body,/src="\/site-chat.js"/);assert.match(body,/href="\/site-chat.css"/);
 assert.doesNotMatch(body,/pay\.hotmart|\/comprar/);
 assert.match(out.headers.get("content-security-policy"),/https:\/\/challenges\.cloudflare\.com/);
});
test("R121 isolated to HTML GET on exact institutional hostname, never API or sales",async()=>{
 for(const url of ["https://vendas.zevanory.api.br/","https://zevanory.api.br/api/chat/status","https://evil.example/"]){
  const out=await injectInstitutionalChat(request(url),{SITE_CHAT_ENABLED:"true"},response());
  assert.equal(await out.text(),html);
 }
});
test("R121 redirects and encoded responses remain untouched",async()=>{
 const redir=new Response(null,{status:302,headers:{location:"/atendimento"}});
 assert.equal(await injectInstitutionalChat(request(),{SITE_CHAT_ENABLED:"true"},redir),redir);
 const encoded=new Response("opaque",{headers:{"content-type":"text/html","content-encoding":"gzip"}});
 assert.equal(await injectInstitutionalChat(request(),{SITE_CHAT_ENABLED:"true"},encoded),encoded);
});
